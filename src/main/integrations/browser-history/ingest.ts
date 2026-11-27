/**
 * Browser history ingest (PRD F-TIME-04, F-TIME-06, F-TIME-13, F-TIME-14, F-TIME-17;
 * STACK §5.3).
 *
 * The browser's database cannot be opened read-only while the browser runs:
 * Chromium holds a rollback journal, and every non-immutable open fails with
 * "database is locked" (SP-1). So the strategy is:
 *
 *   1. no `-journal` file  -> open `immutable=1` and read in place (fast path)
 *   2. journal present     -> copy to a bounded temp snapshot, read, delete
 *
 * Ingestion is incremental (a per-profile watermark), idempotent (the unique key
 * is the browser's own visit identity), and never writes to the source.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Db } from "../../db/driver";
import { localDateKey } from "../../modules/time/aggregate";

/** Microseconds between 1601-01-01 and 1970-01-01. */
export const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** A 454 MB history file must not be copied on a whim (F-TIME-17). */
export const MAX_SNAPSHOT_BYTES = 800 * 1024 * 1024;
export const INGEST_BATCH = 500;

/**
 * First-run backfill window. A profile with no watermark starts here rather
 * than at the epoch: replaying years of history is slow and the analytics only
 * look back 90 days anyway. Older visits are skipped by the SQL, so the first
 * run is bounded and every later run is incremental.
 */
export const BACKFILL_DAYS = 90;

/** Rows read per page while catching up. */
const PAGE_ROWS = 5000;

/** How many pages one run may drain before yielding until the next tick. */
const MAX_PAGES_PER_RUN = 10;

export interface ProfileConfig {
  browser: string;
  profileDir: string;
  historyPath: string;
}

export type Strategy = "immutable" | "snapshot" | "unavailable";

export interface VisitRow {
  url: string;
  title: string | null;
  visitTimeUs: bigint;
  durationUs: bigint;
  transition: number;
}

/**
 * Chromium timestamps are microseconds since 1601 and exceed
 * Number.MAX_SAFE_INTEGER (observed 1.34e16), so they must stay bigint until
 * this conversion. Splitting before dividing keeps the millisecond exact.
 */
export function chromeTimeToMs(us: bigint): number {
  return Number(us / 1000n) - CHROME_EPOCH_OFFSET_MS;
}

export function msToChromeTime(ms: number): bigint {
  return BigInt(Math.round(ms) + CHROME_EPOCH_OFFSET_MS) * 1000n;
}

/** `https://www.youtube.com/watch?v=x` -> `youtube.com`. */
export function domainOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Chromium's transition mask: the low byte is the core type. */
export function isReload(transition: number): boolean {
  return (transition & 0xff) === 8;
}

export interface MediaRule {
  domain: string;
  /** Optional path prefix; `null` means the whole domain counts as media. */
  pathPrefix?: string | null;
}

/**
 * Sites whose time is watch time (F-TIME-06). Path prefixes keep
 * `youtube.com/feed` from counting as watching.
 */
export const MEDIA_RULES: MediaRule[] = [
  { domain: "youtube.com", pathPrefix: "/watch" },
  { domain: "youtube.com", pathPrefix: "/shorts" },
  { domain: "youtube.com", pathPrefix: "/live" },
  { domain: "m.youtube.com", pathPrefix: "/watch" },
  { domain: "netflix.com", pathPrefix: "/watch" },
  { domain: "twitch.tv" },
  { domain: "vimeo.com" },
  { domain: "primevideo.com" },
  { domain: "disneyplus.com" },
  { domain: "crunchyroll.com" },
  { domain: "nebula.tv" },
];

export function isMediaUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  for (const rule of MEDIA_RULES) {
    if (rule.domain !== host) continue;
    if (!rule.pathPrefix || u.pathname.startsWith(rule.pathPrefix)) return true;
  }
  return false;
}

/**
 * Default categories (F-TIME-07). Only these seed the `domain_rule` table; a
 * user edit always wins because seeding never overwrites an existing row.
 */
export const DEFAULT_RULES: Array<{ domain: string; category: string; distracting: boolean }> = [
  { domain: "youtube.com", category: "Entertainment", distracting: true },
  { domain: "netflix.com", category: "Entertainment", distracting: true },
  { domain: "twitch.tv", category: "Entertainment", distracting: true },
  { domain: "reddit.com", category: "Social", distracting: true },
  { domain: "x.com", category: "Social", distracting: true },
  { domain: "twitter.com", category: "Social", distracting: true },
  { domain: "instagram.com", category: "Social", distracting: true },
  { domain: "facebook.com", category: "Social", distracting: true },
  { domain: "tiktok.com", category: "Social", distracting: true },
  { domain: "github.com", category: "Work", distracting: false },
  { domain: "gitlab.com", category: "Work", distracting: false },
  { domain: "stackoverflow.com", category: "Work", distracting: false },
  { domain: "developer.mozilla.org", category: "Work", distracting: false },
  { domain: "docs.rs", category: "Work", distracting: false },
  { domain: "crates.io", category: "Work", distracting: false },
  { domain: "npmjs.com", category: "Work", distracting: false },
  { domain: "mail.google.com", category: "Communication", distracting: false },
  { domain: "chatgpt.com", category: "Work", distracting: false },
  { domain: "claude.ai", category: "Work", distracting: false },
  { domain: "wikipedia.org", category: "Reference", distracting: false },
  { domain: "openfront.io", category: "Entertainment", distracting: true },
];

/** Seed defaults without touching rows the user has already categorised. */
export function seedDefaultRules(db: Db, now = Date.now()): number {
  let inserted = 0;
  db.transaction(() => {
    for (const r of DEFAULT_RULES) {
      const res = db.run(
        `INSERT INTO domain_rule (domain, category, is_distracting, is_media, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(domain) DO NOTHING`,
        r.domain,
        r.category,
        r.distracting ? 1 : 0,
        isMediaUrl(`https://${r.domain}/`) ? 1 : 0,
        now,
      );
      inserted += res.changes;
    }
  });
  return inserted;
}

/** Decide how to read a profile's history right now. */
export function strategyFor(historyPath: string): Strategy {
  if (!existsSync(historyPath)) return "unavailable";
  // A zero-byte journal is left behind after a clean close and does not block
  // an immutable open (observed on this machine's Profile 2).
  const journal = `${historyPath}-journal`;
  if (!existsSync(journal)) return "immutable";
  try {
    if (statSync(journal).size === 0) return "immutable";
  } catch {
    return "snapshot";
  }
  return "snapshot";
}

export interface IngestResult {
  profileDir: string;
  strategy: Strategy;
  rowsRead: number;
  rowsNew: number;
  /** Rows skipped because the page had no measurable dwell time. */
  rowsSkipped: number;
  error: string | null;
}

interface IngestDeps {
  db: Db;
  snapshotDir: string;
  /** Cap on copied rows per run so a first ingest cannot run for minutes. */
  maxRows?: number;
}

export class BrowserHistoryIngest {
  #db: Db;
  #snapshotDir: string;
  #maxRows: number;

  constructor(deps: IngestDeps) {
    this.#db = deps.db;
    this.#snapshotDir = deps.snapshotDir;
    this.#maxRows = deps.maxRows ?? 5000;
  }

  /** Ensure a profile row exists and return its id. */
  profileId(profile: ProfileConfig): number {
    this.#db.run(
      `INSERT INTO browser_profile (browser, profile_dir, history_path)
       VALUES (?, ?, ?) ON CONFLICT(profile_dir) DO UPDATE SET history_path = excluded.history_path`,
      profile.browser,
      profile.profileDir,
      profile.historyPath,
    );
    const row = this.#db.get<{ id: number }>(
      "SELECT id FROM browser_profile WHERE profile_dir = ?",
      profile.profileDir,
    );
    if (!row) throw new Error("failed to register browser profile");
    return row.id;
  }

  /**
   * The timestamp to read from. A stored watermark wins; a fresh profile
   * starts at the backfill cutoff, never at the epoch.
   */
  watermark(profileId: number, now = Date.now()): bigint {
    const row = this.#db.get<{ watermark_us: string }>(
      "SELECT watermark_us FROM browser_profile WHERE id = ?",
      profileId,
    );
    const stored = BigInt(row?.watermark_us ?? "0");
    if (stored > 0n) return stored;
    return msToChromeTime(now - BACKFILL_DAYS * 86_400_000);
  }

  ingest(profile: ProfileConfig): IngestResult {
    const strategy = strategyFor(profile.historyPath);
    const profileId = this.profileId(profile);
    const result: IngestResult = {
      profileDir: profile.profileDir,
      strategy,
      rowsRead: 0,
      rowsNew: 0,
      rowsSkipped: 0,
      error: null,
    };
    if (strategy === "unavailable") {
      result.error = "history file not found";
      return result;
    }

    const runId = Number(
      this.#db.run(
        "INSERT INTO ingest_run (profile_id, started_at, strategy) VALUES (?, ?, ?)",
        profileId,
        Date.now(),
        strategy,
      ).lastInsertRowid,
    );

    let snapshot: string | null = null;
    let source: Db | null = null;
    try {
      let readPath = profile.historyPath;
      if (strategy === "snapshot") {
        const size = statSync(profile.historyPath).size;
        if (size > MAX_SNAPSHOT_BYTES)
          throw new Error(`history file is ${size} bytes; over the snapshot ceiling`);
        snapshot = this.#snapshot(profile);
        readPath = snapshot;
      }

      // Routed through the driver rather than constructing `DatabaseSync` here.
      // `driver.ts` states it is "the ONLY module allowed to import node:sqlite"
      // and STACK §4.1 sells that isolation as the mitigation for node:sqlite
      // being Stability 1.2; importing it here made a swap to better-sqlite3
      // touch a second file. The driver's `immutable` option existed for exactly
      // this case and had no caller.
      //
      // `immutable` is the fast path only: a snapshot is a private copy, so it is
      // opened read-only but not immutable — SQLite must be free to read its
      // journal, which an immutable open ignores by definition.
      source = Db.open(readPath, { readonly: true, immutable: strategy !== "snapshot" });

      // Drain pages until the profile is caught up, so a first run does not
      // leave most of the backfill unread. Each page advances the watermark
      // after its own commit, so an interruption resumes where it stopped.
      let watermark = this.watermark(profileId);
      for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
        const rows = this.#read(source, watermark);
        result.rowsRead += rows.length;
        if (rows.length === 0) break;

        const { inserted, skipped, maxSeen } = this.#write(profileId, rows, runId);
        result.rowsNew += inserted;
        result.rowsSkipped += skipped;

        // The watermark advances only after the transaction committed, so a
        // crash mid-ingest re-reads the same window instead of losing it
        // (F-TIME-13).
        if (maxSeen !== null && maxSeen > watermark) {
          watermark = maxSeen;
          this.#db.run(
            "UPDATE browser_profile SET watermark_us = ?, last_ingest_at = ? WHERE id = ?",
            watermark.toString(),
            Date.now(),
            profileId,
          );
        }
        if (rows.length < PAGE_ROWS) break;
      }
      this.#db.run("UPDATE browser_profile SET last_ingest_at = ? WHERE id = ?", Date.now(), profileId);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      try {
        source?.close();
      } catch {
        /* already closed */
      }
      if (snapshot) {
        rmSync(snapshot, { force: true });
        rmSync(`${snapshot}-journal`, { force: true });
        rmSync(`${snapshot}-wal`, { force: true });
        rmSync(`${snapshot}-shm`, { force: true });
      }
      this.#db.run(
        "UPDATE ingest_run SET finished_at = ?, rows_read = ?, rows_new = ?, error = ? WHERE id = ?",
        Date.now(),
        result.rowsRead,
        result.rowsNew,
        result.error,
        runId,
      );
    }
    return result;
  }

  /** Ingest every configured profile; one failure never stops the others. */
  ingestAll(profiles: ProfileConfig[]): IngestResult[] {
    return profiles.map((p) => this.ingest(p));
  }

  // ── internals ─────────────────────────────────────────────────────────

  #snapshot(profile: ProfileConfig): string {
    mkdirSync(this.#snapshotDir, { recursive: true });
    // A stable per-profile name keeps repeated runs from piling up files.
    const key = createHash("sha1").update(profile.historyPath).digest("hex").slice(0, 10);
    const dest = join(this.#snapshotDir, `hist-${key}.sqlite`);
    rmSync(dest, { force: true });
    copyFileSync(profile.historyPath, dest);
    // Deliberately NOT copying the rollback journal. A journal copy forces
    // SQLite to replay it, which is a write, and the snapshot is opened
    // read-only: measured `attempt to write a readonly database`. Without the
    // journal the copy is exactly the last committed state, which is what a
    // reader wants. The trade-off is a torn B-tree if the browser is mid-write
    // at this instant; the size guard plus the hourly cadence keeps that rare,
    // and a failed read is reported rather than silently producing bad rows.
    return dest;
  }

  #read(source: Db, watermark: bigint): VisitRow[] {
    // `allBigInt`: visit_time is larger than Number.MAX_SAFE_INTEGER (SP-1), so
    // it must be read as a bigint or the low bits are lost.
    const rows = source.allBigInt<{
      url: string;
      title: string | null;
      visit_time: bigint;
      visit_duration: bigint | null;
      transition: bigint | number | null;
    }>(
      `SELECT u.url AS url, u.title AS title, v.visit_time AS visit_time,
              v.visit_duration AS visit_duration, v.transition AS transition
         FROM visits v JOIN urls u ON u.id = v.url
        WHERE v.visit_time > ?
        ORDER BY v.visit_time
        LIMIT ?`,
      watermark,
      Math.min(this.#maxRows, PAGE_ROWS),
    );
    return rows.map((r) => ({
      url: r.url,
      title: r.title,
      visitTimeUs: BigInt(r.visit_time),
      durationUs: BigInt(r.visit_duration ?? 0),
      transition: Number(r.transition ?? 0),
    }));
  }

  #write(
    profileId: number,
    rows: VisitRow[],
    runId: number,
  ): { inserted: number; skipped: number; maxSeen: bigint | null } {
    let inserted = 0;
    let skipped = 0;
    let maxSeen: bigint | null = null;

    for (let i = 0; i < rows.length; i += INGEST_BATCH) {
      const batch = rows.slice(i, i + INGEST_BATCH);
      // Explicit transaction: node:sqlite has no db.transaction() (SP-1).
      this.#db.transaction(() => {
        for (const r of batch) {
          const domain = domainOf(r.url);
          // Non-http(s) rows (chrome://, file://) carry no web time.
          if (!domain) {
            skipped++;
            continue;
          }
          // A reload restarts the dwell clock on the same URL, so its
          // visit_duration is only the last fragment. Counting it would double
          // count time already recorded by the earlier visit.
          if (isReload(r.transition) && r.durationUs > 0n) {
            skipped++;
            continue;
          }
          const visitAt = chromeTimeToMs(r.visitTimeUs);
          const localDate = localDateKey(new Date(visitAt));
          const res = this.#db.run(
            `INSERT INTO browser_visit
               (profile_id, url, title, domain, visit_time_us, visit_at, local_date,
                duration_us, transition, source, ingest_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'history', ?)
             ON CONFLICT(profile_id, url, visit_time_us) DO NOTHING`,
            profileId,
            r.url,
            r.title,
            domain,
            r.visitTimeUs.toString(),
            visitAt,
            localDate,
            r.durationUs.toString(),
            r.transition,
            runId,
          );
          if (res.changes > 0) inserted++;
        }
      });
      // Track the highest timestamp actually read, not just the batch's last
      // row: skipped rows (reloads, non-web) must still advance the watermark
      // or they are re-read on every run.
      for (const r of batch) {
        if (maxSeen === null || r.visitTimeUs > maxSeen) maxSeen = r.visitTimeUs;
      }
    }

    return { inserted, skipped, maxSeen };
  }
}

/** Remove snapshots left behind by a crash. Called once at startup. */
export function cleanupSnapshots(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      // Snapshot files and their sidecars (journal/wal/shm) share the prefix.
      if (f.startsWith("hist-") && /\.(sqlite|sqlite-journal|sqlite-wal|sqlite-shm)$/.test(f)) {
        unlinkSync(join(dir, f));
        n++;
      }
    }
  } catch {
    /* unreadable directory: nothing to clean */
  }
  return n;
}
