import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/driver";
import { migrate } from "../src/main/db/migrate";
import {
  BrowserHistoryIngest,
  CHROME_EPOCH_OFFSET_MS,
  chromeTimeToMs,
  domainOf,
  isMediaUrl,
  MEDIA_RULES,
  msToChromeTime,
  seedDefaultRules,
  strategyFor,
} from "../src/main/integrations/browser-history/ingest";
import { guessSite, isBrowserClass, pageTitle } from "../src/main/integrations/browser-history/title";
import {
  categoryUsage,
  pagesForDomain,
  setDomainRule,
  siteTotals,
  siteUsage,
  uncategorizedDomains,
  unionSeconds,
  watchTime,
} from "../src/main/modules/time/sites";
import { freshDb } from "./helpers/db";
import { tempDir } from "./helpers/temp";

function freshDb(): Db {
  const dir = tempDir("selfos-sites-");
  const db = Db.open(join(dir, "test.sqlite"));
  migrate(db);
  return db;
}

/** A minimal Chromium-shaped history database, in the browser's own format. */
function fakeHistory(
  visits: Array<{ url: string; title: string; atMs: number; durationUs?: bigint; transition?: number }>,
): string {
  const dir = tempDir("selfos-hist-");
  const path = join(dir, "History");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT);
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL,
      transition INTEGER DEFAULT 0, visit_duration INTEGER DEFAULT 0
    );
  `);
  const insertUrl = db.prepare("INSERT INTO urls (id, url, title) VALUES (?, ?, ?)");
  const insertVisit = db.prepare(
    "INSERT INTO visits (url, visit_time, transition, visit_duration) VALUES (?, ?, ?, ?)",
  );
  visits.forEach((v, i) => {
    insertUrl.run(i + 1, v.url, v.title);
    insertVisit.run(
      BigInt(i + 1),
      BigInt(Math.round(v.atMs + CHROME_EPOCH_OFFSET_MS) * 1000),
      BigInt(v.transition ?? 0),
      v.durationUs ?? 0n,
    );
  });
  db.close();
  return path;
}

const T0 = new Date(2026, 10, 2, 10, 0, 0).getTime();

describe("chrome timestamps", () => {
  it("converts a real-world value above MAX_SAFE_INTEGER exactly to the millisecond", () => {
    const us = 13_438_080_842_554_189n; // observed on this machine
    const ms = chromeTimeToMs(us);
    expect(Number.isSafeInteger(ms)).toBe(true);
    // Milliseconds are the storage resolution, so sub-millisecond digits are
    // dropped by design. The raw microsecond string is what makes the visit
    // key unique, not this conversion.
    expect(msToChromeTime(ms)).toBe(us - (us % 1000n));
  });

  it("does not lose the millisecond to float rounding", () => {
    // Read as a plain Number, this value rounds and two visits in the same
    // millisecond collide. As bigint the millisecond is exact.
    const a = 13_438_080_842_554_189n;
    const b = a + 1n;
    expect(chromeTimeToMs(a)).toBe(chromeTimeToMs(b));
    expect(chromeTimeToMs(a + 1000n) - chromeTimeToMs(a)).toBe(1);
  });

  it("keeps millisecond precision (does not go through a float)", () => {
    const ms = Date.UTC(2026, 10, 2, 10, 0, 0, 123);
    expect(chromeTimeToMs(msToChromeTime(ms))).toBe(ms);
  });

  it("converts a known epoch", () => {
    expect(chromeTimeToMs(0n)).toBe(-CHROME_EPOCH_OFFSET_MS);
  });
});

describe("domainOf", () => {
  it("strips www and lowercases", () => {
    expect(domainOf("https://WWW.YouTube.com/watch?v=1")).toBe("youtube.com");
  });

  it("rejects non-web schemes", () => {
    expect(domainOf("chrome://settings")).toBeNull();
    expect(domainOf("file:///etc/passwd")).toBeNull();
    expect(domainOf("not a url")).toBeNull();
  });
});

describe("isMediaUrl", () => {
  it("matches watch paths only", () => {
    expect(isMediaUrl("https://youtube.com/watch?v=abc")).toBe(true);
    expect(isMediaUrl("https://youtube.com/shorts/xyz")).toBe(true);
    expect(isMediaUrl("https://youtube.com/feed/subscriptions")).toBe(false);
  });

  it("matches whole-domain media sites", () => {
    expect(isMediaUrl("https://twitch.tv/someone")).toBe(true);
  });

  it("does not match lookalikes", () => {
    expect(isMediaUrl("https://notyoutube.com/watch?v=1")).toBe(false);
    expect(isMediaUrl("https://youtube.com.evil.example/watch")).toBe(false);
  });
});

describe("strategyFor", () => {
  it("is unavailable when the file is missing", () => {
    expect(strategyFor("/nope/History")).toBe("unavailable");
  });

  it("always uses a private snapshot copy", () => {
    const dir = tempDir("selfos-strategy-");
    writeFileSync(join(dir, "History"), "x");
    expect(strategyFor(join(dir, "History"))).toBe("snapshot");
  });

  it("uses a snapshot for a zero-byte journal left by a clean close", () => {
    const dir = tempDir("selfos-strategy-");
    writeFileSync(join(dir, "History"), "x");
    writeFileSync(join(dir, "History-journal"), "");
    expect(strategyFor(join(dir, "History"))).toBe("snapshot");
  });

  it("uses a snapshot for a live journal", () => {
    const dir = tempDir("selfos-strategy-");
    writeFileSync(join(dir, "History"), "x");
    writeFileSync(join(dir, "History-journal"), "live");
    expect(strategyFor(join(dir, "History"))).toBe("snapshot");
  });
});

describe("guessSite", () => {
  it("reads the site from the title suffix", () => {
    expect(guessSite("Some video - YouTube")?.site).toBe("youtube.com");
    expect(guessSite("Issue #12 - GitHub")?.site).toBe("github.com");
    expect(guessSite("OpenFront (ALPHA) - Helium")?.site).toBe("openfront.io");
  });

  it("prefers the longer site name", () => {
    expect(guessSite("Document - Google Docs")?.site).toBe("docs.google.com");
    expect(guessSite("Search - Google")?.site).toBe("google.com");
  });

  it("handles the pipe separator", () => {
    expect(guessSite("Design file | Figma")?.site).toBe("figma.com");
  });

  it("accepts a bare hostname at the start", () => {
    expect(guessSite("example.org — something")?.basis).toBe("hostname");
  });

  it("returns null for unknown pages instead of inventing a domain", () => {
    expect(guessSite("Some random app")).toBeNull();
    expect(guessSite("")).toBeNull();
    expect(guessSite(null)).toBeNull();
  });
});

describe("pageTitle", () => {
  it("drops the trailing site name", () => {
    expect(pageTitle("Some video - YouTube")).toBe("Some video");
  });

  it("keeps a title without a separator", () => {
    expect(pageTitle("Just a title")).toBe("Just a title");
  });
});

describe("isBrowserClass", () => {
  it("recognises the browsers on this machine", () => {
    expect(isBrowserClass("helium")).toBe(true);
    expect(isBrowserClass("Helium")).toBe(true);
    expect(isBrowserClass("kitty")).toBe(false);
  });
});

describe("BrowserHistoryIngest", () => {
  let db: Db;
  let snapDir: string;
  let ingest: BrowserHistoryIngest;

  beforeEach(() => {
    db = freshDb();
    snapDir = join(tempDir("selfos-snap-"), "snaps");
    mkdirSync(snapDir, { recursive: true });
    ingest = new BrowserHistoryIngest({ db, snapshotDir: snapDir });
  });

  it("ingests visits with the right local date and duration", () => {
    const path = fakeHistory([
      {
        url: "https://www.youtube.com/watch?v=a",
        title: "Video A - YouTube",
        atMs: T0,
        durationUs: 120_000_000n,
      },
      {
        url: "https://github.com/org/repo",
        title: "repo - GitHub",
        atMs: T0 + 60_000,
        durationUs: 30_000_000n,
      },
    ]);
    const res = ingest.ingest({ browser: "helium", profileDir: "Default", historyPath: path });
    expect(res.error).toBeNull();
    expect(res.rowsNew).toBe(2);
    expect(res.strategy).toBe("snapshot");

    const rows = db.all<{ domain: string; local_date: string; duration_us: string }>(
      "SELECT domain, local_date, duration_us FROM browser_visit ORDER BY visit_at",
    );
    expect(rows.map((r) => r.domain)).toEqual(["youtube.com", "github.com"]);
    expect(rows[0]?.local_date).toBe("2026-11-02");
    expect(Number(rows[0]?.duration_us)).toBe(120_000_000);
  });

  it("is idempotent: a second run inserts nothing", () => {
    const path = fakeHistory([{ url: "https://a.com/", title: "A", atMs: T0, durationUs: 1_000_000n }]);
    const cfg = { browser: "helium", profileDir: "Default", historyPath: path };
    expect(ingest.ingest(cfg).rowsNew).toBe(1);
    const second = ingest.ingest(cfg);
    expect(second.rowsNew).toBe(0);
    expect(second.rowsRead).toBe(0); // the watermark already covers it
  });

  it("starts a fresh profile at the backfill cutoff, not the epoch", () => {
    const now = T0;
    const old = fakeHistory([{ url: "https://ancient.com/", title: "Old", atMs: now - 400 * 86_400_000 }]);
    const recent = fakeHistory([{ url: "https://recent.com/", title: "New", atMs: now - 2 * 86_400_000 }]);
    const a = ingest.ingest({ browser: "helium", profileDir: "Ancient", historyPath: old });
    const b = ingest.ingest({ browser: "helium", profileDir: "Recent", historyPath: recent });
    // The ancient visit is outside the 90-day window and is never read.
    expect(a.rowsNew).toBe(0);
    expect(b.rowsNew).toBe(1);
  });

  // 12 000 rows is a deliberately large fixture; give it room beyond the 5 s
  // default so the test measures correctness, not machine speed.
  it("drains more than one page in a single run", { timeout: 30_000 }, () => {
    // 12 000 visits is more than two pages of 5 000; one run must catch up
    // rather than leaving most of the backfill for later ticks.
    const many = Array.from({ length: 12_000 }, (_, i) => ({
      url: `https://site${i % 5}.com/p${i}`,
      title: `P${i}`,
      atMs: T0 - 60 * 86_400_000 + i * 100,
    }));
    const path = fakeHistory(many);
    const res = ingest.ingest({ browser: "helium", profileDir: "Big", historyPath: path });
    expect(res.rowsNew).toBe(12_000);
  });

  it("advances the watermark across many batches, not just the last row", () => {
    // Regression: the watermark used to be taken from each batch's last row,
    // so with >INGEST_BATCH rows an earlier batch could lower it and every run
    // re-read the whole history.
    const many = Array.from({ length: 1200 }, (_, i) => ({
      url: `https://site${i % 7}.com/page${i}`,
      title: `Page ${i}`,
      atMs: T0 + i * 1000,
      durationUs: 1_000_000n,
    }));
    const path = fakeHistory(many);
    const cfg = { browser: "helium", profileDir: "Default", historyPath: path };
    const first = ingest.ingest(cfg);
    expect(first.rowsNew).toBe(1200);
    const second = ingest.ingest(cfg);
    expect(second.rowsRead).toBe(0);
    expect(second.rowsNew).toBe(0);
  });

  it("advances the watermark even when rows are skipped", () => {
    // A non-web row is skipped, but its timestamp must still move the watermark
    // or it is re-read forever.
    const path = fakeHistory([
      { url: "https://a.com/", title: "A", atMs: T0, durationUs: 1_000_000n },
      { url: "https://b.com/", title: "B", atMs: T0 + 5000, durationUs: 2_000_000n, transition: 8 },
    ]);
    const cfg = { browser: "helium", profileDir: "Default", historyPath: path };
    ingest.ingest(cfg);
    expect(ingest.ingest(cfg).rowsRead).toBe(0);
  });

  it("advances the watermark so new visits are incremental", () => {
    const path = fakeHistory([{ url: "https://a.com/", title: "A", atMs: T0, durationUs: 1_000_000n }]);
    const cfg = { browser: "helium", profileDir: "Default", historyPath: path };
    ingest.ingest(cfg);
    // Append a later visit to the same database.
    const src = new DatabaseSync(path);
    src.prepare("INSERT INTO urls (id, url, title) VALUES (2, ?, ?)").run("https://b.com/", "B");
    src
      .prepare("INSERT INTO visits (url, visit_time, transition, visit_duration) VALUES (2, ?, 0, ?)")
      .run(BigInt(Math.round(T0 + 120_000 + CHROME_EPOCH_OFFSET_MS) * 1000), 2_000_000n);
    src.close();

    const res = ingest.ingest(cfg);
    expect(res.rowsRead).toBe(1);
    expect(res.rowsNew).toBe(1);
  });

  it("skips non-web URLs and keeps reloads", () => {
    const path = fakeHistory([
      { url: "chrome://settings", title: "Settings", atMs: T0, durationUs: 5_000_000n },
      { url: "https://reloaded.com/", title: "R", atMs: T0 + 1000, durationUs: 9_000_000n, transition: 8 },
      { url: "https://real.com/", title: "Real", atMs: T0 + 2000, durationUs: 4_000_000n },
    ]);
    const res = ingest.ingest({ browser: "helium", profileDir: "Default", historyPath: path });
    expect(res.rowsNew).toBe(2);
    expect(res.rowsSkipped).toBe(1);
  });

  it("keeps zero-duration visits (they still record a visit)", () => {
    const path = fakeHistory([{ url: "https://zero.com/", title: "Z", atMs: T0 }]);
    expect(ingest.ingest({ browser: "helium", profileDir: "Default", historyPath: path }).rowsNew).toBe(1);
  });

  it("records an ingest run with its strategy", () => {
    const path = fakeHistory([{ url: "https://a.com/", title: "A", atMs: T0 }]);
    ingest.ingest({ browser: "helium", profileDir: "Default", historyPath: path });
    const run = db.get<{ strategy: string; finished_at: number | null }>("SELECT * FROM ingest_run");
    expect(run?.strategy).toBe("snapshot");
    expect(run?.finished_at).not.toBeNull();
  });

  it("snapshots when a live journal exists and deletes the copy", () => {
    const path = fakeHistory([{ url: "https://a.com/", title: "A", atMs: T0, durationUs: 1_000_000n }]);
    writeFileSync(`${path}-journal`, "live");
    const res = ingest.ingest({ browser: "helium", profileDir: "Default", historyPath: path });
    expect(res.strategy).toBe("snapshot");
    expect(res.error).toBeNull();
    expect(res.rowsNew).toBe(1);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(snapDir).filter((f) => f.endsWith(".sqlite"))).toEqual([]);
  });

  it("reports a missing history file without throwing", () => {
    const res = ingest.ingest({ browser: "helium", profileDir: "Ghost", historyPath: "/nope/History" });
    expect(res.error).toMatch(/not found/);
    expect(res.rowsNew).toBe(0);
  });

  it("keeps profiles separate", () => {
    const a = fakeHistory([{ url: "https://a.com/", title: "A", atMs: T0 }]);
    const b = fakeHistory([{ url: "https://b.com/", title: "B", atMs: T0 }]);
    ingest.ingestAll([
      { browser: "helium", profileDir: "Default", historyPath: a },
      { browser: "helium", profileDir: "Profile 2", historyPath: b },
    ]);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM browser_profile")?.n).toBe(2);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM browser_visit")?.n).toBe(2);
  });
});

describe("unionSeconds", () => {
  it("counts overlapping intervals once", () => {
    // Two tabs on the same site, both open for an hour and overlapping.
    expect(
      unionSeconds([
        { start: 0, end: 3_600_000 },
        { start: 1_800_000, end: 5_400_000 },
      ]),
    ).toBe(5400);
  });

  it("sums disjoint intervals", () => {
    expect(
      unionSeconds([
        { start: 0, end: 1_000_000 },
        { start: 2_000_000, end: 3_000_000 },
      ]),
    ).toBe(2000);
  });

  it("ignores empty and inverted intervals", () => {
    expect(
      unionSeconds([
        { start: 5, end: 5 },
        { start: 10, end: 3 },
      ]),
    ).toBe(0);
    expect(unionSeconds([])).toBe(0);
  });

  it("handles a fully contained interval", () => {
    expect(
      unionSeconds([
        { start: 0, end: 10_000 },
        { start: 2_000, end: 4_000 },
      ]),
    ).toBe(10);
  });

  it("handles unsorted input", () => {
    expect(
      unionSeconds([
        { start: 5_000, end: 6_000 },
        { start: 0, end: 2_000 },
      ]),
    ).toBe(3);
  });
});

describe("siteUsage", () => {
  let db: Db;
  let pid: number;

  beforeEach(() => {
    db = freshDb();
    seedDefaultRules(db);
    pid = Number(
      db.run(
        "INSERT INTO browser_profile (browser, profile_dir, history_path) VALUES ('helium', 'Default', '/h')",
      ).lastInsertRowid,
    );
  });

  const addVisit = (domain: string, seconds: number, source = "history", at = T0, url?: string) => {
    db.run(
      `INSERT INTO browser_visit (profile_id, url, title, domain, visit_time_us, visit_at, local_date,
                                  duration_us, transition, source)
       VALUES (?, ?, ?, ?, ?, ?, '2026-11-02', ?, 0, ?)`,
      pid,
      url ?? `https://${domain}/${Math.random()}`,
      null,
      domain,
      String(at * 1000),
      at,
      String(seconds * 1_000_000),
      source,
    );
  };

  it("sums disjoint visits per domain and applies category rules", () => {
    // Distinct timestamps so the visits do not overlap.
    addVisit("youtube.com", 120, "history", T0);
    addVisit("youtube.com", 60, "history", T0 + 10 * 60_000);
    addVisit("github.com", 300, "history", T0 + 20 * 60_000);
    const sites = siteUsage(db, "2026-11-02");
    const yt = sites.find((s) => s.domain === "youtube.com");
    expect(yt?.seconds).toBe(180);
    expect(yt?.category).toBe("Entertainment");
    expect(yt?.distracting).toBe(true);
    expect(sites[0]?.domain).toBe("github.com");
    expect(sites[0]?.category).toBe("Work");
  });

  it("marks unknown domains Uncategorized", () => {
    addVisit("mystery.example", 30);
    expect(siteUsage(db, "2026-11-02")[0]?.category).toBe("Uncategorized");
  });

  it("matches rules on parent domains", () => {
    addVisit("music.youtube.com", 45);
    expect(siteUsage(db, "2026-11-02")[0]?.category).toBe("Entertainment");
  });

  it("reconciles history and window-title time without double counting", () => {
    // History saw 100 s; the title fallback saw 140 s of focus on the same site.
    addVisit("youtube.com", 100, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("youtube.com", 140, "window-title", T0 + 1_000_000, "https://youtube.com/");
    const site = siteUsage(db, "2026-11-02").find((s) => s.domain === "youtube.com");
    expect(site?.source).toBe("mixed");
    expect(site?.historySeconds).toBe(100);
    expect(site?.titleSeconds).toBe(140);
    // The union of the two interval sets: disjoint here, so 100 + 140.
    expect(site?.seconds).toBe(240);
  });

  it("reports window-title-only sites", () => {
    addVisit("openfront.io", 75, "window-title");
    const site = siteUsage(db, "2026-11-02")[0];
    expect(site?.source).toBe("window-title");
    expect(site?.seconds).toBe(75);
  });

  it("does not exceed the day when tabs overlap", () => {
    // Two YouTube tabs open at once for an hour each. The naive sum would be
    // 2 h; the real time is 1 h.
    addVisit("youtube.com", 3600, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("youtube.com", 3600, "history", T0 + 60_000, "https://youtube.com/watch?v=b");
    const site = siteUsage(db, "2026-11-02").find((s) => s.domain === "youtube.com");
    expect(site?.seconds).toBe(3660);
  });

  it("is empty for a day with no visits", () => {
    expect(siteUsage(db, "2026-11-01")).toEqual([]);
  });

  it("computes category shares over browser-open time", () => {
    // Disjoint visits: youtube 300 s, then github 100 s.
    addVisit("youtube.com", 300, "history", T0);
    addVisit("github.com", 100, "history", T0 + 400_000);
    const totals = siteTotals(db, "2026-11-02");
    expect(totals.webSeconds).toBe(400);
    const cats = categoryUsage(db, "2026-11-02", siteUsage(db, "2026-11-02"), totals.webSeconds);
    expect(cats[0]?.category).toBe("Entertainment");
    expect(cats[0]?.share).toBeCloseTo(0.75);
    expect(cats[1]?.category).toBe("Work");
  });

  it("never reports a category larger than browser-open time", () => {
    // Regression: category seconds used to be a sum of per-domain unions, so
    // two Entertainment domains open at once produced 121% of the day.
    addVisit("youtube.com", 3600, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("openfront.io", 3600, "history", T0 + 60_000, "https://openfront.io/");
    const totals = siteTotals(db, "2026-11-02");
    const cats = categoryUsage(db, "2026-11-02", siteUsage(db, "2026-11-02"), totals.webSeconds);
    const ent = cats.find((c) => c.category === "Entertainment");
    expect(ent?.seconds).toBe(totals.webSeconds);
    expect(ent?.share).toBeLessThanOrEqual(1);
  });

  it("does not let overlapping tabs inflate the day total", () => {
    // Three domains, all open during the same hour: the browser was open for
    // one hour, not three.
    addVisit("youtube.com", 3600, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("github.com", 3600, "history", T0 + 60_000, "https://github.com/a");
    addVisit("instagram.com", 3600, "history", T0 + 120_000, "https://instagram.com/a");
    const totals = siteTotals(db, "2026-11-02");
    expect(totals.webSeconds).toBe(3720);
    // But each site still reports its own time.
    expect(siteUsage(db, "2026-11-02")).toHaveLength(3);
  });

  it("separates distracting and media totals", () => {
    addVisit("youtube.com", 600, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("github.com", 600, "history", T0 + 700_000);
    const totals = siteTotals(db, "2026-11-02");
    expect(totals.distractingSeconds).toBe(600);
    expect(totals.mediaSeconds).toBe(600);
    expect(totals.webSeconds).toBe(1200);
  });

  it("reports watch time for media URLs only", () => {
    // `addVisit` builds `https://<domain>/`, which is the YouTube home page —
    // browsing, not watching. Media requires a watch/shorts/live path.
    addVisit("youtube.com", 200, "history", T0, "https://youtube.com/watch?v=a");
    addVisit("github.com", 50);
    const w = watchTime(db, "2026-11-02");
    expect(w.seconds).toBe(200);
    expect(w.bySite.map((s) => s.domain)).toEqual(["youtube.com"]);
  });

  it("does not count a media site's feed page as watch time", () => {
    addVisit("youtube.com", 600, "history", T0, "https://youtube.com/feed/subscriptions");
    addVisit("youtube.com", 300, "history", T0 + 700_000, "https://youtube.com/watch?v=a");
    // Only the watch page counts, and it does not overlap the feed visit.
    expect(watchTime(db, "2026-11-02").seconds).toBe(300);
    expect(siteTotals(db, "2026-11-02").mediaSeconds).toBe(300);
  });

  it("lists pages for a domain, longest first", () => {
    addVisit("github.com", 10, "history", T0, "https://github.com/a");
    addVisit("github.com", 90, "history", T0 + 1000, "https://github.com/b");
    const pages = pagesForDomain(db, "github.com", "2026-11-02");
    expect(pages[0]?.url).toBe("https://github.com/b");
    expect(pages[0]?.seconds).toBe(90);
  });

  it("counts a page revisited twice once, over its union", () => {
    addVisit("github.com", 60, "history", T0, "https://github.com/a");
    addVisit("github.com", 60, "history", T0 + 30_000, "https://github.com/a");
    const pages = pagesForDomain(db, "github.com", "2026-11-02");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.seconds).toBe(90);
    expect(pages[0]?.visits).toBe(2);
  });

  it("lists uncategorized domains by time", () => {
    addVisit("mystery.example", 40);
    addVisit("another.example", 10);
    const list = uncategorizedDomains(db);
    expect(list.map((d) => d.domain)).toEqual(["mystery.example", "another.example"]);
  });

  it("lets the user reclassify a default rule", () => {
    setDomainRule(db, "youtube.com", "Learning", { distracting: false, media: true });
    addVisit("youtube.com", 60);
    const site = siteUsage(db, "2026-11-02")[0];
    expect(site?.category).toBe("Learning");
    expect(site?.distracting).toBe(false);
  });

  it("preserves distracting/media flags when only the category changes", () => {
    // Regression: the Sites screen sends only { domain, category }. Treating the
    // omitted flags as false silently turned off the distraction marking and the
    // watch-time classification of every site the user recategorised.
    setDomainRule(db, "youtube.com", "Entertainment", { distracting: true, media: true });
    setDomainRule(db, "youtube.com", "Learning");
    addVisit("youtube.com", 60);
    const site = siteUsage(db, "2026-11-02")[0];
    expect(site?.category).toBe("Learning");
    expect(site?.distracting).toBe(true);
    const rule = db.get<{ is_media: number }>(
      "SELECT is_media FROM domain_rule WHERE domain = 'youtube.com'",
    );
    expect(rule?.is_media).toBe(1);
  });

  it("normalises a domain before storing a rule", () => {
    setDomainRule(db, "WWW.Example.COM", "Work");
    expect(
      db.get<{ domain: string }>("SELECT domain FROM domain_rule WHERE domain = 'example.com'"),
    ).toBeTruthy();
  });

  it("rejects an empty category", () => {
    expect(() => setDomainRule(db, "a.com", "  ")).toThrow(/category/);
  });

  it("never overwrites a user rule when seeding defaults again", () => {
    setDomainRule(db, "youtube.com", "Learning");
    seedDefaultRules(db);
    expect(
      db.get<{ category: string }>("SELECT category FROM domain_rule WHERE domain = 'youtube.com'")?.category,
    ).toBe("Learning");
  });
});

describe("media classification is derived, not duplicated", () => {
  it("treats exactly the domains named by MEDIA_RULES as media sites", () => {
    // `sites.ts` used to keep its own `MEDIA_DOMAINS` list, which drifted from
    // `MEDIA_RULES` in the ingester. Deriving it means a new streaming service
    // added in one place is classified in both — and this pins that the two
    // cannot silently diverge again.
    //
    // The clue is the YouTube case: every YouTube rule is path-scoped, so a
    // domain-only check that consulted `pathPrefix` would report no watch time
    // for the most-used site on the machine.
    const domains = [...new Set(MEDIA_RULES.map((r) => r.domain))];
    expect(domains).toContain("youtube.com");
    for (const d of domains) {
      const dir = tempDir("selfos-media-");
      const db2 = Db.open(join(dir, "t.sqlite"));
      migrate(db2);
      db2.run("INSERT INTO browser_profile (browser, profile_dir, history_path) VALUES ('h','Default','/x')");
      // A title row carries the bare domain, which is the case a domain-level
      // check is responsible for.
      db2.run(
        `INSERT INTO browser_visit (profile_id, url, title, domain, visit_time_us, visit_at, local_date,
                                    duration_us, transition, source)
         VALUES (1, ?, NULL, ?, ?, ?, '2026-11-02', ?, 0, 'window-title')`,
        `https://${d}/`,
        d,
        String(T0 * 1000),
        T0,
        String(120 * 1_000_000),
      );
      expect(watchTime(db2, "2026-11-02").seconds, `${d} should be media`).toBe(120);
      db2.close();
    }
  });
});
