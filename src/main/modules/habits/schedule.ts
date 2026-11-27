/**
 * Habit schedules (PRD F-HABIT-06, D-08).
 *
 * A schedule is *versioned*: `habit_schedule` rows each carry an
 * `effective_from` date, and the schedule for a given day is the most recent
 * version at or before that day. This is what makes historical streaks
 * correct after the user changes a habit's cadence.
 *
 * Pure functions only — no DB, no Date.now().
 */

import type { ScheduleKind } from "../../../shared/api";

export type { ScheduleKind };

export interface ScheduleVersion {
  id: number;
  habitId: number;
  /** local_date (YYYY-MM-DD) this version applies from. */
  effectiveFrom: string;
  kind: ScheduleKind;
  /** ISO weekday numbers 1..7 (Mon..Sun), only for `weekdays`. */
  weekdays: number[] | null;
  timesPerPeriod: number | null;
}

// Shared with the renderer (src/shared/schedule.ts).
import { isoWeekday } from "../../../shared/schedule";

export { isoWeekday };

/** Monday of the week containing `dateKey`, as YYYY-MM-DD. */
export function weekStart(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const base = new Date(Date.UTC(y, m - 1, d));
  const shift = isoWeekday(dateKey) - 1;
  base.setUTCDate(base.getUTCDate() - shift);
  return base.toISOString().slice(0, 10);
}

export function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The schedule version in effect on `dateKey`.
 * `versions` need not be sorted; the latest `effectiveFrom <= dateKey` wins.
 *
 * Dates *before* the first version fall back to the earliest version. Without
 * this, backfilling a habit on the day it was created would silently count for
 * nothing, because the schedule only starts today (F-HABIT-10). The caller
 * decides how far back that fallback may reach — see `firstTracked` in
 * `streak.ts`.
 */
export function scheduleFor(versions: ScheduleVersion[], dateKey: string): ScheduleVersion | null {
  if (versions.length === 0) return null;
  let best: ScheduleVersion | null = null;
  let earliest: ScheduleVersion | null = null;
  for (const v of versions) {
    if (!earliest || compareDateKeys(v.effectiveFrom, earliest.effectiveFrom) < 0) earliest = v;
    if (compareDateKeys(v.effectiveFrom, dateKey) > 0) continue;
    if (!best || compareDateKeys(v.effectiveFrom, best.effectiveFrom) > 0) best = v;
  }
  return best ?? earliest;
}

/**
 * Is the habit *due* on this date?
 * Period-based schedules (times per week/month) are not due on any single day —
 * they are satisfied by accumulating entries within the period — so this
 * returns false for them and callers use `periodKeyFor` instead.
 */
export function isDueOn(schedule: ScheduleVersion, dateKey: string): boolean {
  switch (schedule.kind) {
    case "daily":
      return true;
    case "weekdays":
      return (schedule.weekdays ?? []).includes(isoWeekday(dateKey));
    case "times_per_week":
    case "times_per_month":
      return false;
  }
}

/**
 * The period a date belongs to. Day-based schedules have a one-day period, so
 * the period key is the date itself; this lets one streak algorithm serve both.
 */
export function periodKeyFor(schedule: ScheduleVersion, dateKey: string): string {
  switch (schedule.kind) {
    case "times_per_week":
      return weekStart(dateKey);
    case "times_per_month":
      return monthStart(dateKey);
    default:
      return dateKey;
  }
}

/** How many successes a period needs. */
export function requiredPerPeriod(schedule: ScheduleVersion): number {
  switch (schedule.kind) {
    case "daily":
    case "weekdays":
      return 1;
    case "times_per_week":
    case "times_per_month":
      return Math.max(1, schedule.timesPerPeriod ?? 1);
  }
}

/** The period immediately before `periodKey` under the same schedule. */
export function previousPeriod(schedule: ScheduleVersion, periodKey: string): string {
  switch (schedule.kind) {
    case "times_per_week":
      return addDays(periodKey, -7);
    case "times_per_month": {
      const [y, m] = periodKey.split("-").map(Number) as [number, number];
      const prev = new Date(Date.UTC(y, m - 2, 1));
      return `${prev.toISOString().slice(0, 7)}-01`;
    }
    default:
      return addDays(periodKey, -1);
  }
}

/** Parse "1,3,5" into ISO weekdays, ignoring junk. */
export function parseWeekdays(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  const days = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : null;
}

// One implementation, shared with the renderer (src/shared/schedule.ts).
export { describeSchedule } from "../../../shared/schedule";
