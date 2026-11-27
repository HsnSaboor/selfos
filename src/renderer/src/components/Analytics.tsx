import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityCellView,
  AnalyticsView as AnalyticsData,
  DayPointView,
  DomainUsageView,
  HourBucketView,
} from "../../../shared/api";
import { formatDuration, formatShortDate } from "../../../shared/format";
import { Kpi } from "./Kpi";

const RANGES = [7, 30, 90] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
type Range = (typeof RANGES)[number];

/**
 * One-series column chart.
 *
 * A single measure per day means no legend and no categorical palette: the
 * title names the series, and the accent hue carries it. Columns are capped at
 * 24px with a 4px rounded cap and a 2px surface gap, per the mark spec.
 */
function DailyChart({ days, onHover }: { days: DayPointView[]; onHover: (d: DayPointView | null) => void }) {
  const max = Math.max(1, ...days.map((d) => d.screenSeconds));
  const peak = days.reduce<DayPointView | null>(
    (a, d) => (a === null || d.screenSeconds > a.screenSeconds ? d : a),
    null,
  );
  // Y ticks at 0, half, and full keep the axis quiet while carrying the values
  // that are not directly labelled.
  const ticks = [max, max / 2, 0].map((v) => Math.round(v));

  return (
    <div className="chart">
      <div className="chart-y">
        {/* Ticks are a fixed three-element axis (top, middle, zero), so the
            position is the stable identity here; two labels can coincide when
            the range is flat, which rules the value out as a key. */}
        {ticks.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length axis
          <span key={i}>{t === 0 ? "0" : formatDuration(t)}</span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-grid" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div
          className="chart-cols"
          role="img"
          aria-label={`Screen time per day, peak ${formatDuration(max)}`}
        >
          {days.map((d) => {
            const h = (d.screenSeconds / max) * 100;
            const isPeak = peak !== null && d.localDate === peak.localDate && peak.screenSeconds > 0;
            return (
              <button
                key={d.localDate}
                type="button"
                className={`chart-col${d.screenSeconds === 0 ? " empty" : ""}`}
                style={{ ["--h" as string]: `${h}%` }}
                title={`${d.localDate} — ${formatDuration(d.screenSeconds)} screen · ${formatDuration(d.focusedSeconds)} focused`}
                onMouseEnter={() => onHover(d)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(d)}
                onBlur={() => onHover(null)}
                aria-label={`${d.localDate}: ${formatDuration(d.screenSeconds)}`}
              >
                {d.screenSeconds > 0 ? <span className="chart-col-fill" /> : null}
                {isPeak ? <span className="chart-col-label">{formatDuration(d.screenSeconds)}</span> : null}
              </button>
            );
          })}
        </div>
        <div className="chart-x">
          <span>{days[0] ? formatShortDate(days[0].localDate) : ""}</span>
          <span>{days[days.length - 1] ? formatShortDate(days[days.length - 1]?.localDate ?? "") : ""}</span>
        </div>
      </div>
    </div>
  );
}

/** 24 hour buckets as a single-series column chart. */
function HourlyChart({ buckets }: { buckets: HourBucketView[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.seconds));
  return (
    <div className="hourly" role="img" aria-label="Screen time by hour of day">
      {buckets.map((b) => (
        <div
          key={b.hour}
          className="hourly-col"
          title={`${String(b.hour).padStart(2, "0")}:00 — ${formatDuration(b.seconds)}`}
        >
          {b.seconds > 0 ? (
            <span className="hourly-fill" style={{ height: `${(b.seconds / max) * 100}%` }} />
          ) : null}
          {b.hour % 6 === 0 ? <span className="hourly-tick">{String(b.hour).padStart(2, "0")}</span> : null}
        </div>
      ))}
    </div>
  );
}

function DomainBars({ domains }: { domains: DomainUsageView[] }) {
  const max = Math.max(1, ...domains.map((d) => d.seconds));
  if (domains.length === 0) {
    return <div className="empty">No browser history ingested yet.</div>;
  }
  return (
    <div className="top-apps">
      {domains.map((d) => (
        <div key={d.domain} className="app-row domain-row">
          <span className="app-dot" style={{ background: "var(--accent)" }} />
          <span className="app-name">{d.domain}</span>
          <span className="app-bar">
            <span style={{ width: `${(d.seconds / max) * 100}%`, background: "var(--accent)" }} />
          </span>
          <span className="app-time">{formatDuration(d.seconds)}</span>
          <span className="app-share">{d.visits}</span>
        </div>
      ))}
    </div>
  );
}

/** The table view: identity and values never depend on the chart alone. */
function DataTable({ days }: { days: DayPointView[] }) {
  const rows = useMemo(() => [...days].reverse().filter((d) => d.screenSeconds > 0), [days]);
  return (
    <details className="chart-table">
      <summary>Data table ({rows.length} active days)</summary>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Screen</th>
            <th>Focused</th>
            <th>Media</th>
            <th>Reading</th>
            <th>Switches</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.localDate}>
              <td>{d.localDate}</td>
              <td>{formatDuration(d.screenSeconds)}</td>
              <td>{formatDuration(d.focusedSeconds)}</td>
              <td>{formatDuration(d.mediaSeconds)}</td>
              <td>{formatDuration(d.readingSeconds)}</td>
              <td>{d.switches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function AnalyticsView() {
  const [windowDays, setWindowDays] = useState<Range>(30);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [hourly, setHourly] = useState<HourBucketView[]>([]);
  const [domains, setDomains] = useState<DomainUsageView[]>([]);
  const [activity, setActivity] = useState<ActivityCellView[]>([]);
  const [hover, setHover] = useState<DayPointView | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Sequence guard for range switches.
   *
   * `load` awaits three invokes and committed each result unconditionally, so
   * clicking a longer range and then a shorter one raced: the slower first
   * response landed last and overwrote the newer range's data, leaving the
   * header reading "over 7 days" above 90 days of figures. Same guard as
   * `Notes.tsx`'s search and `Reader.tsx`'s highlight refetch.
   */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [a, h, d, ac] = await Promise.all([
      window.selfos.invoke("analytics.range", { days: windowDays }),
      window.selfos.invoke("analytics.hourly", {}),
      window.selfos.invoke("analytics.domains", { days: windowDays }),
      window.selfos.invoke("analytics.activity", { days: 7 }),
    ]);
    // A newer load started while this one was in flight; it owns the state now.
    if (seq !== loadSeq.current) return;
    // Build the message from this load only, then commit it: clearing on
    // success and setting on failure kept a single failed range load on screen
    // for the rest of the session, including after a later load succeeded.
    const failure = !a.ok ? a.error : !h.ok ? `hourly: ${h.error}` : !d.ok ? `domains: ${d.error}` : null;
    if (a.ok) setData(a.data);
    if (h.ok) setHourly(h.data);
    if (d.ok) setDomains(d.data);
    if (ac.ok) setActivity(ac.data);
    setError(failure);
  }, [windowDays]);

  useEffect(() => {
    void load();
  }, [load]);

  const activityMax = Math.max(1, ...activity.map((c) => c.seconds));

  return (
    <div className="analytics">
      <div className="habits-head">
        <div>
          <div className="page-sub">
            {data ? `${data.from} → ${data.to}` : "loading…"}
            {data ? ` · ${data.activeDayCount} active days` : ""}
          </div>
        </div>
        <fieldset className="range-picker" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`range-btn${r === windowDays ? " on" : ""}`}
              onClick={() => setWindowDays(r)}
              aria-pressed={r === windowDays}
            >
              {r}d
            </button>
          ))}
        </fieldset>
      </div>

      {error ? <div className="error">Analytics error: {error}</div> : null}

      {data ? (
        <>
          <section className="kpis">
            <Kpi
              label="Total screen"
              value={formatDuration(data.totals.screenSeconds)}
              sub={`over ${windowDays} days`}
            />
            <Kpi
              label="Daily average"
              value={formatDuration(data.averageScreenSeconds)}
              sub="active days only"
            />
            <Kpi label="Longest streak" value={`${data.longestStreak}d`} sub="consecutive active days" />
            <Kpi label="Media" value={formatDuration(data.totals.mediaSeconds)} sub="local players" />
            <Kpi
              label="vs previous"
              value={
                data.screenDeltaPct === null
                  ? "—"
                  : `${data.screenDeltaPct > 0 ? "+" : ""}${data.screenDeltaPct}%`
              }
              sub="screen time"
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Screen time per day</h2>
              <span className="muted">
                {hover
                  ? `${hover.localDate} · ${formatDuration(hover.screenSeconds)}`
                  : data.bestDay
                    ? `best ${data.bestDay.localDate} · ${formatDuration(data.bestDay.screenSeconds)}`
                    : ""}
              </span>
            </div>
            <DailyChart days={data.days} onHover={setHover} />
            <DataTable days={data.days} />
          </section>

          <section className="panel">
            <h2>Activity (last 7 days)</h2>
            <p className="muted panel-note">
              Screen time by weekday and hour. Darker cells are busier; the grid is the 7×24 matrix F-TIME-09
              asks for.
            </p>
            <div className="heatmap" role="img" aria-label="Screen time by weekday and hour">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, weekday) => (
                <div key={label} className="heatmap-row">
                  <span className="heatmap-label">{label}</span>
                  {HOURS.map((hour) => {
                    const cell = activity.find((c) => c.weekday === weekday && c.hour === hour);
                    const intensity = Math.min(1, (cell?.seconds ?? 0) / activityMax);
                    return (
                      <span
                        key={`${weekday}-${hour}`}
                        className="heatmap-cell"
                        style={{
                          background: `color-mix(in srgb, var(--accent) ${intensity * 100}%, transparent)`,
                        }}
                        title={`${weekday} ${String(hour).padStart(2, "0")}:00 — ${formatDuration(cell?.seconds ?? 0)}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Today by hour</h2>
            <HourlyChart buckets={hourly} />
          </section>

          <section className="panel">
            <h2>Top domains</h2>
            <DomainBars domains={domains} />
          </section>
        </>
      ) : (
        <div className="muted">Loading analytics…</div>
      )}
    </div>
  );
}
