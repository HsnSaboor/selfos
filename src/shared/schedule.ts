/**
 * Schedule formatting shared by main and the renderer.
 *
 * Both sides describe the same `ScheduleKind` union, and they had drifted: the
 * main-process copy returned `"—"` for empty weekdays while the renderer's
 * returned `"?"` per unknown index. One implementation, imported by both.
 */

import type { ScheduleKind } from "./api";

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface ScheduleShape {
  kind: ScheduleKind;
  weekdays?: number[] | null;
  timesPerPeriod?: number | null;
}

/** ISO-8601 day of week: Monday = 1 … Sunday = 7. */
export function isoWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

/** `Mon, Wed` from 1-based weekday numbers; `—` when none are set. */
export function formatWeekdays(days: number[] | null | undefined): string {
  if (!days || days.length === 0) return "—";
  return days.map((d) => WEEKDAY_LABELS[d - 1] ?? "?").join(", ");
}

/** Human description of a schedule, used in the UI. */
export function describeSchedule(s: ScheduleShape | null | undefined): string {
  if (!s) return "No schedule";
  switch (s.kind) {
    case "daily":
      return "Every day";
    case "weekdays":
      return formatWeekdays(s.weekdays);
    case "times_per_week":
      return `${s.timesPerPeriod ?? 1}× per week`;
    case "times_per_month":
      return `${s.timesPerPeriod ?? 1}× per month`;
  }
}
