import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Db } from "../src/main/db/driver";
import { migrate } from "../src/main/db/migrate";
import {
  addDays,
  computePace,
  currentValue,
  daysBetween,
  milestoneValue,
  rollupFraction,
  validateGoalInput,
} from "../src/main/modules/goals/model";
import { GoalsService } from "../src/main/modules/goals/service";
import { tempDir } from "./helpers/temp"
import { freshDb } from "./helpers/db";

function freshDb(): Db {
  const dir = tempDir("selfos-goals-");
  const db = Db.open(join(dir, "test.sqlite"));
  migrate(db);
  return db;
}

const TODAY = "2026-06-15";

describe("daysBetween / addDays", () => {
  it("counts whole days across a DST boundary", () => {
    // Europe/London springs forward on 2026-03-29; UTC date math must not drift.
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
  });

  it("is signed", () => {
    expect(daysBetween("2026-06-20", "2026-06-15")).toBe(-5);
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-01-30", 3)).toBe("2026-02-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("computePace", () => {
  it("reports the fraction and expected line", () => {
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: "2026-07-01",
      today: TODAY,
      value: 15,
      target: 30,
    });
    expect(p.fraction).toBeCloseTo(0.5);
    // 14 of 30 days elapsed.
    expect(p.expectedFraction).toBeCloseTo(14 / 30, 5);
    expect(p.remaining).toBe(15);
    expect(p.daysRemaining).toBe(16);
  });

  it("projects a completion date from the current rate", () => {
    // 15 units in 14 days -> 1.07/day; 15 left -> ~14 more days.
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: "2026-07-01",
      today: TODAY,
      value: 15,
      target: 30,
    });
    expect(p.perDay).toBeCloseTo(15 / 14, 5);
    expect(p.projectedDate).toBe("2026-06-29");
    expect(p.deltaDays).toBe(2);
    expect(p.offPace).toBe(false);
  });

  it("flags a goal that will miss its date", () => {
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: "2026-06-20",
      today: TODAY,
      value: 3,
      target: 30,
    });
    expect(p.projectedDate && p.projectedDate > "2026-06-20").toBe(true);
    expect(p.offPace).toBe(true);
    expect(p.deltaDays).toBeLessThan(0);
  });

  it("is not off pace when the target is already met", () => {
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: "2026-06-20",
      today: TODAY,
      value: 30,
      target: 30,
    });
    expect(p.fraction).toBe(1);
    expect(p.offPace).toBe(false);
    expect(p.projectedDate).toBe(TODAY);
  });

  it("handles a goal with no target date", () => {
    const p = computePace({ startDate: "2026-06-01", targetDate: null, today: TODAY, value: 4, target: 10 });
    expect(p.daysRemaining).toBeNull();
    expect(p.offPace).toBe(false);
    expect(p.expectedFraction).toBe(0);
    // 4 units in 14 days -> 6 left takes ~21 more days.
    expect(p.projectedDate).toBe("2026-07-06");
  });

  it("does not divide by zero on day one", () => {
    const p = computePace({
      startDate: TODAY,
      targetDate: "2026-07-15",
      today: TODAY,
      value: 0,
      target: 10,
    });
    expect(p.perDay).toBe(0);
    expect(p.projectedDate).toBeNull();
    expect(p.offPace).toBe(true);
  });

  it("clamps the fraction at 1 when the value overshoots", () => {
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: "2026-07-01",
      today: TODAY,
      value: 45,
      target: 30,
    });
    expect(p.fraction).toBe(1);
    expect(p.remaining).toBe(0);
  });

  it("treats a missing target as zero progress", () => {
    const p = computePace({
      startDate: "2026-06-01",
      targetDate: null,
      today: TODAY,
      value: 3,
      target: null,
    });
    expect(p.fraction).toBe(0);
    expect(p.remaining).toBe(0);
  });
});

describe("currentValue / targetValue", () => {
  const goal = (kind: "numeric" | "milestone" | "quota") => ({ kind });

  it("takes the newest reading, even when imported out of order", () => {
    // Row order is not time order: `at` decides, so a late-arriving older
    // reading cannot overwrite a newer one.
    expect(
      currentValue(
        goal("numeric"),
        [],
        [
          { id: 1, goal_id: 1, at: 200, value: 9, source: "manual", note: null },
          { id: 2, goal_id: 1, at: 100, value: 12, source: "manual", note: null },
        ],
      ),
    ).toBe(9);
  });

  it("lets a mistaken reading be corrected downward", () => {
    expect(
      currentValue(
        goal("numeric"),
        [],
        [
          { id: 1, goal_id: 1, at: 100, value: 9, source: "manual", note: null },
          { id: 2, goal_id: 1, at: 200, value: 2, source: "manual", note: null },
        ],
      ),
    ).toBe(2);
  });

  it("counts completed milestones", () => {
    const ms = [
      { id: 1, goal_id: 1, title: "a", due_date: null, done_at: 1, sort: 0 },
      { id: 2, goal_id: 1, title: "b", due_date: null, done_at: null, sort: 1 },
    ];
    expect(milestoneValue(ms)).toEqual({ done: 1, total: 2 });
    expect(currentValue(goal("milestone"), ms, [])).toBe(1);
  });

  it("has no progress when there are no readings", () => {
    expect(currentValue(goal("quota"), [], [])).toBe(0);
  });
});

describe("rollupFraction", () => {
  it("averages only children with targets", () => {
    expect(
      rollupFraction([
        { fraction: 1, hasTarget: true },
        { fraction: 0.5, hasTarget: true },
        { fraction: 0, hasTarget: false },
      ]),
    ).toBe(0.75);
  });

  it("is zero with no scored children", () => {
    expect(rollupFraction([])).toBe(0);
    expect(rollupFraction([{ fraction: 0.9, hasTarget: false }])).toBe(0);
  });
});

describe("validateGoalInput", () => {
  it("requires a title and a real kind", () => {
    expect(() => validateGoalInput({ kind: "numeric", startDate: TODAY })).toThrow(/title/);
    expect(() => validateGoalInput({ title: "x", kind: "bogus" as never, startDate: TODAY })).toThrow(/kind/);
  });

  it("rejects a target date before the start", () => {
    expect(() =>
      validateGoalInput({ title: "x", kind: "numeric", startDate: "2026-06-10", targetDate: "2026-06-01" }),
    ).toThrow(/before startDate/);
  });

  it("rejects non-positive targets", () => {
    expect(() =>
      validateGoalInput({ title: "x", kind: "numeric", startDate: TODAY, targetValue: 0 }),
    ).toThrow(/positive/);
  });

  it("defaults a numeric target so progress is never undefined", () => {
    expect(validateGoalInput({ title: "x", kind: "numeric", startDate: TODAY }).targetValue).toBe(1);
  });

  it("trims and normalises", () => {
    const v = validateGoalInput({ title: "  Read  ", kind: "numeric", startDate: TODAY, unit: " books " });
    expect(v.title).toBe("Read");
    expect(v.unit).toBe("books");
  });
});

describe("GoalsService", () => {
  let db: Db;
  let goals: GoalsService;

  beforeEach(() => {
    db = freshDb();
    goals = new GoalsService(db);
  });

  it("creates and lists an active goal", () => {
    const id = goals.create(
      {
        title: "Read 12 books",
        kind: "numeric",
        targetValue: 12,
        unit: "books",
        startDate: "2026-01-01",
        targetDate: "2026-12-31",
      },
      TODAY,
    );
    const list = goals.list({ today: TODAY });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
    expect(list[0]?.target).toBe(12);
    expect(list[0]?.status).toBe("active");
  });

  it("records readings and completes at the target", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 10, startDate: "2026-06-01", targetDate: "2026-06-30" },
      TODAY,
    );
    goals.record(id, 4);
    goals.record(id, 6);
    const g = goals.get(id, TODAY);
    expect(g?.value).toBe(6);
    expect(g?.status).toBe("active");
    goals.record(id, 10);
    expect(goals.get(id, TODAY)?.status).toBe("completed");
  });

  it("rejects a reading on a closed goal", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    goals.close(id, "abandoned", "changed plans");
    expect(() => goals.record(id, 3)).toThrow(/closed/);
  });

  it("rejects a negative reading", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    expect(() => goals.record(id, -1)).toThrow(/non-negative/);
  });

  it("progresses milestone goals through the checklist", () => {
    const id = goals.create(
      { title: "Ship v1", kind: "milestone", startDate: "2026-06-01", targetDate: "2026-08-01" },
      TODAY,
    );
    const a = goals.addMilestone(id, "Design");
    goals.addMilestone(id, "Build");
    const g1 = goals.get(id, TODAY);
    expect(g1?.target).toBe(2);
    expect(g1?.value).toBe(0);

    goals.setMilestone(a, true);
    const g2 = goals.get(id, TODAY);
    expect(g2?.value).toBe(1);
    expect(g2?.pace.fraction).toBe(0.5);

    const b = g2?.milestones.find((m) => m.id !== a)?.id ?? 0;
    goals.setMilestone(b, true);
    expect(goals.get(id, TODAY)?.status).toBe("completed");

    // Un-ticking reopens it.
    goals.setMilestone(b, false);
    expect(goals.get(id, TODAY)?.status).toBe("active");
  });

  it("refuses manual readings on a milestone goal", () => {
    const id = goals.create({ title: "Ship", kind: "milestone", startDate: "2026-06-01" }, TODAY);
    expect(() => goals.record(id, 1)).toThrow(/checklist/);
  });

  it("marks an overdue milestone", () => {
    const id = goals.create({ title: "Ship", kind: "milestone", startDate: "2026-06-01" }, TODAY);
    goals.addMilestone(id, "Late", "2026-06-01");
    goals.addMilestone(id, "Later", "2026-07-01");
    const g = goals.get(id, TODAY);
    expect(g?.milestones[0]?.overdue).toBe(true);
    expect(g?.milestones[1]?.overdue).toBe(false);
  });

  it("closes with a reason and keeps it in the record", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    goals.close(id, "abandoned", "injury");
    const closed = goals.get(id, TODAY);
    expect(closed?.status).toBe("abandoned");
    expect(closed?.closeReason).toBe("injury");
    expect(closed?.closedAt).not.toBeNull();
    // Hidden from the active list, still present with includeClosed.
    expect(goals.list({ today: TODAY })).toHaveLength(0);
    expect(goals.list({ includeClosed: true, today: TODAY })).toHaveLength(1);
  });

  it("refuses to close twice", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    goals.close(id, "completed");
    expect(() => goals.close(id, "abandoned")).toThrow(/already closed/);
  });

  it("reopens a closed goal", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    goals.close(id, "completed");
    goals.reopen(id);
    expect(goals.get(id, TODAY)?.status).toBe("active");
  });

  it("keeps completed children in the roll-up", () => {
    const parent = goals.create(
      { title: "Year", kind: "numeric", targetValue: 1, startDate: "2026-01-01" },
      TODAY,
    );
    const a = goals.create(
      { title: "A", kind: "numeric", targetValue: 1, startDate: "2026-01-01", parentId: parent },
      TODAY,
    );
    goals.create(
      { title: "B", kind: "numeric", targetValue: 1, startDate: "2026-01-01", parentId: parent },
      TODAY,
    );
    goals.record(a, 1); // auto-completes A
    // Finishing a child must not reduce the parent's number.
    expect(goals.get(parent, TODAY)?.rollup).toBe(0.5);
    expect(goals.get(parent, TODAY)?.childCount).toBe(2);
  });

  it("rolls child progress up to the parent", () => {
    const parent = goals.create(
      { title: "Year", kind: "numeric", targetValue: 1, startDate: "2026-01-01" },
      TODAY,
    );
    const q1 = goals.create(
      {
        title: "Q1",
        kind: "numeric",
        targetValue: 10,
        startDate: "2026-01-01",
        targetDate: "2026-03-31",
        parentId: parent,
      },
      TODAY,
    );
    goals.create(
      {
        title: "Q2",
        kind: "numeric",
        targetValue: 10,
        startDate: "2026-04-01",
        targetDate: "2026-06-30",
        parentId: parent,
      },
      TODAY,
    );
    goals.record(q1, 10);

    const p = goals.get(parent, TODAY);
    expect(p?.childCount).toBe(2);
    expect(p?.rollup).toBe(0.5);
  });

  it("abandons active children when the parent is abandoned", () => {
    const parent = goals.create(
      { title: "Year", kind: "numeric", targetValue: 1, startDate: "2026-01-01" },
      TODAY,
    );
    const child = goals.create(
      { title: "Q1", kind: "numeric", targetValue: 10, startDate: "2026-01-01", parentId: parent },
      TODAY,
    );
    goals.close(parent, "abandoned", "new direction");
    const c = goals.get(child, TODAY);
    expect(c?.status).toBe("abandoned");
    expect(c?.closeReason).toBe("parent abandoned");
  });

  it("rejects an unknown parent", () => {
    expect(() =>
      goals.create({ title: "Q1", kind: "numeric", startDate: "2026-01-01", parentId: 999 }, TODAY),
    ).toThrow(/parent/);
  });

  it("updates editable fields without touching the kind", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-01" },
      TODAY,
    );
    goals.update(id, { title: "Run far", targetValue: 8, targetDate: "2026-07-01" });
    const g = goals.get(id, TODAY);
    expect(g?.title).toBe("Run far");
    expect(g?.target).toBe(8);
    expect(g?.kind).toBe("numeric");
  });

  it("rejects an update that moves the target before the start", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 5, startDate: "2026-06-10" },
      TODAY,
    );
    expect(() => goals.update(id, { targetDate: "2026-06-01" })).toThrow(/before startDate/);
  });

  it("returns contributions newest first", () => {
    const id = goals.create(
      { title: "Run", kind: "numeric", targetValue: 100, startDate: "2026-06-01" },
      TODAY,
    );
    goals.record(id, 3, "first");
    goals.record(id, 7, "second");
    const g = goals.get(id, TODAY);
    expect(g?.contributions[0]?.value).toBe(7);
    expect(g?.contributions[1]?.note).toBe("first");
  });

  it("reports a missing goal as null rather than throwing", () => {
    expect(goals.get(4242, TODAY)).toBeNull();
  });

  it("removes a milestone", () => {
    const id = goals.create({ title: "Ship", kind: "milestone", startDate: "2026-06-01" }, TODAY);
    const m = goals.addMilestone(id, "Draft");
    goals.removeMilestone(m);
    expect(goals.get(id, TODAY)?.milestonesTotal).toBe(0);
  });
});
