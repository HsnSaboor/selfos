/**
 * Goals service (PRD §5.7, STACK §11).
 *
 * Reads rows, delegates every derived number to `model.ts`, and writes only
 * through explicit, validated operations. Deleting a goal is not offered:
 * closing it keeps history (F-GOAL-07).
 */

import { isDateKey, localDateKey } from "../../../shared/dates";
import type { Db } from "../../db/driver";
import {
  computePace,
  currentValue,
  type GoalInput,
  type GoalRow,
  type GoalStatus,
  type MilestoneRow,
  milestoneValue,
  type Pace,
  type ProgressRow,
  rollupFraction,
  targetValue,
  validateGoalInput,
} from "./model";

export interface MilestoneView {
  id: number;
  title: string;
  dueDate: string | null;
  doneAt: number | null;
  sort: number;
  overdue: boolean;
}

export interface ProgressView {
  id: number;
  at: number;
  value: number;
  source: string;
  note: string | null;
}

export interface GoalView {
  id: number;
  title: string;
  description: string | null;
  kind: GoalRow["kind"];
  status: GoalStatus;
  unit: string | null;
  startDate: string;
  targetDate: string | null;
  parentId: number | null;
  closeReason: string | null;
  closedAt: number | null;
  value: number;
  target: number | null;
  pace: Pace;
  milestones: MilestoneView[];
  milestonesDone: number;
  milestonesTotal: number;
  /** Mean of child fractions when this goal has children (F-GOAL-08). */
  rollup: number | null;
  childCount: number;
  /** Most recent contributions, newest first (F-GOAL-09). */
  contributions: ProgressView[];
}

export class GoalsService {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(opts: { includeClosed?: boolean; today?: string } = {}): GoalView[] {
    const today = opts.today ?? localDateKey(new Date());
    const rows = this.#db.all<GoalRow>(
      opts.includeClosed
        ? "SELECT * FROM goal ORDER BY status = 'active' DESC, target_date IS NULL, target_date, id"
        : "SELECT * FROM goal WHERE status = 'active' ORDER BY target_date IS NULL, target_date, id",
    );
    const all = rows.map((r) => this.#view(r, today));
    // Children are included in their own right, so the list is complete; the
    // rollup on a parent is computed from the children that are also active.
    return all;
  }

  get(id: number, today?: string): GoalView | null {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", id);
    return row ? this.#view(row, today ?? localDateKey(new Date())) : null;
  }

  create(input: Partial<GoalInput>, today = localDateKey(new Date())): number {
    const valid = validateGoalInput({ ...input, startDate: input.startDate ?? today });
    if (valid.parentId !== null) {
      const parent = this.#db.get<GoalRow>("SELECT id FROM goal WHERE id = ?", valid.parentId);
      if (!parent) throw new Error("parent goal not found");
    }
    const res = this.#db.run(
      `INSERT INTO goal (title, description, kind, target_value, unit, start_date, target_date,
                         status, source, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'manual', ?, ?)`,
      valid.title,
      valid.description ?? null,
      valid.kind,
      valid.targetValue,
      valid.unit,
      valid.startDate,
      valid.targetDate,
      valid.parentId,
      Date.now(),
    );
    return Number(res.lastInsertRowid);
  }

  /** Edit the descriptive fields. Kind and start date are immutable. */
  update(
    id: number,
    patch: Partial<Pick<GoalInput, "title" | "description" | "targetValue" | "unit" | "targetDate">>,
  ): void {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", id);
    if (!row) throw new Error("goal not found");

    const title = patch.title?.trim() ?? row.title;
    if (!title) throw new Error("title is required");
    const targetDate = patch.targetDate === undefined ? row.target_date : patch.targetDate;
    if (targetDate !== null) {
      // isDateKey, as in validateGoalInput: the shape regex accepts 2026-13-45.
      if (!isDateKey(targetDate)) throw new Error("targetDate must be a real YYYY-MM-DD date");
      if (targetDate < row.start_date) throw new Error("targetDate is before startDate");
    }
    if (patch.targetValue !== undefined && patch.targetValue !== null) {
      if (!Number.isFinite(patch.targetValue) || patch.targetValue <= 0) {
        throw new Error("targetValue must be a positive number");
      }
    }

    this.#db.run(
      "UPDATE goal SET title = ?, description = ?, target_value = ?, unit = ?, target_date = ? WHERE id = ?",
      title,
      patch.description === undefined ? row.description : patch.description || null,
      patch.targetValue === undefined ? row.target_value : patch.targetValue,
      patch.unit === undefined ? row.unit : patch.unit || null,
      targetDate,
      id,
    );
  }

  /** Record a manual reading. Values are absolute, not deltas (F-GOAL-02). */
  record(id: number, value: number, note?: string): void {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", id);
    if (!row) throw new Error("goal not found");
    if (row.status !== "active") throw new Error("goal is closed");
    if (row.kind === "milestone") throw new Error("milestone goals progress through their checklist");
    if (!Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative number");

    this.#db.transaction(() => {
      this.#db.run(
        "INSERT INTO goal_progress (goal_id, at, value, source, note) VALUES (?, ?, ?, 'manual', ?)",
        id,
        Date.now(),
        value,
        note ?? null,
      );
      // Auto-complete when the target is reached; the goal stays visible until
      // the user closes it, so the moment is recorded but not hidden.
      if (row.target_value !== null && value >= row.target_value) {
        this.#db.run(
          "UPDATE goal SET status = 'completed', closed_at = ?, close_reason = 'target reached' WHERE id = ? AND status = 'active'",
          Date.now(),
          id,
        );
      }
    });
  }

  addMilestone(goalId: number, title: string, dueDate?: string | null): number {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", goalId);
    if (!row) throw new Error("goal not found");
    const clean = title.trim();
    if (!clean) throw new Error("title is required");
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error("dueDate must be YYYY-MM-DD");

    const next = this.#db.get<{ n: number | null }>(
      "SELECT MAX(sort) AS n FROM goal_milestone WHERE goal_id = ?",
      goalId,
    );
    const res = this.#db.run(
      "INSERT INTO goal_milestone (goal_id, title, due_date, sort) VALUES (?, ?, ?, ?)",
      goalId,
      clean,
      dueDate ?? null,
      (next?.n ?? -1) + 1,
    );
    return Number(res.lastInsertRowid);
  }

  setMilestone(id: number, done: boolean): void {
    const m = this.#db.get<MilestoneRow>("SELECT * FROM goal_milestone WHERE id = ?", id);
    if (!m) throw new Error("milestone not found");
    this.#db.run("UPDATE goal_milestone SET done_at = ? WHERE id = ?", done ? Date.now() : null, id);

    // Completing the last milestone completes the goal; un-ticking reopens it.
    const goal = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", m.goal_id);
    if (!goal) return;
    const counts = this.#db.get<{ done: number; total: number }>(
      "SELECT SUM(CASE WHEN done_at IS NOT NULL THEN 1 ELSE 0 END) AS done, COUNT(*) AS total FROM goal_milestone WHERE goal_id = ?",
      m.goal_id,
    );
    if (!counts || counts.total === 0) return;
    if (counts.done === counts.total && goal.status === "active") {
      this.#db.run(
        "UPDATE goal SET status = 'completed', closed_at = ?, close_reason = 'all milestones done' WHERE id = ?",
        Date.now(),
        m.goal_id,
      );
    } else if (counts.done < counts.total && goal.status === "completed") {
      this.#db.run(
        "UPDATE goal SET status = 'active', closed_at = NULL, close_reason = NULL WHERE id = ?",
        m.goal_id,
      );
    }
  }

  removeMilestone(id: number): void {
    this.#db.run("DELETE FROM goal_milestone WHERE id = ?", id);
  }

  /** Complete or abandon. History is kept; the reason is recorded. */
  close(id: number, status: "completed" | "abandoned", reason?: string): void {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", id);
    if (!row) throw new Error("goal not found");
    if (row.status !== "active") throw new Error("goal is already closed");
    this.#db.run(
      "UPDATE goal SET status = ?, closed_at = ?, close_reason = ? WHERE id = ?",
      status,
      Date.now(),
      reason?.trim() || null,
      id,
    );
    // A closed parent cannot keep active children, or the roll-up would point
    // at a goal that no longer appears anywhere.
    if (status === "abandoned") {
      this.#db.run(
        "UPDATE goal SET status = 'abandoned', closed_at = ?, close_reason = 'parent abandoned' WHERE parent_id = ? AND status = 'active'",
        Date.now(),
        id,
      );
    }
  }

  reopen(id: number): void {
    const row = this.#db.get<GoalRow>("SELECT * FROM goal WHERE id = ?", id);
    if (!row) throw new Error("goal not found");
    if (row.status === "active") return;
    this.#db.run("UPDATE goal SET status = 'active', closed_at = NULL, close_reason = NULL WHERE id = ?", id);
  }

  /** Raw contributions for one goal (F-GOAL-09). */
  contributions(id: number, limit = 50): ProgressView[] {
    return this.#db
      .all<ProgressRow>(
        "SELECT * FROM goal_progress WHERE goal_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        id,
        limit,
      )
      .map((r) => ({ id: r.id, at: r.at, value: r.value, source: r.source, note: r.note }));
  }

  // ── internals ─────────────────────────────────────────────────────────

  #view(row: GoalRow, today: string): GoalView {
    const milestones = this.#db.all<MilestoneRow>(
      "SELECT * FROM goal_milestone WHERE goal_id = ? ORDER BY sort, id",
      row.id,
    );
    const progress = this.#db.all<ProgressRow>(
      "SELECT * FROM goal_progress WHERE goal_id = ? ORDER BY at DESC, id DESC LIMIT 50",
      row.id,
    );
    const value = currentValue(row, milestones, progress);
    const target = targetValue(row, milestones);
    const counts = milestoneValue(milestones);

    // Completed children still count toward the roll-up: excluding them would
    // make a parent's percentage *fall* when a child is finished. Abandoned
    // children are excluded because they no longer contribute.
    const children = this.#db.all<GoalRow>(
      "SELECT * FROM goal WHERE parent_id = ? AND status != 'abandoned'",
      row.id,
    );
    const childViews = children.map((c) => this.#view(c, today));

    const pace = computePace({
      startDate: row.start_date,
      targetDate: row.target_date,
      today,
      value,
      target,
    });

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      kind: row.kind,
      status: row.status,
      unit: row.unit,
      startDate: row.start_date,
      targetDate: row.target_date,
      parentId: row.parent_id,
      closeReason: row.close_reason,
      closedAt: row.closed_at,
      value,
      target,
      pace,
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        dueDate: m.due_date,
        doneAt: m.done_at,
        sort: m.sort,
        overdue: m.done_at === null && m.due_date !== null && m.due_date < today,
      })),
      milestonesDone: counts.done,
      milestonesTotal: counts.total,
      rollup:
        childViews.length > 0
          ? rollupFraction(
              childViews.map((c) => ({
                fraction: c.rollup ?? c.pace.fraction,
                hasTarget: c.target !== null,
              })),
            )
          : null,
      childCount: childViews.length,
      contributions: progress.map((p) => ({
        id: p.id,
        at: p.at,
        value: p.value,
        source: p.source,
        note: p.note,
      })),
    };
  }
}
