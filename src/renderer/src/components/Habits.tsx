import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntryStatus, HabitView, HeatmapCell, NewHabitInput, Result } from "../../../shared/api";
import { describeSchedule, isoWeekday, WEEKDAY_LABELS } from "../../../shared/schedule";

function statusLabel(h: HabitView): string {
  const e = h.todayEntry;
  if (!e) return h.dueToday ? "Not done" : "Off schedule";
  switch (e.status) {
    case "done":
      return h.kind === "avoid" ? "Clean" : "Done";
    case "partial":
      return `${e.value}${h.unit ?? ""} / ${h.target ?? "?"}`;
    case "skipped":
      return "Skipped";
    case "slipped":
      return "Slipped";
    case "clean":
      return "Clean";
  }
}

function pluralUnit(n: number, unit: "days" | "weeks" | "months"): string {
  if (n === 1) return unit.slice(0, -1);
  return unit;
}

function isComplete(h: HabitView): boolean {
  const s = h.todayEntry?.status;
  return s === "done" || s === "clean";
}

function Heatmap({ cells }: { cells: HeatmapCell[] }) {
  /**
   * Columns are calendar weeks, so a row is a weekday.
   *
   * `heatmapDays` returns a window ending *today*, so chunking from index 0
   * misaligns every row: a Tuesday cell would sit in the Monday row. The first
   * column is padded to the weekday of the first cell instead.
   */
  const weeks = useMemo(() => {
    const out: Array<Array<HeatmapCell | null>> = [];
    const first = cells[0];
    if (!first) return out;
    let week: Array<HeatmapCell | null> = Array.from({ length: isoWeekday(first.date) - 1 }, () => null);
    for (const cell of cells) {
      week.push(cell);
      if (week.length === 7) {
        out.push(week);
        week = [];
      }
    }
    if (week.length) out.push(week);
    return out;
  }, [cells]);

  return (
    <div className="heatmap" role="img" aria-label="Last 12 weeks of habit activity">
      {weeks.map((week) => (
        <div key={week.find((c) => c)?.date ?? "empty"} className="heatmap-week">
          {Array.from({ length: 7 }, (_, i) => {
            const c = week[i];
            // The pad cells have no date, so the weekday slot is the stable key.
            const slot = `pad-${week.find((x) => x)?.date ?? "empty"}-${i}`;
            return c ? (
              <span key={c.date} className={`heatmap-cell ${c.state}`} title={`${c.date} — ${c.state}`} />
            ) : (
              <span key={slot} className="heatmap-cell pad" />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function HabitRow({
  habit,
  busy,
  onToggle,
  onIncrement,
  onArchive,
  onSkip,
  onSlip,
}: {
  habit: HabitView;
  busy: boolean;
  onToggle: () => void;
  onIncrement: (d: number) => void;
  onSkip: () => void;
  onSlip: () => void;
  onArchive: () => void;
}) {
  const complete = isComplete(habit);
  const countish = habit.kind === "count" || habit.kind === "duration";

  return (
    <div className={`habit-row${complete ? " complete" : ""}${habit.dueToday ? "" : " off-schedule"}`}>
      <button
        type="button"
        className={`habit-check${complete ? " on" : ""}`}
        onClick={onToggle}
        disabled={busy}
        aria-label={complete ? `Mark ${habit.name} not done` : `Mark ${habit.name} done`}
      >
        {complete ? "✓" : ""}
      </button>

      <div className="habit-main">
        <div className="habit-name">{habit.name}</div>
        <div className="habit-meta">
          <span>{describeSchedule(habit.schedule)}</span>
          <span className="sep">·</span>
          <span>{statusLabel(habit)}</span>
        </div>
      </div>

      <div className="habit-streak" title={`Longest: ${habit.streak.longest}`}>
        <span className="streak-value">{habit.streak.current}</span>
        <span className="streak-unit">{pluralUnit(habit.streak.current, habit.streak.unit)}</span>
      </div>

      <div className="habit-actions">
        {countish ? (
          <>
            <button type="button" className="mini" onClick={() => onIncrement(-1)} disabled={busy}>
              −
            </button>
            <button type="button" className="mini" onClick={() => onIncrement(1)} disabled={busy}>
              +
            </button>
          </>
        ) : null}
        {habit.kind === "avoid" ? (
          <button
            type="button"
            className="mini danger"
            onClick={onSlip}
            disabled={busy}
            title="Record a slip"
          >
            slip
          </button>
        ) : (
          <button
            type="button"
            className="mini"
            onClick={onSkip}
            disabled={busy}
            title="Skip this day (neutral)"
          >
            skip
          </button>
        )}
        {/* F-HABIT-12: archive keeps history, so it is not a delete. */}
        <button
          type="button"
          className="mini"
          onClick={onArchive}
          disabled={busy}
          title="Archive (keeps history)"
        >
          archive
        </button>
      </div>
    </div>
  );
}

function NewHabitForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NewHabitInput["kind"]>("boolean");
  const [scheduleKind, setScheduleKind] = useState<NewHabitInput["schedule"]["kind"]>("daily");
  const [target, setTarget] = useState("1");
  const [unit, setUnit] = useState("");
  const [perPeriod, setPerPeriod] = useState("3");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the habit a name.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.selfos.invoke("habits.create", {
      name: name.trim(),
      kind,
      unit: kind === "count" || kind === "duration" ? unit || null : null,
      target: kind === "count" || kind === "duration" ? Number(target) || 1 : null,
      schedule: {
        kind: scheduleKind,
        weekdays: scheduleKind === "weekdays" ? weekdays : null,
        timesPerPeriod: scheduleKind.startsWith("times_per") ? Number(perPeriod) || 1 : null,
      },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setName("");
    onCreated();
  };

  return (
    <div className="habit-form">
      <div className="form-row">
        <input
          className="input grow"
          placeholder="Habit name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as NewHabitInput["kind"])}
        >
          <option value="boolean">Done / not done</option>
          <option value="count">Count</option>
          <option value="duration">Duration</option>
          <option value="avoid">Avoid</option>
        </select>
      </div>

      <div className="form-row">
        <select
          className="input"
          value={scheduleKind}
          onChange={(e) => setScheduleKind(e.target.value as NewHabitInput["schedule"]["kind"])}
        >
          <option value="daily">Every day</option>
          <option value="weekdays">Specific weekdays</option>
          <option value="times_per_week">N× per week</option>
          <option value="times_per_month">N× per month</option>
        </select>

        {scheduleKind === "weekdays" ? (
          <div className="weekday-picker">
            {WEEKDAY_LABELS.map((label, i) => {
              const day = i + 1;
              const on = weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`weekday${on ? " on" : ""}`}
                  onClick={() => setWeekdays((w) => (on ? w.filter((x) => x !== day) : [...w, day].sort()))}
                >
                  {label.slice(0, 2)}
                </button>
              );
            })}
          </div>
        ) : null}

        {scheduleKind.startsWith("times_per") ? (
          <input
            className="input narrow"
            type="number"
            min={1}
            value={perPeriod}
            onChange={(e) => setPerPeriod(e.target.value)}
            aria-label="Times per period"
          />
        ) : null}

        {kind === "count" || kind === "duration" ? (
          <>
            <input
              className="input narrow"
              type="number"
              min={1}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              aria-label="Daily target"
            />
            <input
              className="input narrow"
              placeholder={kind === "duration" ? "min" : "unit"}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              aria-label="Unit"
            />
          </>
        ) : null}

        <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
          Add habit
        </button>
      </div>

      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

export function HabitsView({ localDate }: { localDate: string }) {
  const [habits, setHabits] = useState<HabitView[]>([]);
  const [heatmaps, setHeatmaps] = useState<Record<number, HeatmapCell[]>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sequence guard: `localDate` changes underneath this loader on the App's 30 s
   * `today` rollover, which re-creates `load` and re-fires it. A slow load for
   * yesterday could land after the load for today and write yesterday's rows
   * under today's date. The same guard Analytics, Notes, Reader and Sites carry;
   * this loader and Salah's were the two that were missed.
   */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await window.selfos.invoke("habits.list", { localDate, includeArchived: true });
    // A newer load owns the state now.
    if (seq !== loadSeq.current) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setHabits(res.data);

    // One call for every heatmap: a per-habit loop made one habit toggle cost
    // N IPC round trips, each recomputing 84 days on the main process.
    const hm = await window.selfos.invoke("habits.heatmaps", { days: 84, localDate });
    if (seq !== loadSeq.current) return;
    if (hm.ok) setHeatmaps(hm.data);
    else setError((prev) => prev ?? `heatmaps: ${hm.error}`);
  }, [localDate]);

  useEffect(() => {
    void load();
  }, [load]);

  // `Result` is the bridge's own union; redeclaring it structurally here as
  // `{ ok: boolean; error?: string }` let `ok: true` carry an error and forced
  // a `?? "request failed"` fallback at every call site.
  const act = async (id: number, fn: () => Promise<Result<unknown>>) => {
    setBusyId(id);
    const res = await fn();
    if (res.ok) await load();
    else setError(res.error);
    setBusyId(null);
  };

  const active = habits.filter((h) => h.archivedAt === null || h.archivedAt === undefined);
  const archived = habits.filter((h) => h.archivedAt !== null && h.archivedAt !== undefined);
  const due = active.filter((h) => h.dueToday);
  const done = due.filter(isComplete).length;

  return (
    <div className="habits">
      <div className="habits-head">
        <div>
          <h2>Habits</h2>
          <div className="muted">
            {due.length === 0 ? "Nothing scheduled today" : `${done} of ${due.length} due today`}
          </div>
        </div>
        <div className="progress-ring" title={`${due.length ? Math.round((done / due.length) * 100) : 0}%`}>
          <svg viewBox="0 0 36 36" role="img" aria-label="Completion for today">
            <title>Completion for today</title>
            <circle cx="18" cy="18" r="15.5" className="ring-bg" />
            {/* A zero-length dash with a round cap still paints a dot, so an
                empty ring renders no foreground arc at all (as Goals does). */}
            {due.length > 0 ? (
              <circle
                cx="18"
                cy="18"
                r="15.5"
                className="ring-fg"
                strokeDasharray={`${(done / due.length) * 97.4} 97.4`}
              />
            ) : null}
          </svg>
          <span>{due.length ? Math.round((done / due.length) * 100) : 0}%</span>
        </div>
      </div>

      {error ? <div className="error">Habits error: {error}</div> : null}

      <NewHabitForm onCreated={() => void load()} />

      <div className="habit-list">
        {active.length === 0 ? (
          <div className="empty">No habits yet. Add one above to start a streak.</div>
        ) : null}

        {active.map((h) => (
          <div key={h.id} className="habit-block">
            <HabitRow
              habit={h}
              busy={busyId === h.id}
              onToggle={() =>
                void act(h.id, () => window.selfos.invoke("habits.toggle", { habitId: h.id, localDate }))
              }
              onIncrement={(d) =>
                void act(h.id, () =>
                  window.selfos.invoke("habits.increment", { habitId: h.id, delta: d, localDate }),
                )
              }
              onSkip={() =>
                void act(h.id, () =>
                  window.selfos.invoke("habits.log", {
                    habitId: h.id,
                    localDate,
                    status: "skipped" as EntryStatus,
                  }),
                )
              }
              onSlip={() =>
                void act(h.id, () =>
                  window.selfos.invoke("habits.log", {
                    habitId: h.id,
                    localDate,
                    status: "slipped" as EntryStatus,
                  }),
                )
              }
              onArchive={() =>
                void act(h.id, () =>
                  window.selfos.invoke("habits.archive", { habitId: h.id, archived: true }),
                )
              }
            />
            {heatmaps[h.id] ? (
              <div className="habit-heat">
                <Heatmap cells={heatmaps[h.id] ?? []} />
                <span className="muted heat-note">
                  last 12 weeks · 30-day completion {Math.round(h.completion30d * 100)}%
                </span>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Archived habits keep their history (F-HABIT-12) and can be restored. */}
      {archived.length > 0 ? (
        <div className="habit-archived">
          <h3 className="muted">Archived ({archived.length})</h3>
          {archived.map((h) => (
            <div key={h.id} className="habit-row archived">
              <div className="habit-main">
                <div className="habit-name">{h.name}</div>
                <div className="habit-meta">
                  <span>{describeSchedule(h.schedule)}</span>
                </div>
              </div>
              <div className="habit-actions">
                <button
                  type="button"
                  className="mini"
                  disabled={busyId === h.id}
                  onClick={() =>
                    void act(h.id, () =>
                      window.selfos.invoke("habits.archive", { habitId: h.id, archived: false }),
                    )
                  }
                >
                  restore
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
