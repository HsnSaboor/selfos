import { useCallback, useEffect, useState } from "react";
import type { GoalKindView, GoalView, Result } from "../../../shared/api";

import { formatDayMonth, formatLongDate } from "../../../shared/format";

const KIND_LABEL: Record<GoalKindView, string> = {
  numeric: "Numeric target",
  milestone: "Milestone checklist",
  quota: "Recurring quota",
};

function fmtValue(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function Ring({ fraction, offPace, label }: { fraction: number; offPace: boolean; label: string }) {
  const pct = Math.round(fraction * 100);
  return (
    <div className={`goal-ring${offPace ? " off" : ""}`} title={label}>
      <svg viewBox="0 0 36 36" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="18" cy="18" r="15.5" className="ring-bg" />
        {/* A zero-length dash with a round cap still paints a dot, so an empty
            ring renders no foreground arc at all. */}
        {fraction > 0 ? (
          <circle cx="18" cy="18" r="15.5" className="ring-fg" strokeDasharray={`${fraction * 97.4} 97.4`} />
        ) : null}
      </svg>
      <span>{pct}%</span>
    </div>
  );
}

function paceText(g: GoalView): string {
  const p = g.pace;
  if (g.target === null) return "No target set";
  if (p.fraction >= 1) return "Target reached";
  if (p.projectedDate === null) return "No progress yet — add a reading";
  if (p.daysRemaining === null) {
    return `On pace to finish ${formatLongDate(p.projectedDate)}`;
  }
  if (p.deltaDays === null) return `Projected ${formatLongDate(p.projectedDate)}`;
  if (p.deltaDays >= 0) {
    return `On pace — ${p.deltaDays} day${p.deltaDays === 1 ? "" : "s"} to spare (${formatLongDate(p.projectedDate)})`;
  }
  return `Behind by ${Math.abs(p.deltaDays)} day${Math.abs(p.deltaDays) === 1 ? "" : "s"} — projected ${formatLongDate(p.projectedDate)}`;
}

function GoalCard({
  goal,
  busy,
  onRecord,
  onToggleMilestone,
  onAddMilestone,
  onClose,
  onReopen,
}: {
  goal: GoalView;
  busy: boolean;
  onRecord: (value: number, note?: string) => void;
  onToggleMilestone: (id: number, done: boolean) => void;
  onAddMilestone: (title: string, dueDate: string | null) => void;
  onClose: (status: "completed" | "abandoned", reason?: string) => void;
  onReopen: () => void;
}) {
  const [reading, setReading] = useState("");
  const [milestone, setMilestone] = useState("");
  const [due, setDue] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  // Electron does not implement `window.prompt` (it throws "prompt() is not
  // supported"), so the abandon reason is collected with an inline field.
  const [abandoning, setAbandoning] = useState(false);
  const [abandonReason, setAbandonReason] = useState("");

  const unit = goal.unit ? ` ${goal.unit}` : "";
  const closed = goal.status !== "active";

  return (
    <article className={`goal-card${closed ? " closed" : ""}${goal.pace.offPace ? " at-risk" : ""}`}>
      <div className="goal-card-head">
        <div className="goal-card-title">
          <h3>{goal.title}</h3>
          <div className="goal-meta">
            {KIND_LABEL[goal.kind]}
            {goal.targetDate ? ` · due ${formatLongDate(goal.targetDate)}` : ""}
            {goal.status === "completed" ? " · completed" : ""}
            {goal.status === "abandoned" ? " · abandoned" : ""}
          </div>
        </div>
        <Ring
          fraction={goal.pace.fraction}
          offPace={goal.pace.offPace}
          label={`${Math.round(goal.pace.fraction * 100)}% of ${fmtValue(goal.target ?? 0)}${unit}`}
        />
      </div>

      {goal.description ? <p className="goal-desc">{goal.description}</p> : null}

      <div className="goal-numbers">
        <strong>
          {fmtValue(goal.value)}
          {unit}
        </strong>
        <span className="muted"> / {goal.target === null ? "—" : `${fmtValue(goal.target)}${unit}`}</span>
        {goal.pace.remaining > 0 ? (
          <span className="muted"> · {fmtValue(goal.pace.remaining)} to go</span>
        ) : null}
        {goal.pace.daysRemaining !== null ? (
          <span className="muted">
            {goal.pace.daysRemaining >= 0
              ? ` · ${goal.pace.daysRemaining} day${goal.pace.daysRemaining === 1 ? "" : "s"} left`
              : ` · ${Math.abs(goal.pace.daysRemaining)} day${Math.abs(goal.pace.daysRemaining) === 1 ? "" : "s"} overdue`}
          </span>
        ) : null}
      </div>

      <div className={`goal-pace${goal.pace.offPace ? " bad" : ""}`}>{paceText(goal)}</div>

      {goal.rollup !== null ? (
        <div className="goal-rollup">
          {goal.childCount} sub-goal{goal.childCount === 1 ? "" : "s"} · {Math.round(goal.rollup * 100)}%
          average
        </div>
      ) : null}

      {goal.kind === "milestone" ? (
        <div className="goal-milestones">
          {goal.milestones.map((m) => (
            <label key={m.id} className={`goal-milestone${m.overdue ? " overdue" : ""}`}>
              <input
                type="checkbox"
                checked={m.doneAt !== null}
                disabled={busy}
                onChange={(e) => onToggleMilestone(m.id, e.target.checked)}
              />
              <span className={m.doneAt !== null ? "done" : ""}>{m.title}</span>
              {m.dueDate ? <span className="goal-due">{formatLongDate(m.dueDate)}</span> : null}
            </label>
          ))}
          {goal.milestones.length === 0 ? <div className="muted">No milestones yet.</div> : null}
          {!closed ? (
            <div className="form-row goal-add-milestone">
              <input
                className="input grow"
                placeholder="Add a milestone…"
                value={milestone}
                onChange={(e) => setMilestone(e.target.value)}
                aria-label="Milestone title"
              />
              <input
                className="input"
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                aria-label="Milestone due date"
              />
              <button
                type="button"
                className="ghost"
                disabled={busy || !milestone.trim()}
                onClick={() => {
                  onAddMilestone(milestone.trim(), due || null);
                  setMilestone("");
                  setDue("");
                }}
              >
                Add
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {goal.kind !== "milestone" && !closed ? (
        <div className="form-row goal-record">
          <input
            className="input narrow"
            type="number"
            min={0}
            step="any"
            placeholder="Value"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            aria-label="Current value"
          />
          <button
            type="button"
            className="primary"
            disabled={busy || reading === ""}
            onClick={() => {
              onRecord(Number(reading));
              setReading("");
            }}
          >
            Update
          </button>
          <span className="muted">absolute value, not an increment</span>
        </div>
      ) : null}

      {goal.contributions.length > 0 ? (
        <div className="goal-history">
          <button type="button" className="link" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Hide" : "Show"} {goal.contributions.length} contribution
            {goal.contributions.length === 1 ? "" : "s"}
          </button>
          {showHistory ? (
            <ul>
              {goal.contributions.map((c) => (
                <li key={c.id}>
                  <span className="muted">{formatDayMonth(c.at)}</span> {fmtValue(c.value)}
                  {unit}
                  {c.note ? <span className="muted"> — {c.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="goal-actions">
        {closed ? (
          <>
            <span className="muted">{goal.closeReason ?? "closed"}</span>
            <button type="button" className="ghost" onClick={onReopen} disabled={busy}>
              Reopen
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost" onClick={() => onClose("completed")} disabled={busy}>
              Mark complete
            </button>
            {abandoning ? (
              <form
                className="goal-abandon"
                onSubmit={(e) => {
                  e.preventDefault();
                  onClose("abandoned", abandonReason.trim() || undefined);
                  setAbandoning(false);
                }}
              >
                <input
                  className="input"
                  ref={(el) => el?.focus()}
                  value={abandonReason}
                  onChange={(e) => setAbandonReason(e.target.value)}
                  placeholder="Why are you abandoning this goal?"
                  aria-label="Reason for abandoning this goal"
                />
                <button type="submit" className="mini" disabled={busy}>
                  Abandon
                </button>
                <button type="button" className="mini" onClick={() => setAbandoning(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button type="button" className="ghost" onClick={() => setAbandoning(true)} disabled={busy}>
                Abandon
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function NewGoalForm({
  goals,
  onCreated,
  today,
}: {
  goals: GoalView[];
  onCreated: () => void;
  today: string;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<GoalKindView>("numeric");
  const [target, setTarget] = useState("");
  const [unit, setUnit] = useState("");
  // Seeded from the App's rollover state, not `todayKey()` captured at mount: a
  // window left open across midnight would otherwise default a new goal to
  // yesterday, which is the bug the App's 30 s rollover exists to prevent.
  const [start, setStart] = useState(today);
  const [due, setDue] = useState("");
  const [parent, setParent] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    const res = await window.selfos.invoke("goals.create", {
      title,
      // F-GOAL-01 lists description among the fields a goal is created with.
      // The card already rendered it and `goals.update` could set it, but that
      // channel has no renderer caller and the create form had no input — so
      // the field was permanently null through the UI.
      ...(description.trim() ? { description: description.trim() } : {}),
      kind,
      targetValue: kind === "milestone" ? null : target === "" ? null : Number(target),
      unit: unit || null,
      startDate: start,
      targetDate: due || null,
      parentId: parent === "" ? null : parent,
    });
    setBusy(false);
    if (res.ok) {
      setTitle("");
      setDescription("");
      setTarget("");
      setUnit("");
      setDue("");
      setParent("");
      setError(null);
      onCreated();
    } else setError(res.error);
  };

  return (
    <div className="habit-form">
      <div className="form-row">
        <input
          className="input grow"
          placeholder="Goal title — e.g. Read 12 books this year"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Goal title"
        />
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as GoalKindView)}
          aria-label="Goal kind"
        >
          <option value="numeric">Numeric target</option>
          <option value="milestone">Milestone checklist</option>
          <option value="quota">Recurring quota</option>
        </select>
      </div>

      <div className="form-row">
        <input
          className="input grow"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="Goal description"
        />
      </div>

      <div className="form-row">
        <label className="field">
          <span>Starts</span>
          <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field">
          <span>Target date</span>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        {kind !== "milestone" ? (
          <>
            <label className="field">
              <span>Target</span>
              <input
                className="input narrow"
                type="number"
                min={1}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="12"
              />
            </label>
            <label className="field">
              <span>Unit</span>
              <input
                className="input narrow"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="books"
              />
            </label>
          </>
        ) : null}
        <label className="field">
          <span>Parent</span>
          <select
            className="input"
            value={parent}
            onChange={(e) => setParent(e.target.value === "" ? "" : Number(e.target.value))}
          >
            <option value="">None</option>
            {goals
              .filter((g) => g.parentId === null)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
        >
          Add goal
        </button>
      </div>

      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

export function GoalsView({ localDate }: { localDate: string }) {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await window.selfos.invoke("goals.list", { includeClosed: showClosed });
    if (res.ok) {
      setGoals(res.data);
      setError(null);
    } else setError(res.error);
  }, [showClosed]);

  useEffect(() => {
    void load();
  }, [load]);

  // See Habits: use the bridge's `Result` rather than a structural copy.
  const act = async (fn: () => Promise<Result<unknown>>) => {
    setBusy(true);
    const res = await fn();
    await load();
    setBusy(false);
    if (!res.ok) setError(res.error);
  };

  const active = goals.filter((g) => g.status === "active");
  const atRisk = active.filter((g) => g.pace.offPace);
  // `goals` only contains closed rows when "show closed" is on, so this count is
  // necessarily scoped to the visible list — label it that way rather than
  // implying it is the all-time total.
  const done = goals.filter((g) => g.status === "completed").length;
  // Only top-level goals get a card; children show through their parent's rollup.
  const roots = goals.filter((g) => g.parentId === null);
  const childrenOf = (id: number) => goals.filter((g) => g.parentId === id);

  return (
    <div className="goals">
      <div className="habits-head">
        <div>
          <h2>Goals</h2>
          <div className="muted">
            {active.length} active
            {atRisk.length > 0 ? ` · ${atRisk.length} off pace` : ""}
            {done > 0 ? ` · ${done} completed shown` : ""}
          </div>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed
        </label>
      </div>

      {error ? <div className="error">Goals error: {error}</div> : null}

      <NewGoalForm goals={active} onCreated={() => void load()} today={localDate} />

      {roots.length === 0 ? (
        <div className="empty">No goals yet. Add one above to start tracking pace.</div>
      ) : null}

      <div className="goal-list">
        {roots.map((g) => (
          <div key={g.id} className="goal-block">
            <GoalCard
              goal={g}
              busy={busy}
              onRecord={(value, note) =>
                void act(() => window.selfos.invoke("goals.record", { goalId: g.id, value, note }))
              }
              onToggleMilestone={(id, isDone) =>
                void act(() => window.selfos.invoke("goals.setMilestone", { milestoneId: id, done: isDone }))
              }
              onAddMilestone={(title, dueDate) =>
                void act(() => window.selfos.invoke("goals.addMilestone", { goalId: g.id, title, dueDate }))
              }
              onClose={(status, reason) =>
                void act(() => window.selfos.invoke("goals.close", { goalId: g.id, status, reason }))
              }
              onReopen={() => void act(() => window.selfos.invoke("goals.reopen", { goalId: g.id }))}
            />
            {childrenOf(g.id).length > 0 ? (
              <div className="goal-children">
                {childrenOf(g.id).map((c) => (
                  <GoalCard
                    key={c.id}
                    goal={c}
                    busy={busy}
                    onRecord={(value, note) =>
                      void act(() => window.selfos.invoke("goals.record", { goalId: c.id, value, note }))
                    }
                    onToggleMilestone={(id, isDone) =>
                      void act(() =>
                        window.selfos.invoke("goals.setMilestone", { milestoneId: id, done: isDone }),
                      )
                    }
                    onAddMilestone={(title, dueDate) =>
                      void act(() =>
                        window.selfos.invoke("goals.addMilestone", { goalId: c.id, title, dueDate }),
                      )
                    }
                    onClose={(status, reason) =>
                      void act(() => window.selfos.invoke("goals.close", { goalId: c.id, status, reason }))
                    }
                    onReopen={() => void act(() => window.selfos.invoke("goals.reopen", { goalId: c.id }))}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
