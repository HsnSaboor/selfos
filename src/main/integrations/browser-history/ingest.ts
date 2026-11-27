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
import { localDateKey } from "../../../shared/dates";
import { Db } from "../../db/driver";
import { DEFAULT_RULES, MEDIA_RULES } from "./catalog";

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

export type Strategy = "snapshot" | "unavailable";

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

export { DEFAULT_RULES, MEDIA_RULES, type MediaRule } from "./catalog";

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
  // Always read a private copy. The old immutable fast path (no journal at the
  // check) could race a writer that began immediately after the check and read
  // a torn B-tree; a copy is the only consistently readable snapshot, and the
  // 800 MB ceiling plus the four-hour cadence bounds the cost (round-12 Blocker).
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
}

export class BrowserHistoryIngest {
  #db: Db;
  #snapshotDir: string;

  constructor(deps: IngestDeps) {
    this.#db = deps.db;
    this.#snapshotDir = deps.snapshotDir;
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
      // The snapshot is opened read-write so SQLite can recover a copied hot
      // journal; an immutable or read-only open would ignore it and could read
      // a torn B-tree.
      source = Db.open(readPath);

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
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${dest}${suffix}`, { force: true });
    copyFileSync(profile.historyPath, dest);
    // Copy the sidecars too: a hot journal holds committed pages the main file
    // does not have yet. The copy is opened read-write so SQLite can replay it;
    // without the journal the copy can be missing the newest visits (round-12).
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const side = `${profile.historyPath}${suffix}`;
      if (existsSync(side)) copyFileSync(side, `${dest}${suffix}`);
    }
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
      PAGE_ROWS,
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
          // A reload restarts the dwell clock on the same URL, but Chromium
          // gives the reload its own interval and updates the previous visit's
          // duration. Keeping both, with the duration refreshed on conflict,
          // records the post-reload dwell instead of discarding it (round-12).
          const visitAt = chromeTimeToMs(r.visitTimeUs);
          const localDate = localDateKey(new Date(visitAt));
          const res = this.#db.run(
            `INSERT INTO browser_visit
               (profile_id, url, title, domain, visit_time_us, visit_at, local_date,
                duration_us, transition, source, ingest_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'history', ?)
             ON CONFLICT(profile_id, url, visit_time_us) DO UPDATE SET
               duration_us = MAX(duration_us, excluded.duration_us),
               title = excluded.title`,
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
