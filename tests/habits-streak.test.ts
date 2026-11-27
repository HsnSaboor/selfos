import { describe, expect, it } from "vitest";
import {
  addDays,
  describeSchedule,
  isDueOn,
  isoWeekday,
  parseWeekdays,
  periodKeyFor,
  type ScheduleVersion,
  scheduleFor,
  weekStart,
} from "../src/main/modules/habits/schedule";
import {
  classifyDay,
  completionRate,
  computeStreak,
  daySatisfies,
  type HabitDefinition,
  type HabitEntry,
  heatmapDays,
} from "../src/main/modules/habits/streak";

const TODAY = "2026-11-02"; // a Monday

function version(partial: Partial<ScheduleVersion> & { effectiveFrom: string }): ScheduleVersion {
  return {
    id: 1,
    habitId: 1,
    kind: "daily",
    weekdays: null,
    timesPerPeriod: null,
    ...partial,
  };
}

function entry(localDate: string, status: HabitEntry["status"], value = 0): HabitEntry {
  return { localDate, value, status };
}

const booleanHabit: HabitDefinition = { id: 1, kind: "boolean", target: 1 };
const countHabit: HabitDefinition = { id: 1, kind: "count", target: 8 };
const avoidHabit: HabitDefinition = { id: 1, kind: "avoid", target: null };

describe("date helpers", () => {
  it("computes ISO weekdays with Monday=1, Sunday=7", () => {
    expect(isoWeekday("2026-11-02")).toBe(1); // Monday
    expect(isoWeekday("2026-11-08")).toBe(7); // Sunday
  });

  it("finds the Monday of a week", () => {
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(weekStart("2026-11-05")).toBe("2026-11-02");
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("parses and normalises weekday lists", () => {
    expect(parseWeekdays("5,1,3,3,9,0")).toEqual([1, 3, 5]);
    expect(parseWeekdays("")).toBeNull();
    expect(parseWeekdays(null)).toBeNull();
  });
});

describe("scheduleFor", () => {
  const versions = [
    version({ id: 1, effectiveFrom: "2026-01-01", kind: "daily" }),
    version({ id: 2, effectiveFrom: "2026-06-01", kind: "weekdays", weekdays: [1, 3, 5] }),
  ];

  it("picks the version in effect for a date", () => {
    expect(scheduleFor(versions, "2026-03-01")?.id).toBe(1);
    expect(scheduleFor(versions, "2026-06-01")?.id).toBe(2);
    expect(scheduleFor(versions, "2026-10-01")?.id).toBe(2);
  });

  it("falls back to the earliest version before the first one starts", () => {
    // Backfill on the day a habit is created must still be evaluated against
    // its schedule (F-HABIT-10).
    expect(scheduleFor(versions, "2025-12-31")?.id).toBe(1);
    expect(scheduleFor([], "2026-01-01")).toBeNull();
  });

  it("does not depend on input order", () => {
    const shuffled = [versions[1], versions[0]].filter((v): v is ScheduleVersion => v !== undefined);
    expect(scheduleFor(shuffled, "2026-03-01")?.id).toBe(1);
  });
});

describe("isDueOn", () => {
  it("daily is always due", () => {
    expect(isDueOn(version({ effectiveFrom: "2026-01-01" }), "2026-11-02")).toBe(true);
  });

  it("weekdays respects ISO numbering", () => {
    const s = version({ effectiveFrom: "2026-01-01", kind: "weekdays", weekdays: [1, 3, 5] });
    expect(isDueOn(s, "2026-11-02")).toBe(true); // Mon
    expect(isDueOn(s, "2026-11-03")).toBe(false); // Tue
    expect(isDueOn(s, "2026-11-06")).toBe(true); // Fri
  });

  it("period schedules are never due on a single day", () => {
    const s = version({ effectiveFrom: "2026-01-01", kind: "times_per_week", timesPerPeriod: 3 });
    expect(isDueOn(s, "2026-11-02")).toBe(false);
    expect(periodKeyFor(s, "2026-11-05")).toBe("2026-11-02");
  });

  it("describes schedules for the UI", () => {
    expect(describeSchedule(version({ effectiveFrom: "2026-01-01" }))).toBe("Every day");
    expect(
      describeSchedule(version({ effectiveFrom: "2026-01-01", kind: "weekdays", weekdays: [1, 3] })),
    ).toBe("Mon, Wed");
    expect(
      describeSchedule(version({ effectiveFrom: "2026-01-01", kind: "times_per_week", timesPerPeriod: 3 })),
    ).toBe("3× per week");
  });
});

describe("daySatisfies", () => {
  it("boolean needs done", () => {
    expect(daySatisfies(booleanHabit, entry("2026-11-02", "done"))).toBe(true);
    expect(daySatisfies(booleanHabit, entry("2026-11-02", "partial"))).toBe(false);
    expect(daySatisfies(booleanHabit, undefined)).toBe(false);
  });

  it("count compares value to target", () => {
    expect(daySatisfies(countHabit, entry("2026-11-02", "partial", 8))).toBe(true);
    expect(daySatisfies(countHabit, entry("2026-11-02", "partial", 7))).toBe(false);
    expect(daySatisfies(countHabit, entry("2026-11-02", "done", 3))).toBe(true);
  });

  it("avoidance succeeds on clean, fails on slipped", () => {
    expect(daySatisfies(avoidHabit, entry("2026-11-02", "clean"))).toBe(true);
    expect(daySatisfies(avoidHabit, entry("2026-11-02", "slipped"))).toBe(false);
  });
});

describe("classifyDay", () => {
  const daily = [version({ effectiveFrom: "2026-01-01" })];

  it("marks today pending when unsatisfied", () => {
    expect(classifyDay(booleanHabit, daily, undefined, TODAY, TODAY)).toBe("pending");
  });

  it("marks past days failed when unsatisfied", () => {
    expect(classifyDay(booleanHabit, daily, undefined, "2026-11-01", TODAY)).toBe("failed");
  });

  it("treats skipped as neutral", () => {
    expect(classifyDay(booleanHabit, daily, entry("2026-11-01", "skipped"), "2026-11-01", TODAY)).toBe(
      "neutral",
    );
  });

  it("treats off-schedule days as neutral", () => {
    const mon = [version({ effectiveFrom: "2026-01-01", kind: "weekdays", weekdays: [1] })];
    expect(classifyDay(booleanHabit, mon, undefined, "2026-11-03", TODAY)).toBe("neutral"); // Tue
  });

  it("treats an off-day completion as neutral for streaks", () => {
    // The entry is stored, but it does not extend a streak (F-HABIT-06).
    const mon = [version({ effectiveFrom: "2026-01-01", kind: "weekdays", weekdays: [1] })];
    expect(classifyDay(booleanHabit, mon, entry("2026-11-03", "done"), "2026-11-03", TODAY)).toBe("neutral");
  });

  it("marks an avoidance slip as failed", () => {
    expect(classifyDay(avoidHabit, daily, entry("2026-11-01", "slipped"), "2026-11-01", TODAY)).toBe(
      "failed",
    );
  });
});

describe("computeStreak — daily", () => {
  const daily = [version({ effectiveFrom: "2026-01-01" })];

  it("counts consecutive satisfied days", () => {
    const entries = [entry("2026-11-02", "done"), entry("2026-11-01", "done"), entry("2026-10-31", "done")];
    expect(computeStreak({ habit: booleanHabit, versions: daily, entries, today: TODAY })).toMatchObject({
      current: 3,
      longest: 3,
      unit: "days",
    });
  });

  it("does not break the streak when today is still pending", () => {
    const entries = [entry("2026-11-01", "done"), entry("2026-10-31", "done")];
    expect(computeStreak({ habit: booleanHabit, versions: daily, entries, today: TODAY }).current).toBe(2);
  });

  it("breaks on a missed past day", () => {
    const entries = [
      entry("2026-11-02", "done"),
      entry("2026-11-01", "done"),
      // 2026-10-31 missing
      entry("2026-10-30", "done"),
      entry("2026-10-29", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: daily, entries, today: TODAY });
    expect(r.current).toBe(2);
    expect(r.longest).toBe(2);
  });

  it("passes through a skipped day without extending the streak", () => {
    const entries = [
      entry("2026-11-02", "done"),
      entry("2026-11-01", "skipped"),
      entry("2026-10-31", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: daily, entries, today: TODAY });
    expect(r.current).toBe(2);
    expect(r.longest).toBe(2);
  });

  it("reports the longest historical run even when the current one is short", () => {
    const entries = [
      entry("2026-11-02", "done"),
      // gap at 11-01
      entry("2026-10-31", "done"),
      entry("2026-10-30", "done"),
      entry("2026-10-29", "done"),
      entry("2026-10-28", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: daily, entries, today: TODAY });
    expect(r.current).toBe(1);
    expect(r.longest).toBe(4);
  });

  it("returns zero when nothing is done", () => {
    const r = computeStreak({ habit: booleanHabit, versions: daily, entries: [], today: TODAY });
    expect(r.current).toBe(0);
    expect(r.longest).toBe(0);
    expect(r.expected).toBeGreaterThan(0);
  });
});

describe("computeStreak — schedule changes (D-08)", () => {
  it("uses the schedule in effect on each date, not today's schedule", () => {
    // Daily Jan–May, then Mon/Wed/Fri only.
    const versions = [
      version({ id: 1, effectiveFrom: "2026-01-01", kind: "daily" }),
      version({ id: 2, effectiveFrom: "2026-06-01", kind: "weekdays", weekdays: [1, 3, 5] }),
    ];
    const entries = [
      entry("2026-11-02", "done"), // Mon, scheduled
      entry("2026-11-01", "done"), // Sun, NOT scheduled under v2
      entry("2026-10-30", "done"), // Fri, scheduled
    ];
    const r = computeStreak({ habit: booleanHabit, versions, entries, today: TODAY });
    // Sunday is neutral under v2, so it does not break the run.
    expect(r.current).toBe(2);
  });

  it("counts an old daily streak using the old schedule", () => {
    const versions = [
      version({ id: 1, effectiveFrom: "2026-01-01", kind: "daily" }),
      version({ id: 2, effectiveFrom: "2026-10-01", kind: "weekdays", weekdays: [1] }),
    ];
    const entries = [
      entry("2026-11-02", "done"),
      entry("2026-10-26", "done"),
      // Sept: daily, a 3-day run then a gap
      entry("2026-09-30", "done"),
      entry("2026-09-29", "done"),
      entry("2026-09-28", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions, entries, today: TODAY });
    expect(r.longest).toBeGreaterThanOrEqual(3);
  });
});

describe("computeStreak — weekly quota", () => {
  const weekly = [version({ effectiveFrom: "2026-01-01", kind: "times_per_week", timesPerPeriod: 3 })];
  // Friday of the same week, so three completions can already have happened.
  const FRIDAY = "2026-11-06";

  it("counts consecutive satisfied weeks", () => {
    const entries = [
      // current week (Mon 11-02): 3 done
      entry("2026-11-02", "done"),
      entry("2026-11-03", "done"),
      entry("2026-11-04", "done"),
      // previous week: 3 done
      entry("2026-10-27", "done"),
      entry("2026-10-28", "done"),
      entry("2026-10-30", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: weekly, entries, today: FRIDAY });
    expect(r.unit).toBe("weeks");
    expect(r.current).toBe(2);
  });

  it("does not break the streak while the current week is still in progress", () => {
    const entries = [
      entry("2026-11-02", "done"), // only 1 of 3 so far
      entry("2026-10-27", "done"),
      entry("2026-10-28", "done"),
      entry("2026-10-30", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: weekly, entries, today: FRIDAY });
    expect(r.current).toBe(1);
  });

  it("breaks on a week that fell short", () => {
    const entries = [
      entry("2026-11-02", "done"),
      entry("2026-11-03", "done"),
      entry("2026-11-04", "done"),
      // previous week only 2
      entry("2026-10-27", "done"),
      entry("2026-10-28", "done"),
      // week before: 3
      entry("2026-10-20", "done"),
      entry("2026-10-21", "done"),
      entry("2026-10-22", "done"),
    ];
    const r = computeStreak({ habit: booleanHabit, versions: weekly, entries, today: FRIDAY });
    expect(r.current).toBe(1);
    expect(r.longest).toBe(1);
  });

  it("counts only the current week's entries toward the current week", () => {
    const entries = [
      entry("2026-11-02", "done"), // Mon this week
      entry("2026-11-01", "done"),
      entry("2026-10-31", "done"),
      entry("2026-10-30", "done"), // last week
    ];
    const r = computeStreak({ habit: booleanHabit, versions: weekly, entries, today: FRIDAY });
    // Last week satisfied (3), current week pending (1 of 3).
    expect(r.current).toBe(1);
  });
});

describe("completionRate and heatmap", () => {
  const daily = [version({ effectiveFrom: "2026-01-01" })];

  it("computes a rate over expected periods", () => {
    const entries = [entry("2026-11-02", "done"), entry("2026-11-01", "done")];
    const rate = completionRate({
      habit: booleanHabit,
      versions: daily,
      entries,
      today: TODAY,
      lookbackDays: 4,
    });
    // First tracked day is 11-01, so 10-30 and 10-31 are neutral, not failures:
    // 2 satisfied out of 2 expected.
    expect(rate).toBeCloseTo(1, 5);
  });

  it("counts missed days after the first tracked day as failures", () => {
    const entries = [entry("2026-11-02", "done"), entry("2026-10-30", "done")];
    const rate = completionRate({
      habit: booleanHabit,
      versions: daily,
      entries,
      today: TODAY,
      lookbackDays: 4,
    });
    // 10-30 satisfied, 10-31 failed, 11-01 failed, 11-02 satisfied
    expect(rate).toBeCloseTo(0.5, 5);
  });

  it("returns 0 for an empty window rather than NaN", () => {
    const rate = completionRate({ habit: booleanHabit, versions: [], entries: [], today: TODAY });
    expect(rate).toBe(0);
  });

  it("produces one heatmap cell per requested day, ending today", () => {
    const days = heatmapDays({ habit: booleanHabit, versions: daily, entries: [], today: TODAY }, 7);
    expect(days).toHaveLength(7);
    expect(days[6]?.date).toBe(TODAY);
    expect(days[0]?.date).toBe("2026-10-27");
    expect(days[6]?.state).toBe("pending");
  });

  it("does not paint days before the habit existed as failures", () => {
    const entries = [entry("2026-11-02", "done"), entry("2026-11-01", "done")];
    const days = heatmapDays({ habit: booleanHabit, versions: daily, entries, today: TODAY }, 7);
    // Only 11-01 and 11-02 are tracked; the rest are neutral.
    expect(days.filter((d) => d.state === "failed")).toHaveLength(0);
    expect(days.filter((d) => d.state === "neutral")).toHaveLength(5);
  });
});

describe("avoidance habits", () => {
  const daily = [version({ effectiveFrom: "2026-01-01" })];

  it("builds a clean-day streak", () => {
    const entries = [
      entry("2026-11-02", "clean"),
      entry("2026-11-01", "clean"),
      entry("2026-10-31", "clean"),
    ];
    expect(computeStreak({ habit: avoidHabit, versions: daily, entries, today: TODAY }).current).toBe(3);
  });

  it("resets on a slip", () => {
    const entries = [
      entry("2026-11-02", "clean"),
      entry("2026-11-01", "slipped"),
      entry("2026-10-31", "clean"),
      entry("2026-10-30", "clean"),
    ];
    const r = computeStreak({ habit: avoidHabit, versions: daily, entries, today: TODAY });
    expect(r.current).toBe(1);
    expect(r.longest).toBe(2);
  });
});

describe("schedule changes do not rewrite history (wave 2)", () => {
  const habit = { id: 1, kind: "boolean" as const, target: null };
  const v = (id: number, from: string, kind: "daily" | "times_per_week", n?: number) => ({
    id,
    habitId: 1,
    effectiveFrom: from,
    kind,
    weekdays: null,
    timesPerPeriod: n ?? null,
  });
  const entry = (localDate: string) => ({
    habitId: 1,
    localDate,
    status: "done" as const,
    value: 1,
    note: null,
  });

  it("keeps a weekly history when the habit becomes daily", () => {
    // 20 Mondays under a 1x/week schedule, then switch to daily today.
    const entries = Array.from({ length: 20 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 26));
      d.setUTCDate(d.getUTCDate() - i * 7);
      return entry(d.toISOString().slice(0, 10));
    });
    const versions = [v(1, "2026-01-01", "times_per_week", 1), v(2, "2026-11-02", "daily")];
    const r = computeStreak({ habit, versions, entries, today: "2026-11-02" });
    // Before the fix this returned 0 — the entire history was discarded.
    expect(r.longest).toBe(20);
    expect(r.successes).toBe(20);
  });

  it("keeps a daily history when the habit becomes weekly", () => {
    const entries = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 10, 2));
      d.setUTCDate(d.getUTCDate() - i);
      return entry(d.toISOString().slice(0, 10));
    });
    const versions = [v(1, "2026-01-01", "daily"), v(2, "2026-11-02", "times_per_week", 1)];
    const r = computeStreak({ habit, versions, entries, today: "2026-11-02" });
    expect(r.longest).toBeGreaterThan(10);
    expect(r.successes).toBeGreaterThan(10);
  });

  it("does not count periods before the habit existed as failures", () => {
    // Created 2026-10-26 with a weekly schedule, both weeks satisfied.
    const entries = [entry("2026-10-26"), entry("2026-11-02")];
    const versions = [v(1, "2026-10-26", "times_per_week", 1)];
    const rate = completionRate({ habit, versions, entries, today: "2026-11-02", lookbackDays: 30 });
    // Before the fix this was 0.333 (2 satisfied / 6 periods, four predating the habit).
    expect(rate).toBe(1);
  });

  it("does not reinterpret past periods under a new quota", () => {
    // Two weeks that were 1/3 under the old quota, then the quota drops to 1.
    const entries = [entry("2026-10-19"), entry("2026-10-26"), entry("2026-11-02")];
    const versions = [v(1, "2026-01-01", "times_per_week", 3), v(2, "2026-11-02", "times_per_week", 1)];
    const r = computeStreak({ habit, versions, entries, today: "2026-11-02" });
    // Only the current week satisfies the new quota; the old weeks stay failed.
    expect(r.successes).toBe(1);
    expect(r.longest).toBe(1);
  });
});
