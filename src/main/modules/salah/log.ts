/**
 * Prayer logging and qada debt (PRD F-SALAH-03..06, D-07).
 *
 * Pure functions; the service supplies rows. The classification rules are
 * explicit because "on time" is the whole point of the feature:
 *
 *  - A prayer has a *window*: from its own time until the next prayer begins
 *    (Isha runs until tomorrow's Fajr).
 *  - Logged inside its window          → `on_time`
 *  - Logged after the window closed     → `late`
 *  - Never logged, day over             → `missed`
 *  - Explicitly excused (travel/illness)→ `excused`, never debt
 *  - A missed prayer adds qada debt; a make-up repayment subtracts it.
 */
import type { PrayerId } from "../../integrations/salah/bridge";

export type PrayerStatus = "on_time" | "late" | "missed" | "excused";

// Fajr, Dhuhr, Asr, Maghrib, Isha. The value lives in the shared contract so
// the renderer's score and heatmap thresholds use the same number.
import { PRAYER_COUNT } from "../../../shared/api";

export { PRAYER_COUNT };

export interface PrayerLog {
  localDate: string;
  prayer: PrayerId;
  status: PrayerStatus;
  jamaah: boolean;
  masjid: string | null;
  prayerTime: string;
  loggedAt: number;
}

export interface QadaEvent {
  prayer: PrayerId;
  delta: number;
  localDate: string;
}

export interface PrayerWindows {
  /** "HH:MM" start of each prayer's window on the given day. */
  starts: Record<PrayerId, string>;
  /**
   * "HH:MM" of sunrise. Fajr's window closes here, not at Dhuhr — otherwise a
   * Fajr performed at noon would be recorded as "on time", which is wrong by
   * any standard. Falls back to Dhuhr's start when sunrise is unknown.
   */
  sunrise?: string;
  /** "HH:MM" start of tomorrow's Fajr, closing Isha's window. */
  fajrTomorrow: string;
}

function minutesOf(hm: string): number {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * Classify a prayer logged at a given local minute-of-day.
 * `loggedAtMinutes` is minutes since local midnight; values past 1440 mean
 * after midnight (which matters for Isha).
 */
export function classifyLog(prayer: PrayerId, loggedAtMinutes: number, windows: PrayerWindows): PrayerStatus {
  const start = minutesOf(windows.starts[prayer]);
  const end = windowEnd(prayer, windows);

  // Isha's window crosses midnight: normalize into a continuous range.
  if (prayer === "isha" && end < start) {
    const shifted = loggedAtMinutes < start ? loggedAtMinutes + 1440 : loggedAtMinutes;
    return shifted <= end + 1440 ? "on_time" : "late";
  }
  if (loggedAtMinutes < start) {
    // Logged before its time — treat as an early make-up for a prior day.
    return "late";
  }
  return loggedAtMinutes <= end ? "on_time" : "late";
}

/** Minute-of-day at which this prayer's window closes. */
export function windowEnd(prayer: PrayerId, windows: PrayerWindows): number {
  const order: PrayerId[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
  // Fajr ends at sunrise, which is not itself a prayer.
  if (prayer === "fajr") {
    return minutesOf(windows.sunrise ?? windows.starts.dhuhr);
  }
  const idx = order.indexOf(prayer);
  if (idx === order.length - 1) return minutesOf(windows.fajrTomorrow);
  const nextPrayer = order[idx + 1];
  return nextPrayer ? minutesOf(windows.starts[nextPrayer]) : 1440;
}

/**
 * Which prayers should be considered settled for a given day.
 * A prayer is only "missed" once its window has closed; before that it is
 * simply unlogged and must not create qada debt.
 */
export function settledPrayers(nowMinutes: number, windows: PrayerWindows): PrayerId[] {
  const order: PrayerId[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
  return order.filter((p) => {
    const end = windowEnd(p, windows);
    if (p === "isha" && end < minutesOf(windows.starts.isha)) return nowMinutes >= end + 1440;
    return nowMinutes >= end;
  });
}

export interface QadaSummary {
  byPrayer: Record<PrayerId, number>;
  total: number;
}

export function qadaDebt(events: QadaEvent[]): QadaSummary {
  const byPrayer: Record<PrayerId, number> = { fajr: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 };
  for (const e of events) byPrayer[e.prayer] = Math.max(0, (byPrayer[e.prayer] ?? 0) + e.delta);
  const total = Object.values(byPrayer).reduce((a, b) => a + b, 0);
  return { byPrayer, total };
}

export interface PrayerDayState {
  localDate: string;
  prayers: Array<{
    id: PrayerId;
    status: PrayerStatus | null;
    expectedStatus: PrayerStatus | "open" | "upcoming";
    loggedAt: number | null;
    jamaah: boolean;
  }>;
  logged: number;
  onTime: number;
  missed: number;
  /** True when all five are settled and none is missing. */
  complete: boolean;
}

/**
 * Build the day's prayer state by joining the schedule with what was logged.
 * Unlogged prayers past their window are reported as `missed` without being
 * written to the database — the DB stays the record of user actions.
 */
export function buildDayState(
  localDate: string,
  windows: PrayerWindows,
  logs: PrayerLog[],
  nowMinutes: number,
): PrayerDayState {
  const order: PrayerId[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
  const byPrayer = new Map(logs.map((l) => [l.prayer, l]));
  const settled = new Set(settledPrayers(nowMinutes, windows));

  const prayers = order.map((id) => {
    const log = byPrayer.get(id) ?? null;
    const start = minutesOf(windows.starts[id]);
    let expectedStatus: PrayerStatus | "open" | "upcoming";
    if (log) expectedStatus = log.status;
    else if (settled.has(id)) expectedStatus = "missed";
    else if (nowMinutes >= start) expectedStatus = "open";
    else expectedStatus = "upcoming";

    return {
      id,
      status: log?.status ?? null,
      expectedStatus,
      loggedAt: log?.loggedAt ?? null,
      jamaah: log?.jamaah ?? false,
    };
  });

  const onTime = prayers.filter((p) => p.expectedStatus === "on_time").length;
  const missed = prayers.filter((p) => p.expectedStatus === "missed").length;
  const logged = prayers.filter((p) => p.status !== null).length;

  return {
    localDate,
    prayers,
    logged,
    onTime,
    missed,
    complete: logged === PRAYER_COUNT && missed === 0,
  };
}

/**
 * Streak of days with all five prayers accounted for (F-SALAH-11).
 *
 * A day qualifies when every prayer is either performed or explicitly excused
 * and none is missed. An incomplete *today* is skipped rather than treated as
 * a break — otherwise the streak would reset every morning.
 */
export function prayerStreak(
  days: Array<{ localDate: string; logged: number; missed: number; excused: number }>,
  today: string,
): { current: number; longest: number } {
  // Newest first, contiguous from today backwards.
  const sorted = [...days].sort((a, b) => (a.localDate < b.localDate ? 1 : -1));

  /**
   * A day qualifies when all five prayers are accounted for and none is missed.
   *
   * `missed` only counts prayers the user *explicitly* logged as missed, so
   * `d.missed === 0` alone is satisfied by a day with no rows at all — which
   * gave a user who never logs an ever-growing streak. Every prayer must be
   * logged or excused (F-SALAH-05), and the day is then in progress, not
   * qualifying, until all five are.
   *
   * `logged` already counts *every* row, excused included (see `recentDays`,
   * which does `e.logged++` for each row regardless of status). The previous
   * `d.logged + d.excused >= PRAYER_COUNT` therefore counted excused rows twice:
   * a day with 3 on-time, 1 excused and 1 never logged passed the test on four
   * rows, awarding an F-SALAH-11 streak day for five prayers that were not all
   * accounted for. Reproduced: `{logged: 4, missed: 0, excused: 1}` returned
   * `current: 1`. Comparing `logged` alone is the correct test.
   */
  const qualifies = (d: { logged: number; missed: number; excused: number }) =>
    d.missed === 0 && d.logged >= PRAYER_COUNT;

  let longest = 0;
  let run = 0;
  for (const d of sorted) {
    if (qualifies(d)) {
      run++;
      longest = Math.max(longest, run);
    } else if (d.localDate === today) {
    } else {
      run = 0;
    }
  }

  // Current streak: consecutive qualifying days from the most recent one,
  // ignoring an incomplete today.
  let current = 0;
  for (const d of sorted) {
    if (qualifies(d)) {
      current++;
      continue;
    }
    if (d.localDate === today) continue;
    break;
  }

  return { current, longest };
}
