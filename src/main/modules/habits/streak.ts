/**
 * Streak and completion computation (PRD F-HABIT-08, F-HABIT-09).
 *
 * Semantics, stated explicitly because they are easy to get subtly wrong:
 *
 *  - A **day** is satisfied when its entry is `done`, or `partial`/`count` at the
 *    target (`isComplete` in `shared/habits.ts`). Linked-source completion is not
 *    implemented in v1.
 *  - A **skipped** day neither breaks nor extends a streak. It is neutral.
 *  - A **slipped** day (avoidance habits) breaks the streak.
 *  - An **unscheduled** day is neutral, exactly like a skip.
 *  - For period schedules (N×/week, N×/month) the period is the unit: the
 *    period is satisfied when it accumulates N successes, and a streak counts
 *    consecutive satisfied periods.
 *  - The current streak is evaluated **including today if today already
 *    satisfies**, otherwise from the last satisfied period. An unsatisfied
 *    *current* period does not break the streak until it has ended — otherwise
 *    every streak would read 0 at 00:01.
 *
 * Pure functions; all dates are local_date strings (YYYY-MM-DD).
 */
import { dayCount } from "../../../shared/dates";
import { isComplete } from "../../../shared/habits";
import {
  addDays,
  compareDateKeys,
  isDueOn,
  periodKeyFor,
  requiredPerPeriod,
  type ScheduleVersion,
  scheduleFor,
} from "./schedule";

export type EntryStatus = "done" | "partial" | "skipped" | "slipped" | "clean";

export interface HabitEntry {
  localDate: string;
  value: number;
  status: EntryStatus;
}

export type HabitKind = "boolean" | "count" | "duration" | "avoid";

export interface HabitDefinition {
  id: number;
  kind: HabitKind;
  target: number | null;
}

/** Did this single day count as success? One rule, shared with the UI. */
export function daySatisfies(habit: HabitDefinition, entry: HabitEntry | undefined): boolean {
  return isComplete(habit, entry);
}

export type DayState = "satisfied" | "failed" | "neutral" | "pending";

/**
 * Classify a single day for streak purposes.
 * `pending` means the day is still in progress and not yet satisfied.
 */
export function classifyDay(
  habit: HabitDefinition,
  versions: ScheduleVersion[],
  entry: HabitEntry | undefined,
  dateKey: string,
  today: string,
): DayState {
  const schedule = scheduleFor(versions, dateKey);
  if (!schedule) return "neutral";

  if (entry?.status === "skipped") return "neutral";

  if (schedule.kind === "times_per_week" || schedule.kind === "times_per_month") {
    // Period schedules are evaluated at the period level, not per day.
    return daySatisfies(habit, entry) ? "satisfied" : dateKey === today ? "pending" : "neutral";
  }

  if (!isDueOn(schedule, dateKey)) {
    // Off-schedule days are neutral for streak purposes, even if the user did
    // the habit anyway. Streaks measure adherence to the schedule; the entry
    // itself is still stored and shown, it just does not extend the run.
    return "neutral";
  }

  if (daySatisfies(habit, entry)) return "satisfied";
  if (habit.kind === "avoid" && entry?.status === "slipped") return "failed";
  return dateKey >= today ? "pending" : "failed";
}

export interface StreakResult {
  current: number;
  longest: number;
  unit: "days" | "weeks" | "months";
  /** Total successes in the evaluated window, for completion rate. */
  successes: number;
  /** Number of periods that were expected (satisfied + failed). */
  expected: number;
}

export interface StreakInput {
  habit: HabitDefinition;
  versions: ScheduleVersion[];
  entries: HabitEntry[];
  today: string;
  /** How far back to walk. Default 400 days (~13 months). */
  lookbackDays?: number;
}

/**
 * Walk backward from today, one period at a time.
 *
 * The walk is per-period because a period schedule's unit is the week/month.
 * For day schedules the period is the day, so the same loop serves both.
 */
function firstTracked(input: StreakInput): string {
  return input.entries.reduce(
    (min, e) => (compareDateKeys(e.localDate, min) < 0 ? e.localDate : min),
    input.today,
  );
}

export function computeStreak(input: StreakInput): StreakResult {
  const { habit, versions, today } = input;
  const lookback = input.lookbackDays ?? 400;
  const byDate = new Map(input.entries.map((e) => [e.localDate, e]));

  // Days before the habit's first recorded activity are neutral: the habit did
  // not exist yet, so they must not count as failures.
  const hasHistory = input.entries.length > 0;
  const first = firstTracked(input);

  // Exactly `lookback` days, inclusive of today.
  const start = addDays(today, -(lookback - 1));
  const trackedFrom = compareDateKeys(first, start) > 0 ? first : start;

  /**
   * Period buckets, keyed by the *period* rather than by a single global kind.
   *
   * A schedule's kind can change over time (C-6), so history must be judged by
   * the version in force for each period. Deciding the unit once from today's
   * version — the previous approach — discarded all history whenever the kind
   * changed: 20 weeks of a weekly habit read as zero after switching to daily.
   */
  const periodBuckets = new Map<
    string,
    { kind: "times_per_week" | "times_per_month"; got: number; required: number }
  >();

  for (const entry of input.entries) {
    if (compareDateKeys(entry.localDate, start) < 0) continue;
    if (compareDateKeys(entry.localDate, today) > 0) continue;
    const schedule = scheduleFor(versions, entry.localDate);
    if (!schedule) continue;
    if (!daySatisfies(habit, entry)) continue;
    if (schedule.kind !== "times_per_week" && schedule.kind !== "times_per_month") continue;

    const key = periodKeyFor(schedule, entry.localDate);
    const bucket = periodBuckets.get(key) ?? {
      kind: schedule.kind,
      got: 0,
      required: requiredPerPeriod(schedule),
    };
    bucket.got++;
    periodBuckets.set(key, bucket);
  }

  /**
   * Ordered states, newest first. Day-scheduled days and period-scheduled
   * periods are evaluated side by side, each under the version that applied to
   * it, so a mid-history kind change keeps both halves.
   */
  const states: DayState[] = [];
  const seenPeriods = new Set<string>();

  for (let d = today; compareDateKeys(d, start) >= 0; d = addDays(d, -1)) {
    const schedule = scheduleFor(versions, d);
    if (!schedule) {
      states.push("neutral");
      continue;
    }

    if (schedule.kind === "times_per_week" || schedule.kind === "times_per_month") {
      // Emit a period once, on the first day of it that this walk reaches.
      const key = periodKeyFor(schedule, d);
      if (seenPeriods.has(key)) continue;
      seenPeriods.add(key);

      // A period that starts before the habit existed is neutral, not failed.
      if (hasHistory && compareDateKeys(key, trackedFrom) < 0 && compareDateKeys(d, trackedFrom) < 0) {
        states.push("neutral");
        continue;
      }

      const bucket = periodBuckets.get(key);
      const got = bucket?.got ?? 0;
      const required = bucket?.required ?? requiredPerPeriod(schedule);
      // The period containing today is still in progress.
      const isCurrent = compareDateKeys(key, periodKeyFor(schedule, today)) === 0;
      if (got >= required) states.push("satisfied");
      else if (isCurrent) states.push("pending");
      else states.push("failed");
      continue;
    }

    if (hasHistory && compareDateKeys(d, first) < 0) {
      states.push("neutral");
      continue;
    }
    states.push(classifyDay(habit, versions, byDate.get(d), d, today));
  }

  // The unit describes how progress is measured *now*, for display only.
  const todaySchedule = scheduleFor(versions, today);
  const unit: StreakResult["unit"] =
    todaySchedule?.kind === "times_per_week"
      ? "weeks"
      : todaySchedule?.kind === "times_per_month"
        ? "months"
        : "days";

  // Longest streak: the longest run of satisfied, allowing neutral to be
  // passed through but not to extend the run.
  let longest = 0;
  let run = 0;
  for (const s of states) {
    if (s === "satisfied") {
      run++;
      longest = Math.max(longest, run);
    } else if (s === "neutral" || s === "pending") continue;
    else run = 0;
  }

  // Current streak: walk from the most recent period, skipping leading
  // neutral/pending states, until the first failure.
  let current = 0;
  for (const s of states) {
    if (s === "satisfied") {
      current++;
      continue;
    }
    if (s === "neutral" || s === "pending") continue;
    break;
  }

  const successes = states.filter((s) => s === "satisfied").length;
  const expected = states.filter((s) => s === "satisfied" || s === "failed").length;

  return { current, longest, unit, successes, expected };
}

/** Completion rate over a window, 0..1. */
export function completionRate(input: StreakInput): number {
  const r = computeStreak(input);
  return r.expected === 0 ? 0 : r.successes / r.expected;
}

/**
 * Values for a calendar heatmap: one entry per day, with the state that day
 * contributed. Every satisfying day is marked satisfied; period schedules are
 * evaluated per-day here, not collapsed onto the period's last day.
 */
export function heatmapDays(input: StreakInput, days: number): Array<{ date: string; state: DayState }> {
  const { habit, versions, today } = input;
  const byDate = new Map(input.entries.map((e) => [e.localDate, e]));
  // Days before the habit existed are neutral, not failures — the same rule
  // `computeStreak` applies. Without this a habit created today renders 12
  // weeks of alarming red squares.
  const first = firstTracked(input);
  // One clamp, in shared/dates: the renderer supplies this number and an
  // unbounded value allocates an array of that size on the main process.
  const span = dayCount(days, 84);
  const out: Array<{ date: string; state: DayState }> = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    if (compareDateKeys(d, first) < 0) {
      out.push({ date: d, state: "neutral" });
      continue;
    }
    out.push({ date: d, state: classifyDay(habit, versions, byDate.get(d), d, today) });
  }
  return out;
}
