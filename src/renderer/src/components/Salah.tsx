import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Api,
  PRAYER_COUNT,
  type PrayerId,
  type PrayerStatus,
  type SalahDayView,
} from "../../../shared/api";
import { formatClock } from "../../../shared/format";
import { isoWeekday } from "../../../shared/schedule";

type SalahCompletionDay = Api["salah.completion"]["result"][number];

/** Colour bucket for a completion cell, by logged/total (F-SALAH-07). */
function completionClass(logged: number, total: number): "full" | "partial" | "empty" {
  if (total > 0 && logged >= total) return "full";
  return logged > 0 ? "partial" : "empty";
}

const STATUS_LABEL: Record<PrayerStatus, string> = {
  on_time: "On time",
  late: "Late",
  missed: "Missed",
  excused: "Excused",
};

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function SalahView({ localDate }: { localDate: string }) {
  const [day, setDay] = useState<SalahDayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<PrayerId | null>(null);

  const [completion, setCompletion] = useState<SalahCompletionDay[]>([]);
  // F-SALAH-07: 7/30/90-day window for the completion heatmap.
  const [range, setRange] = useState<7 | 30 | 90>(30);

  /** Sequence guard: see `Habits.tsx` — the same `localDate` rollover and the
   *  same 60 s interval can deliver yesterday's day under today's date. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [res, comp] = await Promise.all([
      window.selfos.invoke("salah.day", { localDate }),
      // F-SALAH-07: daily completion counts for the heatmap, over the picked range.
      window.selfos.invoke("salah.completion", { days: range }),
    ]);
    if (seq !== loadSeq.current) return;
    if (res.ok) {
      setDay(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
    if (comp.ok) setCompletion(comp.data);
    // An empty completion panel with no message reads as "no data" rather than
    // "the query failed" — the same rule the other secondary fetches follow.
    else setError((prev) => prev ?? `completion: ${comp.error}`);
  }, [localDate, range]);

  useEffect(() => {
    void load();
    // Refresh the countdown and open-window state once a minute.
    // Skipped while hidden: the app's steady state is the tray, and this poll
    // runs two IPC calls that each hit the synchronous DB.
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  // A failed write must be visible: without this the row simply stays
  // unchanged and the user cannot tell a rejection from a no-op (N-UX-04).
  const log = async (prayer: PrayerId, status?: PrayerStatus, jamaah?: boolean) => {
    setBusy(prayer);
    const res = await window.selfos.invoke("salah.log", {
      prayer,
      localDate,
      ...(status ? { status } : {}),
      ...(jamaah !== undefined ? { jamaah } : {}),
    });
    if (res.ok) await load();
    else setError(res.error);
    setBusy(null);
  };

  const clear = async (prayer: PrayerId) => {
    setBusy(prayer);
    const res = await window.selfos.invoke("salah.clear", { prayer, localDate });
    if (res.ok) await load();
    else setError(res.error);
    setBusy(null);
  };

  // F-SALAH-07: chunk the completion window into week columns (rows = weekdays).
  // The window ends today, so the first column is padded to the weekday of its
  // first cell — otherwise every weekday row is shifted (the Habits heatmap fix).
  // Keys are built here (not in JSX) so no render callback needs the array index.
  const weeks = useMemo(() => {
    type Slot = { key: string; cell: SalahCompletionDay | null };
    const cols: Array<{ key: string; cells: Slot[] }> = [];
    const first = completion[0];
    if (!first) return cols;
    const cells: Slot[] = Array.from({ length: isoWeekday(first.localDate) - 1 }, (_, i) => ({
      key: `pad-${first.localDate}-${i}`,
      cell: null,
    }));
    for (const cell of completion) cells.push({ key: cell.localDate, cell });
    for (let i = 0; i < cells.length; i += 7) {
      const slice = cells.slice(i, i + 7);
      cols.push({ key: slice.find((s) => s.cell)?.key ?? `week-${i}`, cells: slice });
    }
    return cols;
  }, [completion]);

  // A failed write must not replace the module: the prayer list, qada grid and
  // heatmap stay usable, and the error is shown inline (as every other view does).
  if (!day) {
    return error ? (
      <div className="error">Salah error: {error}</div>
    ) : (
      <div className="muted">Loading prayer times…</div>
    );
  }

  // `logged` is computed in main from the same rows; recomputing it here is a
  // second definition that can drift.
  const done = day.logged;

  return (
    <div className="salah">
      {error ? <div className="error">Salah error: {error}</div> : null}
      <div className="salah-head">
        <div>
          <h2>Prayers</h2>
          <div className="muted">
            {day.location} · {day.hijri}
            {day.source === "computed" ? " · computed locally (salah-ctl unavailable)" : ""}
          </div>
        </div>
        <div className="salah-score">
          <span className="score-big">
            {done}/{PRAYER_COUNT}
          </span>
          <span className="muted">logged today</span>
        </div>
      </div>

      {day.next ? (
        <div className="next-prayer">
          <div>
            <div className="next-label">Next</div>
            <div className="next-name">{day.next.id}</div>
          </div>
          <div className="next-time">
            <span className="score-big">{day.next.time}</span>
            <span className="muted">in {fmtCountdown(day.next.remainingSec)}</span>
          </div>
        </div>
      ) : null}

      <div className="prayer-list">
        {day.prayers.map((p) => {
          const slot = day.times.find((t) => t.id === p.id);
          const logged = p.status !== null;
          const isNext = day.next?.id === p.id;
          const isCurrent = day.current === p.id;
          return (
            <div
              key={p.id}
              className={[
                "prayer-row",
                logged ? "logged" : "",
                isNext ? "next" : "",
                isCurrent ? "current" : "",
                p.expectedStatus === "missed" ? "missed" : "",
              ].join(" ")}
            >
              <div className="prayer-icon" aria-hidden="true">
                {logged ? "✓" : p.expectedStatus === "missed" ? "!" : "○"}
              </div>

              <div className="prayer-main">
                <div className="prayer-name">{slot?.name ?? p.id}</div>
                <div className="prayer-meta">
                  <span className="prayer-time">{slot?.time ?? "—"}</span>
                  {slot?.isCustom ? <span className="pill">custom</span> : null}
                  {logged ? (
                    <span className={`status ${p.status}`}>{STATUS_LABEL[p.status as PrayerStatus]}</span>
                  ) : p.expectedStatus === "open" ? (
                    <span className="status open">window open</span>
                  ) : p.expectedStatus === "missed" ? (
                    <span className="status missed">missed</span>
                  ) : (
                    <span className="status upcoming">upcoming</span>
                  )}
                  {p.jamaah ? <span className="status jamaah">jamaah</span> : null}
                  {logged ? <span className="muted logged-at">{formatClock(p.loggedAt)}</span> : null}
                </div>
              </div>

              <div className="prayer-actions">
                {logged ? (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => void clear(p.id)}
                    disabled={busy === p.id}
                  >
                    undo
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="mini primary-mini"
                      onClick={() => void log(p.id)}
                      disabled={busy === p.id}
                      title="Log with the status derived from the current time"
                    >
                      pray
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => void log(p.id, "on_time", true)}
                      disabled={busy === p.id}
                      title="Log as prayed in congregation"
                    >
                      jamaah
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => void log(p.id, "excused")}
                      disabled={busy === p.id}
                      title="Excused (travel, illness)"
                    >
                      excused
                    </button>
                    <button
                      type="button"
                      className="mini"
                      onClick={() => void log(p.id, "late")}
                      disabled={busy === p.id}
                      title="Prayed late (outside the window)"
                    >
                      late
                    </button>
                    <button
                      type="button"
                      className="mini danger"
                      onClick={() => void log(p.id, "missed")}
                      disabled={busy === p.id}
                      title="Missed — adds qada debt"
                    >
                      missed
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* F-SALAH-07: daily prayer completion heatmap, with a 7/30/90-day range. */}
      <div className="panel salah-complete-panel">
        <div className="panel-head">
          <h2>Completion</h2>
          <div className="range-picker">
            {([7, 30, 90] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`range-btn${range === r ? " on" : ""}`}
                aria-pressed={range === r}
                onClick={() => setRange(r)}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>
        <div
          className="salah-complete-grid"
          role="img"
          aria-label={`Daily prayer completion over the last ${range} days`}
        >
          {weeks.map((week) => (
            <div key={week.key} className="salah-complete-week">
              {week.cells.map((slot) =>
                slot.cell ? (
                  <span
                    key={slot.key}
                    className={`salah-complete-cell ${completionClass(slot.cell.logged, slot.cell.total)}`}
                    title={`${slot.cell.localDate}: ${slot.cell.logged}/${slot.cell.total} prayers`}
                  />
                ) : (
                  <span key={slot.key} className="salah-complete-cell pad" />
                ),
              )}
            </div>
          ))}
        </div>
        <div className="legend">
          <span className="legend-item">
            <span className="salah-complete-cell empty" /> none
          </span>
          <span className="legend-item">
            <span className="salah-complete-cell partial" /> partial
          </span>
          <span className="legend-item">
            <span className="salah-complete-cell full" /> all {PRAYER_COUNT}
          </span>
        </div>
      </div>

      <div className="panel qada-panel">
        <div className="panel-head">
          <h2>Qada debt</h2>
          <span className="muted">{day.qada.total} outstanding</span>
        </div>
        <div className="qada-grid">
          {(Object.keys(day.qada.byPrayer) as PrayerId[]).map((id) => {
            const n = day.qada.byPrayer[id];
            return (
              <div key={id} className={`qada-cell${n > 0 ? " owed" : ""}`}>
                <div className="qada-name">{id}</div>
                <div className="qada-count">{n}</div>
                <button
                  type="button"
                  className="mini"
                  disabled={n === 0}
                  onClick={async () => {
                    const res = await window.selfos.invoke("salah.repayQada", { prayer: id, count: 1 });
                    if (res.ok) await load();
                    else setError(res.error);
                  }}
                  title="Record one make-up"
                >
                  repay
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Streak</h2>
          <span className="muted">
            {day.streak.current} current · {day.streak.longest} longest
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Days with all {PRAYER_COUNT} prayers accounted for. Excused days do not break the streak.
        </div>
      </div>
    </div>
  );
}
