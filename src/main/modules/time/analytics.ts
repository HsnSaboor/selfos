/**
 * Analytics over the daily aggregates (PRD F-TIME, F-DASH-09, M7 depth).
 *
 * Every function reads `day_aggregate`, which is itself a rebuildable cache over
 * `focus_event`. That keeps a 90-day report a single indexed scan instead of
 * re-summing raw segments, and keeps the numbers identical to the dashboard.
 */
import type { Db } from "../../db/driver";
import { addDays } from "../goals/model";
import { localDateKey } from "./aggregate";
import { unionSeconds } from "./sites";

export interface DayPoint {
  localDate: string;
  screenSeconds: number;
  focusedSeconds: number;
  mediaSeconds: number;
  readingSeconds: number;
  switches: number;
}

export interface AnalyticsRange {
  from: string;
  to: string;
  days: DayPoint[];
  totals: Omit<DayPoint, "localDate">;
  /** Mean over days that actually have activity, not calendar days. */
  activeDayCount: number;
  averageScreenSeconds: number;
  bestDay: DayPoint | null;
  worstDay: DayPoint | null;
  /** Longest run of consecutive days with any screen time. */
  longestStreak: number;
  currentStreak: number;
}

const EMPTY = { screenSeconds: 0, focusedSeconds: 0, mediaSeconds: 0, readingSeconds: 0, switches: 0 };

/** Inclusive date range, defaulting to the last `days` days ending today. */
export function dateRange(days: number, today = localDateKey(new Date())): { from: string; to: string } {
  const span = Math.max(1, Math.min(366, Math.floor(days)));
  return { from: addDays(today, -(span - 1)), to: today };
}

/**
 * Consecutive days with screen time. `days` must be ordered oldest first; a
 * missing day in the middle breaks the run.
 */
export function streaks(days: DayPoint[]): { longest: number; current: number } {
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of days) {
    const active = d.screenSeconds > 0;
    const contiguous = prev !== null && addDays(prev, 1) === d.localDate;
    if (active) run = contiguous ? run + 1 : 1;
    else run = 0;
    longest = Math.max(longest, run);
    prev = d.localDate;
  }
  // `current` counts back from the last day in the range.
  const last = days[days.length - 1];
  return { longest, current: last && last.screenSeconds > 0 ? run : 0 };
}

export function analyse(db: Db, days: number, today = localDateKey(new Date())): AnalyticsRange {
  const { from, to } = dateRange(days, today);
  const rows = db.all<{
    local_date: string;
    screen_seconds: number;
    focused_seconds: number;
    media_seconds: number;
    reading_seconds: number;
    switches: number;
  }>(
    `SELECT local_date, screen_seconds, focused_seconds, media_seconds, reading_seconds, switches
       FROM day_aggregate WHERE local_date BETWEEN ? AND ? ORDER BY local_date`,
    from,
    to,
  );

  // Fill gaps so the chart has one column per calendar day, not per stored row.
  const byDate = new Map(rows.map((r) => [r.local_date, r]));
  const out: DayPoint[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const r = byDate.get(d);
    out.push({
      localDate: d,
      screenSeconds: r?.screen_seconds ?? 0,
      focusedSeconds: r?.focused_seconds ?? 0,
      mediaSeconds: r?.media_seconds ?? 0,
      readingSeconds: r?.reading_seconds ?? 0,
      switches: r?.switches ?? 0,
    });
  }

  const totals = out.reduce(
    (acc, d) => ({
      screenSeconds: acc.screenSeconds + d.screenSeconds,
      focusedSeconds: acc.focusedSeconds + d.focusedSeconds,
      mediaSeconds: acc.mediaSeconds + d.mediaSeconds,
      readingSeconds: acc.readingSeconds + d.readingSeconds,
      switches: acc.switches + d.switches,
    }),
    { ...EMPTY },
  );

  const active = out.filter((d) => d.screenSeconds > 0);
  const best = active.reduce<DayPoint | null>(
    (a, d) => (a === null || d.screenSeconds > a.screenSeconds ? d : a),
    null,
  );
  const worst = active.reduce<DayPoint | null>(
    (a, d) => (a === null || d.screenSeconds < a.screenSeconds ? d : a),
    null,
  );
  const s = streaks(out);

  return {
    from,
    to,
    days: out,
    totals,
    activeDayCount: active.length,
    averageScreenSeconds: active.length ? Math.round(totals.screenSeconds / active.length) : 0,
    bestDay: best,
    worstDay: worst,
    longestStreak: s.longest,
    currentStreak: s.current,
  };
}

export interface HourBucket {
  hour: number;
  seconds: number;
}

/** Seconds of focus per hour of the local day, for one date. */
export function hourlyProfile(db: Db, localDate: string): HourBucket[] {
  const rows = db.all<{ started_at: number; ended_at: number }>(
    "SELECT started_at, ended_at FROM focus_event WHERE local_date = ? ORDER BY started_at",
    localDate,
  );
  const buckets = new Array<number>(24).fill(0);
  for (const r of rows) {
    // Clip a segment that crosses an hour boundary into each hour it touches.
    let start = r.started_at;
    const end = r.ended_at;
    while (start < end) {
      const d = new Date(start);
      const hourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
      // `hourStart` is ambiguous during a DST fall-back: the repeated local hour
      // resolves to the *first* occurrence, which can be an hour before `start`.
      // Falling back to a full hour from `start` keeps the walk moving; using a
      // tiny step would terminate but crawl 1 ms at a time.
      const naturalHourEnd = hourStart + 3_600_000;
      const hourEnd = naturalHourEnd > start ? naturalHourEnd : start + 3_600_000;
      const sliceEnd = Math.min(end, hourEnd);
      const hour = d.getHours();
      buckets[hour] = (buckets[hour] ?? 0) + Math.max(0, sliceEnd - start);
      start = sliceEnd;
    }
  }
  return buckets.map((ms, hour) => ({ hour, seconds: Math.round(ms / 1000) }));
}

export interface DomainUsage {
  domain: string;
  seconds: number;
  visits: number;
}

/** Browser time by domain, from the ingested history (F-TIME-05). */
export function topDomains(
  db: Db,
  days: number,
  today = localDateKey(new Date()),
  limit = 15,
): DomainUsage[] {
  const { from, to } = dateRange(days, today);
  // Union per domain, never SUM: overlapping tabs would double count, and
  // window-title rows would stack on top of history for the same site. This is
  // the same rule `siteUsage` applies for a single day.
  const rows = db.all<{ domain: string; visit_at: number; duration_us: number; source: string }>(
    `SELECT domain, visit_at, duration_us, source
       FROM browser_visit
      WHERE local_date BETWEEN ? AND ? AND domain IS NOT NULL`,
    from,
    to,
  );
  const byDomain = new Map<string, { intervals: Array<{ start: number; end: number }>; visits: number }>();
  for (const r of rows) {
    const entry = byDomain.get(r.domain) ?? { intervals: [], visits: 0 };
    entry.intervals.push({ start: r.visit_at, end: r.visit_at + Math.round(r.duration_us / 1000) });
    entry.visits++;
    byDomain.set(r.domain, entry);
  }
  return [...byDomain.entries()]
    .map(([domain, v]) => ({ domain, seconds: unionSeconds(v.intervals), visits: v.visits }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}
