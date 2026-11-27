/**
 * Focus-time aggregation (STACK.md §4.4).
 *
 * Raw `focus_event` rows are the source of truth; `day_aggregate` is a cache
 * that can always be rebuilt. Screen time = sum of all focus segments;
 * focused time = screen time minus short "switch noise" segments.
 */
import type { Db } from "../../db/driver";

export const SWITCH_NOISE_MS = 15_000;
/** A contiguous same-app run must reach this length to count as a focus session. */
export const FOCUS_SESSION_MIN_MS = 5 * 60 * 1000;

export interface DayAggregate {
  localDate: string;
  screenSeconds: number;
  focusedSeconds: number;
  mediaSeconds: number;
  readingSeconds: number;
  switches: number;
  focusSessions: number;
  longestFocusSeconds: number;
  firstActivity: number | null;
  lastActivity: number | null;
}

/** Media player classes on this machine; streaming sites come from history. */
const MEDIA_CLASSES = /^(mpv|vlc|celluloid|haruna|smplayer)$/i;

export function computeDayAggregate(db: Db, localDate: string, readingSeconds = 0): DayAggregate {
  const rows = db.all<{ started_at: number; ended_at: number; app_class: string }>(
    "SELECT started_at, ended_at, app_class FROM focus_event WHERE local_date = ? ORDER BY started_at",
    localDate,
  );

  let screenMs = 0;
  let focusedMs = 0;
  let mediaMs = 0;
  let switches = 0;
  let first: number | null = null;
  let last: number | null = null;
  let prevClass: string | null = null;
  // Contiguous same-app run state for F-TIME-08.
  let runClass: string | null = null;
  let runStart = 0;
  let runEnd = 0;
  let focusSessions = 0;
  let longestFocus = 0;

  for (const r of rows) {
    const dur = Math.max(0, r.ended_at - r.started_at);
    if (dur === 0) continue;
    screenMs += dur;
    if (dur >= SWITCH_NOISE_MS) focusedMs += dur;
    if (MEDIA_CLASSES.test(r.app_class)) mediaMs += dur;
    if (prevClass !== null && prevClass !== r.app_class) switches++;
    prevClass = r.app_class;
    if (first === null || r.started_at < first) first = r.started_at;
    if (last === null || r.ended_at > last) last = r.ended_at;

    // A session continues only while the class is unchanged and the segments
    // touch; a gap or a switch closes it.
    if (runClass === r.app_class && r.started_at <= runEnd) {
      runEnd = Math.max(runEnd, r.ended_at);
    } else {
      if (runClass !== null && runEnd - runStart >= FOCUS_SESSION_MIN_MS) {
        focusSessions++;
        longestFocus = Math.max(longestFocus, runEnd - runStart);
      }
      runClass = r.app_class;
      runStart = r.started_at;
      runEnd = r.ended_at;
    }
  }
  if (runClass !== null && runEnd - runStart >= FOCUS_SESSION_MIN_MS) {
    focusSessions++;
    longestFocus = Math.max(longestFocus, runEnd - runStart);
  }

  // `reading_seconds` is passed in by the reading module, which owns the
  // reading_session table. Reading it here made time and reading mutually
  // dependent (PRD P-1) in both directions.
  return {
    localDate,
    screenSeconds: Math.round(screenMs / 1000),
    focusedSeconds: Math.round(focusedMs / 1000),
    mediaSeconds: Math.round(mediaMs / 1000),
    readingSeconds: Math.round(readingSeconds),
    switches,
    focusSessions,
    longestFocusSeconds: Math.round(longestFocus / 1000),
    firstActivity: first,
    lastActivity: last,
  };
}

export function writeDayAggregate(db: Db, agg: DayAggregate): void {
  db.run(
    `INSERT INTO day_aggregate
       (local_date, screen_seconds, focused_seconds, media_seconds, reading_seconds,
        switches, focus_sessions, longest_focus_seconds, first_activity, last_activity, rebuilt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(local_date) DO UPDATE SET
       screen_seconds  = excluded.screen_seconds,
       focused_seconds = excluded.focused_seconds,
       media_seconds   = excluded.media_seconds,
       reading_seconds = excluded.reading_seconds,
       switches        = excluded.switches,
       focus_sessions  = excluded.focus_sessions,
       longest_focus_seconds = excluded.longest_focus_seconds,
       first_activity  = excluded.first_activity,
       last_activity   = excluded.last_activity,
       rebuilt_at      = excluded.rebuilt_at`,
    agg.localDate,
    agg.screenSeconds,
    agg.focusedSeconds,
    agg.mediaSeconds,
    agg.readingSeconds,
    agg.switches,
    agg.focusSessions,
    agg.longestFocusSeconds,
    agg.firstActivity,
    agg.lastActivity,
    Date.now(),
  );
}

export function rebuildDay(db: Db, localDate: string, readingSeconds = 0): DayAggregate {
  const agg = computeDayAggregate(db, localDate, readingSeconds);
  writeDayAggregate(db, agg);
  return agg;
}
