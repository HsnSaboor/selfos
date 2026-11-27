/**
 * Habits service: CRUD + entry logging + streak reads (PRD §5.3).
 *
 * Streak math lives in `streak.ts` and is pure; this file only loads rows and
 * delegates. Nothing here stores a streak — it is always recomputed (D-03).
 */

import { addDays, localDateKey } from "../../../shared/dates";
import { isComplete } from "../../../shared/habits";
import type { Db } from "../../db/driver";
import {
  isoWeekday,
  parseWeekdays,
  periodKeyFor,
  type ScheduleKind,
  type ScheduleVersion,
  scheduleFor,
} from "./schedule";
import {
  completionRate,
  computeStreak,
  type EntryStatus,
  type HabitDefinition,
  type HabitEntry,
  type HabitKind,
  heatmapDays,
  type StreakResult,
} from "./streak";

export interface HabitRow {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  icon: string | null;
  color: string | null;
  archivedAt: number | null;
}

export interface HabitWithState extends HabitRow {
  schedule: ScheduleVersion | null;
  todayEntry: HabitEntry | null;
  streak: StreakResult;
  completion7d: number;
  completion30d: number;
  completion90d: number;
  dueToday: boolean;
}

export interface NewHabit {
  name: string;
  kind: HabitKind;
  unit?: string | null;
  target?: number | null;
  icon?: string | null;
  color?: string | null;
  link?: string | null;
  remindAt?: string | null;
  schedule: {
    kind: ScheduleKind;
    weekdays?: number[] | null;
    timesPerPeriod?: number | null;
  };
}

export class HabitsService {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(today: string, includeArchived = false): HabitWithState[] {
    return this.#load(includeArchived).map(({ row: r, habit, versions, entries }) => {
      const todayEntry = entries.find((e) => e.localDate === today) ?? null;
      const schedule = scheduleFor(versions, today);

      return {
        id: habit.id,
        name: r.name,
        kind: habit.kind,
        unit: r.unit,
        target: r.target,
        icon: r.icon,
        color: r.color,
        archivedAt: r.archived_at,
        schedule,
        todayEntry,
        streak: computeStreak({ habit, versions, entries, today }),
        completion7d: completionRate({ habit, versions, entries, today, lookbackDays: 7 }),
        completion30d: completionRate({ habit, versions, entries, today, lookbackDays: 30 }),
        completion90d: completionRate({ habit, versions, entries, today, lookbackDays: 90 }),
        dueToday: this.#isDueToday(habit, schedule, today, entries),
      };
    });
  }

  /**
   * Every habit with its schedule versions and entries, loaded once.
   *
   * `list()` and `heatmaps()` both need exactly this. `heatmaps()` used to call
   * `list()` and then re-read each habit's schedules and entries, so one habit
   * toggle cost 2N+2 queries — the N+1 shape its own comment claimed was gone.
   */
  #load(includeArchived: boolean): Array<{
    row: {
      id: number;
      name: string;
      kind: string;
      unit: string | null;
      target: number | null;
      icon: string | null;
      color: string | null;
      archived_at: number | null;
    };
    habit: HabitDefinition;
    versions: ScheduleVersion[];
    entries: HabitEntry[];
  }> {
    const rows = this.#db.all<{
      id: number;
      name: string;
      kind: string;
      unit: string | null;
      target: number | null;
      icon: string | null;
      color: string | null;
      archived_at: number | null;
    }>(
      `SELECT id, name, kind, unit, target, icon, color, archived_at
         FROM habit ${includeArchived ? "" : "WHERE archived_at IS NULL"}
        ORDER BY archived_at IS NOT NULL, id`,
    );
    return rows.map((row) => {
      const habit = this.#toDefinition(row);
      return {
        row,
        habit,
        versions: this.#db.all<ScheduleVersion>(
          "SELECT * FROM habit_schedule WHERE habit_id = ? ORDER BY effective_from",
          habit.id,
        ),
        entries: this.entries(habit.id),
      };
    });
  }

  create(input: NewHabit, today: string): number {
    if (!input.name?.trim()) throw new Error("habit name is required");
    const result = this.#db.run(
      `INSERT INTO habit (name, kind, unit, target, icon, color, link, remind_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name.trim(),
      input.kind,
      input.unit ?? null,
      input.target ?? null,
      input.icon ?? null,
      input.color ?? null,
      input.link ?? null,
      input.remindAt ?? null,
      Date.now(),
    );
    const id = Number(result.lastInsertRowid);
    this.#insertSchedule(id, input.schedule, today);
    return id;
  }

  /**
   * Change a habit's schedule. Creates a new version rather than overwriting,
   * so historical streaks keep the schedule that was in effect then (D-08).
   */
  changeSchedule(habitId: number, schedule: NewHabit["schedule"], effectiveFrom: string): void {
    this.#insertSchedule(habitId, schedule, effectiveFrom);
  }

  /** Schedule versions for one habit, oldest first (D-08 audit). */
  scheduleAudit(habitId: number): Array<{
    effectiveFrom: string;
    kind: string;
    weekdays: number[] | null;
    timesPerPeriod: number | null;
  }> {
    return this.#db
      .all<{
        effective_from: string;
        kind: string;
        weekdays: string | null;
        times_per_period: number | null;
      }>(
        "SELECT effective_from, kind, weekdays, times_per_period FROM habit_schedule WHERE habit_id = ? ORDER BY effective_from",
        habitId,
      )
      .map((r) => ({
        effectiveFrom: r.effective_from,
        kind: r.kind,
        weekdays: r.weekdays ? (r.weekdays.split(",").map(Number) as number[]) : null,
        timesPerPeriod: r.times_per_period,
      }));
  }

  /** F-HABIT-11: set (or clear) a local HH:MM reminder. */
  setReminder(habitId: number, remindAt: string | null): void {
    if (remindAt !== null && !/^\d{2}:\d{2}$/.test(remindAt)) {
      throw new Error("remindAt must be HH:MM");
    }
    this.#db.run("UPDATE habit SET remind_at = ? WHERE id = ?", remindAt, habitId);
  }

  archive(habitId: number, archived: boolean): void {
    this.#db.run("UPDATE habit SET archived_at = ? WHERE id = ?", archived ? Date.now() : null, habitId);
  }

  /**
   * Log or update a day's entry. Idempotent per (habit, date) thanks to the
   * unique index; this is what makes backfill and re-taps safe (F-HABIT-10).
   */
  log(habitId: number, localDate: string, status: EntryStatus, value = 0, note?: string): void {
    this.#db.run(
      `INSERT INTO habit_entry (habit_id, local_date, value, status, note, source, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?)
       ON CONFLICT(habit_id, local_date) DO UPDATE SET
         value = excluded.value,
         status = excluded.status,
         note = excluded.note,
         source = 'manual'`,
      habitId,
      localDate,
      value,
      status,
      note ?? null,
      Date.now(),
    );
  }

  /** Remove a day's entry (un-toggle). */
  clear(habitId: number, localDate: string): void {
    this.#db.run("DELETE FROM habit_entry WHERE habit_id = ? AND local_date = ?", habitId, localDate);
  }

  /** One-tap completion for the common case, respecting habit kind. */
  toggle(habitId: number, localDate: string): { status: EntryStatus | null } {
    const row = this.#db.get<{ kind: string; target: number | null }>(
      "SELECT kind, target FROM habit WHERE id = ?",
      habitId,
    );
    if (!row) throw new Error(`habit ${habitId} not found`);

    const existing = this.#db.get<{ status: string }>(
      "SELECT status FROM habit_entry WHERE habit_id = ? AND local_date = ?",
      habitId,
      localDate,
    );

    if (existing && (existing.status === "done" || existing.status === "clean")) {
      this.clear(habitId, localDate);
      return { status: null };
    }
    if (row.kind === "avoid") {
      this.log(habitId, localDate, "clean");
      return { status: "clean" };
    }
    if (row.kind === "boolean") {
      this.log(habitId, localDate, "done");
      return { status: "done" };
    }
    // count/duration: one tap sets the full target.
    this.log(habitId, localDate, "done", row.target ?? 1);
    return { status: "done" };
  }

  /** Increment a count/duration habit by `delta`, clamped at zero. */
  increment(habitId: number, localDate: string, delta: number): { value: number; status: EntryStatus } {
    const row = this.#db.get<{ kind: string; target: number | null }>(
      "SELECT kind, target FROM habit WHERE id = ?",
      habitId,
    );
    if (!row) throw new Error(`habit ${habitId} not found`);
    const existing = this.#db.get<{ value: number }>(
      "SELECT value FROM habit_entry WHERE habit_id = ? AND local_date = ?",
      habitId,
      localDate,
    );
    const value = Math.max(0, (existing?.value ?? 0) + delta);
    const target = row.target ?? 1;
    // Decrementing to zero is "not done", not "0 of 8". Recording a zero-valued
    // `partial` made the row render as progress toward the target.
    if (value === 0) {
      this.clear(habitId, localDate);
      return { value, status: "partial" };
    }
    const status: EntryStatus = value >= target ? "done" : "partial";
    this.log(habitId, localDate, status, value);
    return { value, status };
  }

  heatmap(habitId: number, today: string, days: number) {
    const habit = this.#definition(habitId);
    const versions = this.schedules(habitId);
    const entries = this.entries(habitId);
    return heatmapDays({ habit, versions, entries, today }, days);
  }

  /**
   * Heatmaps for every habit in one pass.
   *
   * The habits screen needs one heatmap per row; calling `heatmap()` per habit
   * from the renderer made the cost of a single habit toggle scale with the
   * number of habits (N+1 over IPC). Each habit's schedule and entry rows are
   * still read once, but the whole set crosses the boundary in one call.
   */
  heatmaps(
    today: string,
    days: number,
    includeArchived = false,
  ): Record<number, ReturnType<typeof heatmapDays>> {
    const out: Record<number, ReturnType<typeof heatmapDays>> = {};
    // Archived habits are excluded by default: the screen renders name +
    // restore only, so computing 84 classifyDay calls per archived habit and
    // crossing IPC with them was pure waste (round-13).
    for (const { habit, versions, entries } of this.#load(includeArchived)) {
      out[habit.id] = heatmapDays({ habit, versions, entries, today }, days);
    }
    return out;
  }

  /**
   * F-HABIT-13: upsert linked-habit entries from module metrics.
   * `link` is "module:metric" (reading:pages, focus:hours, salah:prayers).
   */
  refreshLinked(localDate: string): number {
    const rows = this.#db.all<{ id: number; kind: string; target: number | null; link: string }>(
      "SELECT id, kind, target, link FROM habit WHERE link IS NOT NULL AND archived_at IS NULL",
    );
    let changed = 0;
    for (const h of rows) {
      let value: number | null = null;
      if (h.link === "reading:pages") {
        value =
          this.#db.get<{ n: number | null }>(
            "SELECT SUM(pages_turned) AS n FROM reading_session WHERE local_date = ?",
            localDate,
          )?.n ?? 0;
      } else if (h.link === "focus:hours") {
        const s = this.#db.get<{ ms: number }>(
          "SELECT SUM(ended_at - started_at) AS ms FROM focus_event WHERE local_date = ?",
          localDate,
        );
        value = Math.round((s?.ms ?? 0) / 3_600_000);
      } else if (h.link === "salah:prayers") {
        value =
          this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prayer_log WHERE local_date = ?", localDate)
            ?.n ?? 0;
      }
      if (value === null) continue;
      const target = h.target ?? 1;
      const status = value >= target ? "done" : value > 0 ? "partial" : "skipped";
      this.#db.run(
        `INSERT INTO habit_entry (habit_id, local_date, value, status, source, created_at)
         VALUES (?, ?, ?, ?, 'linked', ?)
         ON CONFLICT(habit_id, local_date) DO UPDATE SET
           value = excluded.value, status = excluded.status, source = 'linked'`,
        h.id,
        localDate,
        value,
        status,
        Date.now(),
      );
      changed++;
    }
    return changed;
  }

  // ── row loading ───────────────────────────────────────────────────────

  #toDefinition(r: { id: number; kind: string; target: number | null }): HabitDefinition {
    return { id: r.id, kind: r.kind as HabitKind, target: r.target };
  }

  #definition(habitId: number): HabitDefinition {
    const row = this.#db.get<{ id: number; kind: string; target: number | null }>(
      "SELECT id, kind, target FROM habit WHERE id = ?",
      habitId,
    );
    if (!row) throw new Error(`habit ${habitId} not found`);
    return this.#toDefinition(row);
  }

  schedules(habitId: number): ScheduleVersion[] {
    const rows = this.#db.all<{
      id: number;
      habit_id: number;
      effective_from: string;
      kind: string;
      weekdays: string | null;
      times_per_period: number | null;
    }>(
      `SELECT id, habit_id, effective_from, kind, weekdays, times_per_period
         FROM habit_schedule WHERE habit_id = ? ORDER BY effective_from`,
      habitId,
    );
    return rows.map((r) => ({
      id: r.id,
      habitId: r.habit_id,
      effectiveFrom: r.effective_from,
      kind: r.kind as ScheduleKind,
      weekdays: parseWeekdays(r.weekdays),
      timesPerPeriod: r.times_per_period,
    }));
  }

  entries(habitId: number): HabitEntry[] {
    // Bound the read: streak/heatmap need at most 400 days, and an unbounded
    // scan grows with every year the user keeps the habit (round-13).
    const since = addDays(localDateKey(new Date()), -400);
    const rows = this.#db.all<{ local_date: string; value: number; status: string }>(
      "SELECT local_date, value, status FROM habit_entry WHERE habit_id = ? AND local_date >= ? ORDER BY local_date",
      habitId,
      since,
    );
    return rows.map((r) => ({
      localDate: r.local_date,
      value: r.value,
      status: r.status as EntryStatus,
    }));
  }

  #insertSchedule(habitId: number, s: NewHabit["schedule"], effectiveFrom: string): void {
    // `habit_schedule` is unique on (habit_id, effective_from). A version is
    // immutable: changing a schedule that already has a version for today takes
    // effect **tomorrow**, so no past day is reinterpreted (D-08). The old
    // implementation moved the previous version one day earlier, which rewrote
    // the previous day instead, and a second same-day change fell through to
    // `ON CONFLICT … DO UPDATE` and overwrote today's version (round-13).
    let from = effectiveFrom;
    const occupied = (date: string) =>
      this.#db.get<{ id: number }>(
        "SELECT id FROM habit_schedule WHERE habit_id = ? AND effective_from = ?",
        habitId,
        date,
      );
    if (occupied(from)) {
      from = addDays(from, 1);
      // A future version may already sit on that date; keep walking so no
      // version is ever overwritten (bounded, the calendar is finite).
      for (let i = 0; i < 366 && occupied(from); i++) from = addDays(from, 1);
    }

    this.#db.run(
      `INSERT INTO habit_schedule (habit_id, effective_from, kind, weekdays, times_per_period, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      habitId,
      from,
      s.kind,
      s.weekdays?.length ? s.weekdays.join(",") : null,
      s.timesPerPeriod ?? null,
      Date.now(),
    );
  }

  #isDueToday(
    habit: HabitDefinition,
    schedule: ScheduleVersion | null,
    today: string,
    entries: HabitEntry[],
  ): boolean {
    if (!schedule) return false;
    if (schedule.kind === "daily") return true;
    if (schedule.kind === "weekdays") {
      return (schedule.weekdays ?? []).includes(isoWeekday(today));
    }
    // Period schedules: still due until the period's quota is met.
    const needed = schedule.timesPerPeriod ?? 1;
    const currentPeriod = periodKeyFor(schedule, today);
    const done = entries.filter(
      (e) => isComplete(habit, e) && periodKeyFor(schedule, e.localDate) === currentPeriod,
    ).length;
    return done < needed;
  }
}
