import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Api,
  PRAYER_COUNT,
  type PrayerId,
  type PrayerStatus,
  type SalahDayView,
} from "../../../shared/api";

type SalahHistoryDay = Api["salah.history"]["result"][number];

import { formatClock } from "../../../shared/format";

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

  const [history, setHistory] = useState<SalahHistoryDay[]>([]);

  /** Sequence guard: see `Habits.tsx` — the same `localDate` rollover and the
   *  same 60 s interval can deliver yesterday's day under today's date. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [res, hist] = await Promise.all([
      window.selfos.invoke("salah.day", { localDate }),
      // F-SALAH-07: the daily completion heatmap. 12 weeks of per-day counts.
      window.selfos.invoke("salah.history", { days: 84 }),
    ]);
    if (seq !== loadSeq.current) return;
    if (res.ok) {
      setDay(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
    if (hist.ok) setHistory(hist.data);
    // An empty completion panel with no message reads as "no data" rather than
    // "the query failed" — the same rule the other secondary fetches follow.
    else setError((prev) => prev ?? `history: ${hist.error}`);
  }, [localDate]);

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
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* F-SALAH-07: daily prayer completion heatmap (12 weeks). */}
      <div className="panel salah-heat-panel">
        <div className="panel-head">
          <h2>Completion</h2>
          <span className="muted">last 12 weeks</span>
        </div>
        <div className="salah-heat" role="img" aria-label="Daily prayer completion over the last 12 weeks">
          {history.map((d) => {
            // `logged` counts every row, including "missed" and "excused", so it
            // cannot be used as "prayed". A day where all five were logged as
            // missed used to render in the strongest "full" colour.
            //
            // `excused` is a subset of `logged`, so adding it back here counted
            // those prayers twice: with 3 on-time, 1 excused and 1 unlogged,
            // `prayed` was 3 and `accounted` came to 4 — rendering "full" on a
            // day that was one prayer short. `prayed` alone is the count of
            // non-missed, non-excused prayers only if excused is removed, so
            // subtract it: `logged - missed - excused`.
            const excused = d.excused;
            const prayed = Math.max(0, d.logged - d.missed - excused);
            const accounted = prayed + excused;
            const cls =
              accounted >= PRAYER_COUNT && d.missed === 0
                ? "full"
                : d.missed >= PRAYER_COUNT
                  ? "missed"
                  : accounted > 0 || d.missed > 0
                    ? "partial"
                    : "empty";
            const label =
              d.logged === 0 && d.missed === 0
                ? "nothing logged"
                : `${prayed}/${PRAYER_COUNT} prayed${d.excused ? `, ${d.excused} excused` : ""}${
                    d.missed ? `, ${d.missed} missed` : ""
                  }`;
            return (
              <span
                key={d.localDate}
                className={`salah-heat-cell ${cls}`}
                title={`${d.localDate}: ${label}`}
              />
            );
          })}
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
          Days with all five prayers accounted for. Excused days do not break the streak.
        </div>
      </div>
    </div>
  );
}
