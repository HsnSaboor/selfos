/**
 * Dashboard day summary (PRD F-DASH-01..03).
 *
 * The business rules here used to live inside `Services`, which made the
 * composition root the only place that could compute the dashboard's numbers
 * and the only place they could be tested. They are pure functions over rows
 * and views: the caller does the three reads, this module decides what they
 * mean.
 */
import type { DaySummary, HabitView } from "../../../shared/api";
import { isComplete } from "../../../shared/habits";

export interface DayAggregateRow {
  screen_seconds: number;
  focused_seconds: number;
  media_seconds: number;
  reading_seconds: number;
  first_activity: number | null;
  last_activity: number | null;
  switches: number;
  focus_sessions?: number;
  longest_focus_seconds?: number;
}

export interface DaySummaryInput {
  localDate: string;
  agg: DayAggregateRow | undefined;
  habitStates: HabitView[];
  prayersLogged: number;
  hijri: string;
  hijriSource: DaySummary["hijriSource"];
  /** Browser watch time for the same day (local-player time is in `agg`). */
  watchSeconds: number;
}

/**
 * One day's dashboard numbers.
 *
 * The habits denominator is the habits *due* that day, from their schedules —
 * not the number of `habit_entry` rows, which counts only what was logged.
 * Using entries reported "1/2" for five daily habits with one done and one
 * skipped, and "1/1" (100%) when a single habit was completed (wave-1 #4).
 */
export function summarizeDay(input: DaySummaryInput): DaySummary {
  const dueToday = input.habitStates.filter((h) => h.dueToday);
  const done = dueToday.filter((h) => isComplete(h, h.todayEntry)).length;
  const bestStreak = input.habitStates.reduce((max, h) => Math.max(max, h.streak.current), 0);
  const agg = input.agg;

  return {
    localDate: input.localDate,
    hijri: input.hijri,
    hijriSource: input.hijriSource,
    screenSeconds: agg?.screen_seconds ?? 0,
    focusedSeconds: agg?.focused_seconds ?? 0,
    // Local players only; browser watch time is added below.
    mediaSeconds: agg?.media_seconds ?? 0,
    // F-TIME-06: a distinct daily watch total, local player + browser. The two
    // sets are disjoint by construction (local classes vs browser domains), so
    // the sum is the union.
    watchSeconds: (agg?.media_seconds ?? 0) + Math.max(0, Math.round(input.watchSeconds)),
    readingSeconds: agg?.reading_seconds ?? 0,
    habitsDone: done,
    habitsTotal: dueToday.length,
    prayersLogged: input.prayersLogged,
    bestStreak,
    firstActivity: agg?.first_activity ?? null,
    lastActivity: agg?.last_activity ?? null,
    switches: agg?.switches ?? 0,
    focusSessions: agg?.focus_sessions ?? 0,
    longestFocusSeconds: agg?.longest_focus_seconds ?? 0,
  };
}

/** Rebuild every day that has raw events (F-SET-07 "rebuild derived data"). */
export function daysToRebuild(db: { all<T>(sql: string, ...params: unknown[]): T[] }): string[] {
  const rows = db.all<{ local_date: string }>(
    `SELECT local_date FROM (
       SELECT local_date FROM focus_event
       UNION SELECT local_date FROM browser_visit
       UNION SELECT local_date FROM reading_session
     ) ORDER BY local_date`,
  );
  return rows.map((r) => r.local_date);
}
