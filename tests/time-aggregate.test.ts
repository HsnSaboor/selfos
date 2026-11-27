import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/main/db/driver";
import { computeDayAggregate, SWITCH_NOISE_MS, writeDayAggregate } from "../src/main/modules/time/aggregate";

/**
 * A minimal Db-shaped wrapper over an in-memory node:sqlite database, so the
 * aggregate logic is tested against the real engine without Electron.
 */
function testDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE focus_event (
      started_at INTEGER, ended_at INTEGER, local_date TEXT, app_class TEXT
    );
    CREATE TABLE reading_session (local_date TEXT, active_seconds INTEGER);
    CREATE TABLE day_aggregate (
      local_date TEXT PRIMARY KEY, screen_seconds INTEGER, focused_seconds INTEGER,
      media_seconds INTEGER, reading_seconds INTEGER, switches INTEGER,
      switches_per_hour REAL NOT NULL DEFAULT 0,
      focus_sessions INTEGER NOT NULL DEFAULT 0,
      longest_focus_seconds INTEGER NOT NULL DEFAULT 0,
      first_activity INTEGER, last_activity INTEGER, rebuilt_at INTEGER
    );
  `);
  return {
    raw,
    get: (sql: string, ...p: unknown[]) => (raw.prepare(sql).get(...(p as never[])) as never) ?? null,
    all: (sql: string, ...p: unknown[]) => raw.prepare(sql).all(...(p as never[])) as never,
    run: (sql: string, ...p: unknown[]) => {
      const r = raw.prepare(sql).run(...(p as never[]));
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
    },
  } as unknown as Db;
}

const DAY = "2026-11-02";
const H = 3_600_000;

function addFocus(db: Db, start: number, end: number, app: string, date = DAY): void {
  db.run(
    "INSERT INTO focus_event (started_at, ended_at, local_date, app_class) VALUES (?, ?, ?, ?)",
    start,
    end,
    date,
    app,
  );
}

describe("computeDayAggregate", () => {
  let db: Db;
  beforeEach(() => {
    db = testDb();
  });

  it("returns zeroes for an empty day", () => {
    expect(computeDayAggregate(db, DAY)).toMatchObject({
      screenSeconds: 0,
      focusedSeconds: 0,
      mediaSeconds: 0,
      switches: 0,
      firstActivity: null,
      lastActivity: null,
    });
  });

  it("sums screen time and counts app switches", () => {
    addFocus(db, 0, H, "helium");
    addFocus(db, H, 2 * H, "com.t3tools.T3Code");
    addFocus(db, 2 * H, 3 * H, "helium");
    const agg = computeDayAggregate(db, DAY);
    expect(agg.screenSeconds).toBe(3 * 3600);
    expect(agg.switches).toBe(2);
    expect(agg.firstActivity).toBe(0);
    expect(agg.lastActivity).toBe(3 * H);
  });

  it("excludes sub-threshold flickers from focused time but keeps them in screen time", () => {
    addFocus(db, 0, 10_000, "helium"); // 10 s, below 15 s threshold
    addFocus(db, 10_000, 10_000 + 60_000, "foot");
    const agg = computeDayAggregate(db, DAY);
    expect(agg.screenSeconds).toBe(70);
    expect(agg.focusedSeconds).toBe(60);
  });

  it("attributes media player time to mediaSeconds", () => {
    addFocus(db, 0, H, "mpv");
    addFocus(db, H, 2 * H, "helium");
    expect(computeDayAggregate(db, DAY).mediaSeconds).toBe(3600);
  });

  it("counts a segment exactly at the noise threshold as focused", () => {
    addFocus(db, 0, SWITCH_NOISE_MS, "helium");
    expect(computeDayAggregate(db, DAY).focusedSeconds).toBe(SWITCH_NOISE_MS / 1000);
  });

  it("ignores zero-length rows", () => {
    addFocus(db, 0, 0, "helium");
    addFocus(db, 0, H, "helium");
    const agg = computeDayAggregate(db, DAY);
    expect(agg.screenSeconds).toBe(3600);
    expect(agg.switches).toBe(0);
  });

  it("includes reading session seconds", () => {
    addFocus(db, 0, H, "selfos");
    db.run("INSERT INTO reading_session (local_date, active_seconds) VALUES (?, ?)", DAY, 900);
    expect(computeDayAggregate(db, DAY, 900).readingSeconds).toBe(900);
  });

  it("is isolated per day", () => {
    addFocus(db, 0, H, "helium", "2026-11-01");
    addFocus(db, 0, 2 * H, "helium", DAY);
    expect(computeDayAggregate(db, DAY).screenSeconds).toBe(7200);
  });
});

describe("writeDayAggregate", () => {
  it("upserts rather than duplicating", () => {
    const db = testDb();
    const agg = computeDayAggregate(db, DAY);
    writeDayAggregate(db, agg);
    writeDayAggregate(db, { ...agg, screenSeconds: 42 });
    const rows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM day_aggregate");
    expect(rows[0]?.n).toBe(1);
    expect(
      db.get<{ screen_seconds: number }>("SELECT screen_seconds FROM day_aggregate")?.screen_seconds,
    ).toBe(42);
  });

  it("is reproducible from raw events after a rebuild", () => {
    const db = testDb();
    addFocus(db, 0, H, "helium");
    const first = computeDayAggregate(db, DAY);
    addFocus(db, H, 2 * H, "foot");
    const second = computeDayAggregate(db, DAY);
    expect(second.screenSeconds).toBe(first.screenSeconds * 2);
  });
});
