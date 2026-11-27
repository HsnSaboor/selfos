import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/driver";
import { migrate } from "../src/main/db/migrate";
import {
  applyPendingRestore,
  BackupService,
  backupName,
  classifyBackup,
  exportJson,
  exportPath,
  isoWeek,
  pruneList,
  stageRestore,
  tableToCsv,
  writeExport,
} from "../src/main/modules/data/backup";
import { addDays } from "../src/main/modules/goals/model";
import { analyse, dateRange, hourlyProfile, streaks, topDomains } from "../src/main/modules/time/analytics";
import { freshDb } from "./helpers/db";
import { tempDir } from "./helpers/temp";

function freshDb(): Db {
  const dir = tempDir("selfos-data-");
  const db = Db.open(join(dir, "test.sqlite"));
  migrate(db);
  return db;
}

function seedDay(db: Db, date: string, screenSeconds: number, focused = screenSeconds): void {
  db.run(
    `INSERT INTO day_aggregate (local_date, screen_seconds, focused_seconds, media_seconds,
                                reading_seconds, switches, rebuilt_at)
     VALUES (?, ?, ?, 0, 0, 3, ?)
     ON CONFLICT(local_date) DO UPDATE SET screen_seconds = excluded.screen_seconds`,
    date,
    screenSeconds,
    focused,
    Date.now(),
  );
}

describe("backup names", () => {
  it("uses the ISO week for weekly copies", () => {
    // 2026-11-02 is a Monday in ISO week 45.
    expect(isoWeek(new Date(2026, 10, 2))).toEqual({ year: 2026, week: 45 });
    expect(backupName("weekly", new Date(2026, 10, 2))).toBe("selfos-week-2026-W45.sqlite");
  });

  it("names dailies by local date", () => {
    expect(backupName("daily", new Date(2026, 0, 5))).toBe("selfos-2026-01-05.sqlite");
  });

  it("stamps manual copies and tolerates a label", () => {
    const d = new Date(Date.UTC(2026, 0, 5, 13, 4, 5));
    expect(backupName("manual", d)).toContain("selfos-manual-2026-01-05");
    expect(backupName("manual", d, "before-import")).toContain("before-import");
  });

  it("classifies by name", () => {
    expect(classifyBackup("selfos-week-2026-W45.sqlite")).toBe("weekly");
    expect(classifyBackup("selfos-manual-x.sqlite")).toBe("manual");
    expect(classifyBackup("selfos-2026-11-02.sqlite")).toBe("daily");
  });
});

describe("pruneList", () => {
  const mk = (name: string, kind: "daily" | "weekly" | "manual", createdAt: number) => ({
    name,
    kind,
    createdAt,
  });

  it("keeps the newest N of each kind", () => {
    const files = [mk("d1", "daily", 5), mk("d2", "daily", 4), mk("d3", "daily", 3), mk("d4", "daily", 2)];
    expect(pruneList(files, { daily: 2, weekly: 8 })).toEqual(["d3", "d4"]);
  });

  it("never prunes manual backups", () => {
    const files = [mk("m1", "manual", 1), mk("m2", "manual", 2), mk("m3", "manual", 3)];
    expect(pruneList(files, { daily: 0, weekly: 0 })).toEqual([]);
  });

  it("prunes weekly and daily independently", () => {
    const files = [mk("w1", "weekly", 1), mk("w2", "weekly", 2), mk("d1", "daily", 3)];
    expect(pruneList(files, { daily: 5, weekly: 1 })).toEqual(["w1"]);
  });
});

describe("BackupService", () => {
  let db: Db;
  let dir: string;
  let svc: BackupService;

  beforeEach(() => {
    db = freshDb();
    dir = tempDir("selfos-backups-");
    svc = new BackupService(db, dir);
  });

  it("writes a consistent copy while the database is open", () => {
    db.run("INSERT INTO meta (key, value) VALUES ('probe', 'yes')");
    const file = svc.create("manual");
    expect(existsSync(file.path)).toBe(true);
    expect(file.bytes).toBeGreaterThan(0);
    expect(file.kind).toBe("manual");

    // The copy is a real database with the row in it.
    const copy = Db.open(file.path, { readonly: true });
    expect(copy.get<{ value: string }>("SELECT value FROM meta WHERE key = 'probe'")?.value).toBe("yes");
    copy.close();
  });

  it("lists newest first", () => {
    const a = svc.create("manual");
    const b = svc.create("manual");
    const list = svc.list();
    expect(list.map((f) => f.name)).toContain(a.name);
    expect(list.map((f) => f.name)).toContain(b.name);
    expect(list[0]?.createdAt ?? 0).toBeGreaterThanOrEqual(list[list.length - 1]?.createdAt ?? 0);
  });

  it("is idempotent for the same day", () => {
    const now = new Date(2026, 5, 15, 9, 0, 0);
    const first = svc.runScheduled(now);
    expect(first?.kind).toBe("daily");
    expect(svc.runScheduled(now)).toBeNull();
    expect(svc.list().filter((f) => f.kind === "daily")).toHaveLength(1);
  });

  it("also takes a weekly copy on Sunday", () => {
    const sunday = new Date(2026, 10, 8); // 2026-11-08 is a Sunday
    expect(sunday.getDay()).toBe(0);
    svc.runScheduled(sunday);
    expect(svc.list().some((f) => f.kind === "weekly")).toBe(true);
  });

  it("does not take a weekly copy mid-week", () => {
    svc.runScheduled(new Date(2026, 10, 4)); // Wednesday
    expect(svc.list().some((f) => f.kind === "weekly")).toBe(false);
  });

  it("prunes according to retention", () => {
    for (let i = 0; i < 4; i++) {
      const day = new Date(2026, 5, 1 + i, 12, 0, 0);
      svc.runScheduled(day, { daily: 2, weekly: 8 });
    }
    expect(svc.list().filter((f) => f.kind === "daily")).toHaveLength(2);
  });

  it("returns an empty list when the directory does not exist", () => {
    expect(new BackupService(db, join(dir, "nope")).list()).toEqual([]);
  });
});

describe("restore", () => {
  it("stages the backup without touching the live database", () => {
    const dir = tempDir("selfos-restore-");
    const live = join(dir, "live.sqlite");
    const backup = join(dir, "backup.sqlite");
    writeFileSync(live, "current");
    writeFileSync(backup, "restored");
    stageRestore(backup, live);
    // Nothing changes until the next launch.
    expect(readFileSync(live, "utf8")).toBe("current");
    expect(readFileSync(`${live}.pending-restore`, "utf8")).toBe("restored");
  });

  it("applies a staged restore and keeps a safety copy", () => {
    const dir = tempDir("selfos-restore-");
    const live = join(dir, "live.sqlite");
    const backup = join(dir, "backup.sqlite");
    writeFileSync(live, "current");
    writeFileSync(backup, "restored");
    stageRestore(backup, live);
    const safety = applyPendingRestore(live);
    expect(readFileSync(live, "utf8")).toBe("restored");
    expect(safety).not.toBeNull();
    expect(readFileSync(safety as string, "utf8")).toBe("current");
    // The marker is consumed, so a restart does not restore twice.
    expect(applyPendingRestore(live)).toBeNull();
  });

  it("drops stale WAL sidecars when applying", () => {
    const dir = tempDir("selfos-restore-");
    const live = join(dir, "live.sqlite");
    const backup = join(dir, "backup.sqlite");
    writeFileSync(live, "current");
    writeFileSync(`${live}-wal`, "stale wal");
    writeFileSync(`${live}-shm`, "stale shm");
    writeFileSync(backup, "restored");
    stageRestore(backup, live);
    applyPendingRestore(live);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
  });

  it("returns the same path the health report shows, so the notice is accurate", () => {
    // `Services.restoredFrom` is `applyPendingRestore`'s return value verbatim,
    // and the Data page names that path as where the replaced database went. If
    // the two ever diverge the notice would point at a file that is not there.
    const dir = tempDir("selfos-restore-");
    const live = join(dir, "live.sqlite");
    const backup = join(dir, "backup.sqlite");
    writeFileSync(live, "current");
    writeFileSync(backup, "restored");
    stageRestore(backup, live);
    const safety = applyPendingRestore(live);
    expect(safety).toBe(`${live}.pre-restore-${Number(safety?.split("-").pop())}`);
    // The named file exists and holds what was replaced.
    expect(existsSync(safety as string)).toBe(true);
    expect(readFileSync(safety as string, "utf8")).toBe("current");
  });

  it("is a no-op when nothing is staged", () => {
    const dir = tempDir("selfos-restore-");
    expect(applyPendingRestore(join(dir, "live.sqlite"))).toBeNull();
  });

  it("refuses a missing backup", () => {
    expect(() => stageRestore("/nope/x.sqlite", "/tmp/live.sqlite")).toThrow(/not found/);
  });
});

describe("exports", () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
    db.run("INSERT INTO meta (key, value) VALUES ('k', 'v')");
    seedDay(db, "2026-11-01", 60);
    seedDay(db, "2026-11-02", 120);
  });

  it("exports every table as JSON", () => {
    const out = exportJson(db);
    // migrate() records its own rows in `meta`, so assert on our row, not the count.
    expect(out.tables.meta?.some((r) => (r as { key: string }).key === "k")).toBe(true);
    expect(out.tables.day_aggregate).toHaveLength(2);
    expect(out.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes CSV with a header row", () => {
    const csv = tableToCsv(db, "day_aggregate");
    const lines = csv.split("\n");
    expect(lines[0]).toContain("local_date");
    expect(lines[0]).toContain("screen_seconds");
    expect(lines).toHaveLength(3);
  });

  it("filters CSV by date range", () => {
    const csv = tableToCsv(db, "day_aggregate", { from: "2026-11-02", to: "2026-11-02" });
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("2026-11-02");
    expect(csv).not.toContain("2026-11-01");
  });

  it("escapes commas and quotes", () => {
    db.run("INSERT INTO meta (key, value) VALUES (?, ?)", "a,b", 'say "hi"');
    const csv = tableToCsv(db, "meta");
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
  });

  it("rejects an unknown table", () => {
    expect(() => tableToCsv(db, "nope")).toThrow(/no such table/);
  });

  it("builds export paths under exports/", () => {
    const p = exportPath("/data/SelfOS", "csv", "day_aggregate", new Date(2026, 10, 2));
    expect(p).toBe("/data/SelfOS/exports/selfos-2026-11-02-day_aggregate.csv");
  });

  it("sanitises a table name used in a path", () => {
    expect(exportPath("/d", "csv", "../../etc/passwd", new Date(2026, 0, 1))).toBe(
      "/d/exports/selfos-2026-01-01-.._.._etc_passwd.csv",
    );
  });

  it("creates the export directory", () => {
    const dir = tempDir("selfos-export-");
    const target = join(dir, "nested", "deep", "x.json");
    const res = writeExport(target, "{}");
    expect(existsSync(target)).toBe(true);
    expect(res.bytes).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("analytics", () => {
  let db: Db;
  const TODAY = "2026-11-02";

  beforeEach(() => {
    db = freshDb();
  });

  it("builds an inclusive range", () => {
    expect(dateRange(7, TODAY)).toEqual({ from: "2026-10-27", to: "2026-11-02" });
    expect(dateRange(1, TODAY)).toEqual({ from: TODAY, to: TODAY });
  });

  it("fills missing days with zeros", () => {
    seedDay(db, "2026-10-31", 100);
    seedDay(db, "2026-11-02", 50);
    const a = analyse(db, 7, TODAY);
    expect(a.days).toHaveLength(7);
    expect(a.days.filter((d) => d.screenSeconds === 0)).toHaveLength(5);
    expect(a.activeDayCount).toBe(2);
  });

  it("averages over active days only", () => {
    seedDay(db, "2026-10-31", 100);
    seedDay(db, "2026-11-02", 50);
    // 150 total over 2 active days, not over 7 calendar days.
    expect(analyse(db, 7, TODAY).averageScreenSeconds).toBe(75);
  });

  it("finds the best and worst active day", () => {
    seedDay(db, "2026-10-31", 100);
    seedDay(db, "2026-11-01", 300);
    seedDay(db, "2026-11-02", 50);
    const a = analyse(db, 7, TODAY);
    expect(a.bestDay?.localDate).toBe("2026-11-01");
    expect(a.worstDay?.localDate).toBe("2026-11-02");
  });

  it("has no best day when there is no activity", () => {
    const a = analyse(db, 7, TODAY);
    expect(a.bestDay).toBeNull();
    expect(a.averageScreenSeconds).toBe(0);
  });

  it("counts streaks over calendar days", () => {
    const days = [
      {
        localDate: "2026-10-28",
        screenSeconds: 1,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-10-29",
        screenSeconds: 1,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-10-30",
        screenSeconds: 0,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-10-31",
        screenSeconds: 1,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-11-01",
        screenSeconds: 1,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-11-02",
        screenSeconds: 1,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
    ];
    expect(streaks(days)).toEqual({ longest: 3, current: 3 });
  });

  it("reports a broken current streak", () => {
    const days = [
      {
        localDate: "2026-11-01",
        screenSeconds: 5,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
      {
        localDate: "2026-11-02",
        screenSeconds: 0,
        focusedSeconds: 0,
        mediaSeconds: 0,
        readingSeconds: 0,
        switches: 0,
      },
    ];
    expect(streaks(days)).toEqual({ longest: 1, current: 0 });
  });

  it("splits segments across hour boundaries", () => {
    const start = new Date(2026, 10, 2, 10, 30, 0).getTime();
    const end = new Date(2026, 10, 2, 11, 30, 0).getTime();
    db.run(
      `INSERT INTO focus_event (started_at, ended_at, local_date, app_class, app_title, source, session_id, created_at)
       VALUES (?, ?, '2026-11-02', 'kitty', '', 'hyprland', 's', ?)`,
      start,
      end,
      Date.now(),
    );
    const buckets = hourlyProfile(db, "2026-11-02");
    expect(buckets[10]?.seconds).toBe(1800);
    expect(buckets[11]?.seconds).toBe(1800);
    expect(buckets[12]?.seconds).toBe(0);
  });

  it("aggregates domains from browser history", () => {
    db.run(
      "INSERT INTO browser_profile (browser, profile_dir, history_path) VALUES ('helium', 'Default', '/h')",
    );
    const pid = db.get<{ id: number }>("SELECT id FROM browser_profile")?.id ?? 1;
    // Each visit needs a distinct timestamp: (profile, url, visit_time_us) is unique.
    const visits: Array<[string, number, string]> = [
      ["youtube.com", 60_000_000, "1"],
      ["youtube.com", 30_000_000, "2"],
      ["github.com", 10_000_000, "3"],
    ];
    for (const [domain, us, ts] of visits) {
      db.run(
        `INSERT INTO browser_visit (profile_id, url, domain, visit_time_us, visit_at, local_date, duration_us)
         VALUES (?, ?, ?, ?, ?, '2026-11-02', ?)`,
        pid,
        `https://${domain}/x`,
        domain,
        ts,
        Date.now(),
        us,
      );
    }
    const top = topDomains(db, 7, TODAY);
    expect(top[0]?.domain).toBe("youtube.com");
    // Two visits one minute apart, 60 s and 30 s long: they overlap, so the
    // union is 60 s, not the 90 s sum. `topDomains` must agree with `siteUsage`.
    expect(top[0]?.seconds).toBe(60);
    expect(top[0]?.visits).toBe(2);
    expect(top[1]?.domain).toBe("github.com");
  });

  it("returns no domains when history is empty", () => {
    expect(topDomains(db, 7, TODAY)).toEqual([]);
  });

  it("clamps an absurd range", () => {
    expect(dateRange(10_000, TODAY).from).toBe(addDays(TODAY, -365));
  });
});
