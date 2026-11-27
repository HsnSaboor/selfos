/**
 * One definition of "this habit day counts as complete" (F-DASH-03,
 * F-HABIT-14).
 *
 * The streak, the dashboard KPI, the per-habit ring and the period quota each
 * had their own copy, and they disagreed: a count habit at value ≥ target was
 * satisfied for the streak but not for the KPI. All four now call this.
 */
import type { EntryStatus, HabitKind } from "./api";

export interface HabitLike {
  kind: HabitKind;
  target: number | null;
}

export interface EntryLike {
  value: number;
  status: EntryStatus;
}

export function isComplete(habit: HabitLike, entry: EntryLike | undefined | null): boolean {
  if (!entry) return false;
  switch (habit.kind) {
    case "boolean":
      return entry.status === "done";
    case "count":
    case "duration": {
      const target = habit.target ?? 1;
      return entry.status === "done" || entry.value >= target;
    }
    case "avoid":
      return entry.status === "clean" || entry.status === "done";
  }
}
