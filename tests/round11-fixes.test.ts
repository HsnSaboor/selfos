import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autostartEnabled, setAutostart } from "../src/main/autostart";
import { contrastPairs, contrastRatio, FALLBACK_THEME } from "../src/main/integrations/omarchy-theme";
import { summarizeDay } from "../src/main/modules/dashboard/summary";
import type { HabitView } from "../src/shared/api";

const habit = (over: Partial<HabitView>): HabitView => ({
  id: 1,
  name: "x",
  kind: "boolean",
  unit: null,
  target: null,
  icon: null,
  color: null,
  schedule: null,
  todayEntry: null,
  streak: { current: 0, longest: 0, unit: "days" },
  completion30d: 0,
  dueToday: true,
  archivedAt: null,
  ...over,
});

describe("summarizeDay", () => {
  it("counts only habits due today, not every logged row", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: undefined,
      habitStates: [
        habit({ id: 1, todayEntry: { localDate: "2026-11-27", value: 1, status: "done" } }),
        habit({ id: 2, todayEntry: { localDate: "2026-11-27", value: 0, status: "skipped" } }),
        habit({ id: 3, dueToday: false }),
      ],
      prayersLogged: 2,
      hijri: "1 Jumada I 1448",
      hijriSource: "computed",
      watchSeconds: 0,
    });
    expect(day.habitsDone).toBe(1);
    expect(day.habitsTotal).toBe(2);
  });

  it("adds browser watch time to local-player media time", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: {
        screen_seconds: 3600,
        focused_seconds: 3000,
        media_seconds: 600,
        reading_seconds: 1200,
        first_activity: 1,
        last_activity: 2,
        switches: 5,
      },
      habitStates: [],
      prayersLogged: 0,
      hijri: "x",
      hijriSource: "salah-ctl",
      watchSeconds: 1800,
    });
    expect(day.mediaSeconds).toBe(600);
    expect(day.watchSeconds).toBe(2400);
  });

  it("keeps the best streak across active habits", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: undefined,
      habitStates: [
        habit({ streak: { current: 4, longest: 9, unit: "days" } }),
        habit({ id: 2, streak: { current: 7, longest: 9, unit: "days" } }),
      ],
      prayersLogged: 0,
      hijri: "x",
      hijriSource: "computed",
      watchSeconds: 0,
    });
    expect(day.bestStreak).toBe(7);
  });
});

describe("fallback theme contrast (WCAG AA)", () => {
  it("clears 4.5:1 for every text/surface pair", () => {
    for (const [pair, fg, bg] of contrastPairs(FALLBACK_THEME)) {
      const ratio = contrastRatio(fg, bg);
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio, `${pair} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("autostart entry", () => {
  it("writes a --hidden desktop entry and removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "selfos-autostart-"));
    const file = join(dir, "selfos.desktop");
    try {
      expect(autostartEnabled(file)).toBe(false);
      expect(setAutostart(true, file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("X-GNOME-Autostart-enabled=true");
      expect(text).toContain("--hidden");
      expect(setAutostart(false, file)).toBe(false);
      expect(autostartEnabled(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 13", () => {
  it("keeps schedule versions immutable and takes effect tomorrow", async () => {
    const { HabitsService } = await import("../src/main/modules/habits/service");
    const { Db } = await import("../src/main/db/driver");
    const { migrate } = await import("../src/main/db/migrate");
    const db = Db.open(":memory:");
    migrate(db);
    const svc = new HabitsService(db);
    const id = svc.create({ name: "Read", kind: "boolean", schedule: { kind: "daily" } }, "2026-11-02");
    svc.changeSchedule(id, { kind: "weekdays", weekdays: [1, 2, 3] }, "2026-11-02");
    const versions = db.all<{ effective_from: string; kind: string }>(
      "SELECT effective_from, kind FROM habit_schedule WHERE habit_id = ? ORDER BY effective_from",
      id,
    );
    expect(versions[0]?.kind).toBe("daily");
    expect(versions[1]?.effective_from).toBe("2026-11-03");
    expect(versions[1]?.kind).toBe("weekdays");
    db.close();
  });

  it("clamps a qada repayment to the outstanding debt", async () => {
    const { SalahService } = await import("../src/main/modules/salah/service");
    const { Db } = await import("../src/main/db/driver");
    const { migrate } = await import("../src/main/db/migrate");
    const db = Db.open(":memory:");
    migrate(db);
    const svc = new SalahService(db);
    await svc.log("fajr", { localDate: "2026-11-02", status: "missed" });
    svc.repayQada("fajr", 5, "2026-11-02");
    expect(svc.qada().total).toBe(0);
    await svc.log("dhuhr", { localDate: "2026-11-02", status: "missed" });
    expect(svc.qada().total).toBe(1);
    db.close();
  });
});

describe("round 15", () => {
  it("rejects sibling-prefix paths and accepts real children", async () => {
    const { isInside } = await import("../src/shared/paths");
    expect(isInside("/tmp/library", "/tmp/library/a.pdf")).toBe(true);
    expect(isInside("/tmp/library", "/tmp/library-evil/a.pdf")).toBe(false);
    expect(isInside("/tmp/library", "/tmp/library")).toBe(false);
  });
});

describe("round 16", () => {
  it("deletes a goal range with children (foreign keys on)", async () => {
    const { Db } = await import("../src/main/db/driver");
    const { migrate } = await import("../src/main/db/migrate");
    const { Services } = await import("../src/main/services/context");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "selfos-del-"));
    const db = Db.open(join(dir, "selfos.sqlite"));
    migrate(db);
    const svc = new Services(dir);
    const id = svc.goals.create({ title: "Read", kind: "numeric", startDate: "2026-11-01", targetValue: 10 });
    svc.goals.record(id, 3);
    svc.goals.addMilestone(id, "half", "2026-11-10");
    const res = svc.deleteRange("goals", "2026-11-01", "2026-11-30", true);
    expect(res.deleted).toBeGreaterThan(0);
    expect(svc.goals.list(false).length).toBe(0);
    db.close();
  });

  it("takes a pre-migration snapshot before applying pending migrations", async () => {
    const { Db } = await import("../src/main/db/driver");
    const { migrate } = await import("../src/main/db/migrate");
    const { mkdtempSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "selfos-mig-"));
    const file = join(dir, "selfos.sqlite");
    const db = Db.open(file);
    migrate(db);
    db.close();
    expect(readdirSync(dir).some((n) => n.includes(".premigrate-"))).toBe(true);
  });
});
