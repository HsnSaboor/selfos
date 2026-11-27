/**
 * Goal math (PRD F-GOAL-05, F-GOAL-09).
 *
 * Pure functions only: the service reads rows and calls these, so every number
 * on screen can be reproduced from the same inputs in a test (product model
 * P-3, STACK §11).
 */
import { isDateKey } from "../../../shared/dates";

export type GoalKind = "numeric" | "milestone" | "quota";
export type GoalStatus = "active" | "completed" | "abandoned";

export interface GoalInput {
  title: string;
  description?: string;
  kind: GoalKind;
  targetValue?: number | null;
  unit?: string | null;
  startDate: string;
  targetDate?: string | null;
  parentId?: number | null;
  /** Optional link to a habit/module metric (F-GOAL-01); free text in v1. */
  source?: string | null;
}

export interface GoalRow {
  id: number;
  title: string;
  description: string | null;
  kind: GoalKind;
  target_value: number | null;
  unit: string | null;
  start_date: string;
  target_date: string | null;
  status: GoalStatus;
  source: string | null;
  parent_id: number | null;
  close_reason: string | null;
  created_at: number;
  closed_at: number | null;
}

export interface MilestoneRow {
  id: number;
  goal_id: number;
  title: string;
  due_date: string | null;
  done_at: number | null;
  sort: number;
}

export interface ProgressRow {
  id: number;
  goal_id: number;
  at: number;
  value: number;
  source: string;
  note: string | null;
}

export interface Pace {
  /** Fraction 0..1, clamped; the ring uses this. */
  fraction: number;
  /** Where the goal should be today if progress were linear: 0..1, unclamped. */
  expectedFraction: number;
  /** Projected completion date (YYYY-MM-DD) at the current rate, or null. */
  projectedDate: string | null;
  /** Days ahead (positive) or behind (negative) the linear schedule. */
  deltaDays: number | null;
  /** True when the goal is behind the pace needed to hit its target date. */
  offPace: boolean;
  /** Current value per day, over the elapsed window. */
  perDay: number;
  /** Value still needed, floored at 0. */
  remaining: number;
  /** Days from today to the target date, or null when open-ended. */
  daysRemaining: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Midnight-to-midnight day difference between two YYYY-MM-DD keys. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

import { addDays } from "../../../shared/dates";

export { addDays };

/** Completed milestones over total; a goal with no milestones has no progress. */
export function milestoneValue(milestones: MilestoneRow[]): { done: number; total: number } {
  return {
    done: milestones.filter((m) => m.done_at !== null).length,
    total: milestones.length,
  };
}

/**
 * The value a goal currently holds.
 *
 * Numeric and quota goals take the reading with the greatest `at`, tie-broken
 * by id. Taking the maximum instead would make a mistaken entry impossible to
 * correct downward, which contradicts "absolute value, not an increment".
 * Imported readings carry their own timestamp, so out-of-order ingestion is
 * still ordered correctly. Milestone goals count ticks.
 */
export function currentValue(
  goal: Pick<GoalRow, "kind">,
  milestones: MilestoneRow[],
  progress: ProgressRow[],
): number {
  if (goal.kind === "milestone") return milestoneValue(milestones).done;
  if (progress.length === 0) return 0;
  let latest = progress[0] as ProgressRow;
  for (const p of progress) {
    if (p.at > latest.at || (p.at === latest.at && p.id > latest.id)) latest = p;
  }
  return latest.value;
}

/** The target, defaulting milestone goals to their checklist length. */
export function targetValue(
  goal: Pick<GoalRow, "kind" | "target_value">,
  milestones: MilestoneRow[],
): number | null {
  if (goal.kind === "milestone") return milestones.length || goal.target_value || null;
  return goal.target_value;
}

/**
 * Pace against a straight line from start to target date.
 *
 * `today` is passed in rather than read from the clock so tests are stable and
 * the UI's "today" matches the collector's local date.
 */
export function computePace(opts: {
  startDate: string;
  targetDate: string | null;
  today: string;
  value: number;
  target: number | null;
}): Pace {
  const { startDate, targetDate, today, value, target } = opts;
  const elapsed = Math.max(0, daysBetween(startDate, today));
  const total = targetDate ? daysBetween(startDate, targetDate) : null;
  const fraction = target && target > 0 ? Math.min(1, Math.max(0, value / target)) : 0;
  const remaining = target === null ? 0 : Math.max(0, target - value);
  const perDay = elapsed > 0 ? value / elapsed : value;

  const expectedFraction = total && total > 0 ? Math.min(1, Math.max(0, elapsed / total)) : 0;
  const daysRemaining = targetDate ? daysBetween(today, targetDate) : null;

  let projectedDate: string | null = null;
  let deltaDays: number | null = null;
  if (target !== null && target > 0 && perDay > 0) {
    const daysNeeded = Math.ceil((target - value) / perDay);
    projectedDate = addDays(today, Math.max(0, daysNeeded));
    if (targetDate) {
      deltaDays = daysBetween(projectedDate, targetDate);
    }
  } else if (target !== null && value >= target) {
    projectedDate = today;
    deltaDays = targetDate ? daysBetween(today, targetDate) : null;
  }

  // "Off pace" means the projection misses the deadline, not that today's line
  // is behind — a goal can start slow and still catch up.
  const offPace =
    targetDate !== null && target !== null && fraction < 1
      ? projectedDate === null
        ? true
        : daysBetween(projectedDate, targetDate) < 0
      : false;

  return {
    fraction,
    expectedFraction,
    projectedDate,
    deltaDays,
    offPace,
    perDay,
    remaining,
    daysRemaining,
  };
}

/**
 * Roll-up for a parent goal: the mean of its children's fractions.
 *
 * Weighting by target size would make one big child dominate; the parent is a
 * summary of "how many of these are on track", so an unweighted mean is the
 * honest reading. Children with no target are skipped.
 */
export function rollupFraction(children: Array<{ fraction: number; hasTarget: boolean }>): number {
  const scored = children.filter((c) => c.hasTarget);
  if (scored.length === 0) return 0;
  return scored.reduce((a, c) => a + c.fraction, 0) / scored.length;
}

/** Validate a goal payload before it reaches SQLite. Throws on bad input. */
export function validateGoalInput(input: Partial<GoalInput>): GoalInput {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title is required");
  if (title.length > 200) throw new Error("title is too long");

  const kind = input.kind;
  if (kind !== "numeric" && kind !== "milestone" && kind !== "quota") {
    throw new Error("kind must be numeric, milestone, or quota");
  }

  const startDate = typeof input.startDate === "string" ? input.startDate : "";
  // isDateKey, not a shape regex: "2026-13-45" passes the regex and then makes
  // every pace figure NaN (round-13).
  if (!isDateKey(startDate)) throw new Error("startDate must be a real YYYY-MM-DD date");

  const targetDate = input.targetDate ?? null;
  if (targetDate !== null) {
    if (!isDateKey(targetDate)) throw new Error("targetDate must be a real YYYY-MM-DD date");
    if (daysBetween(startDate, targetDate) < 0) throw new Error("targetDate is before startDate");
  }

  let targetValue = input.targetValue ?? null;
  if (targetValue !== null) {
    if (typeof targetValue !== "number" || !Number.isFinite(targetValue) || targetValue <= 0) {
      throw new Error("targetValue must be a positive number");
    }
  } else if (kind !== "milestone") {
    // A numeric goal without a target cannot show progress, so default it to 1
    // rather than silently rendering 0%.
    targetValue = 1;
  }

  return {
    title,
    description: input.description?.trim() || undefined,
    kind,
    targetValue,
    unit: input.unit?.trim() || null,
    startDate,
    targetDate,
    parentId: input.parentId ?? null,
    source: input.source?.trim() || null,
  };
}
