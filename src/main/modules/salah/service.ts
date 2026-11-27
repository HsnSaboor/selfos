/**
 * Salah service: reads times from the existing stack, stores prayer outcomes
 * and qada debt locally (STACK.md §10).
 *
 * The external stack owns times and alarms; this service owns the log. It never
 * writes to `salah.json`, never touches `/tmp/salah_playing.json`, and never
 * plays audio (F-SALAH-09).
 */
import { readFileSync } from "node:fs";
import { PRAYER_COUNT } from "../../../shared/api";
import { localDateKey } from "../../../shared/dates";
import type { Db } from "../../db/driver";
import {
  PRAYERS,
  type PrayerId,
  type PrayerSlot,
  readSalahStatus,
  SALAH_CONFIG,
  type SalahTimes,
} from "../../integrations/salah/bridge";
import { computeTimes, parseSalahConfig, type SalahConfig } from "../../integrations/salah/compute";
import {
  buildDayState,
  classifyLog,
  type PrayerDayState,
  type PrayerLog,
  type PrayerStatus,
  type PrayerWindows,
  prayerStreak,
  type QadaSummary,
  qadaDebt,
} from "./log";

export interface SalahDay extends PrayerDayState {
  /** The full time source; the IPC view flattens this to `times: PrayerSlotView[]`. */
  source_times: SalahTimes;
  qada: QadaSummary;
  streak: { current: number; longest: number };
  hijri: string;
  source: SalahTimes["source"];
  location: string;
  current: PrayerId | null;
  next: SalahTimes["next"];
}

export class SalahService {
  #db: Db;
  #cachedTimes: { at: number; times: SalahTimes } | null = null;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Last Hijri date seen from the external stack, for other modules to reuse. */
  lastHijri(): { value: string | null; source: "salah-ctl" | "computed" } {
    const cached = this.#cachedTimes;
    // Resolve locally when nothing has run yet: the dashboard must show the same
    // date whether or not the Salah screen was opened first (round-13).
    if (!cached) {
      const times = computeTimes(this.config(), new Date());
      return { value: times.hijri || null, source: "computed" };
    }
    return { value: cached.times.hijri || null, source: cached.times.source };
  }

  config(): SalahConfig {
    try {
      return parseSalahConfig(JSON.parse(readFileSync(SALAH_CONFIG, "utf8")));
    } catch {
      return parseSalahConfig(null);
    }
  }

  /**
   * Times from the external stack, cached for 60 s. If it is unavailable,
   * compute locally with the same method and say so in `source`.
   */
  async times(now = new Date()): Promise<SalahTimes> {
    if (this.#cachedTimes && Date.now() - this.#cachedTimes.at < 60_000) return this.#cachedTimes.times;

    const external = await readSalahStatus();
    if (external) {
      this.#cachedTimes = { at: Date.now(), times: external };
      return external;
    }
    const computed = computeTimes(this.config(), now);
    this.#cachedTimes = { at: Date.now(), times: computed };
    return { ...computed, fallbackReason: "salah-ctl unavailable" };
  }

  /** Prayer windows for a day, used to classify a log. */
  windows(times: SalahTimes): PrayerWindows {
    const starts = {} as Record<PrayerId, string>;
    for (const p of times.prayers) starts[p.id] = p.time;
    const config = this.config();
    // Sunrise comes from the same computation as the prayers; a second adhan
    // configuration here could disagree, and its old fallback invented 06:00,
    // which decides Fajr's on-time boundary (round-13).
    const sunrise = times.sunrise ?? computeTimes(config, new Date()).sunrise;
    return { starts, sunrise, fajrTomorrow: starts.fajr };
  }

  /** Times for a specific local date (noon is enough for the astronomy). */
  private timesFor(date: string): SalahTimes {
    return computeTimes(this.config(), new Date(`${date}T12:00:00`));
  }

  /** Windows for a specific local date, from that date's own astronomy. */
  windowsFor(date: string): PrayerWindows {
    return this.windows(this.timesFor(date));
  }

  async day(localDate?: string, now = new Date()): Promise<SalahDay> {
    const date = localDate ?? localDateKey(now);
    const isToday = date === localDateKey(now);
    // A past day is judged with that day's own times and a fully elapsed clock,
    // not with today's windows at today's minute (round-13).
    const times = isToday ? await this.times(now) : this.timesFor(date);
    const windows = this.windows(times);
    const logs = this.logsFor(date);
    const nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : 24 * 60;

    // A past day is fully settled; today is settled only up to now.
    const state = buildDayState(date, windows, logs, isToday ? nowMinutes : 24 * 60);

    return {
      ...state,
      source_times: times,
      qada: qadaDebt(this.qadaEvents()),
      streak: prayerStreak(this.recentDays(30, now), localDateKey(now)),
      hijri: times.hijri,
      source: times.source,
      location: times.location,
      current: times.current,
      next: times.next,
    };
  }

  /**
   * Log a prayer. The status is derived from the clock unless the caller
   * overrides it (e.g. marking a past prayer as excused).
   */
  async log(
    prayer: PrayerId,
    opts: { localDate?: string; status?: PrayerStatus; jamaah?: boolean; masjid?: string; now?: Date } = {},
  ): Promise<{ status: PrayerStatus }> {
    if (!PRAYERS.includes(prayer)) throw new Error(`unknown prayer: ${prayer}`);
    const now = opts.now ?? new Date();
    const date = opts.localDate ?? localDateKey(now);
    const isToday = date === localDateKey(now);
    const times = isToday ? await this.times(now) : this.timesFor(date);
    const windows = this.windows(times);
    const slot = times.prayers.find((p) => p.id === prayer);
    if (!slot) throw new Error(`prayer ${prayer} missing from schedule`);

    const status =
      opts.status ?? classifyLog(prayer, isToday ? now.getHours() * 60 + now.getMinutes() : 24 * 60, windows);

    // Read the previous status first: qada debt is a *transition* ledger.
    // Adding +1 on every `missed` log made a repeated log double the debt, and
    // correcting a missed prayer to on_time never reversed it, so the derived
    // debt stopped matching "one debt per actually-missed prayer".
    const prior = this.#db.get<{ status: string }>(
      "SELECT status FROM prayer_log WHERE local_date = ? AND prayer = ?",
      date,
      prayer,
    );

    this.#db.run(
      `INSERT INTO prayer_log
         (local_date, prayer, status, jamaah, masjid, prayer_time, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(local_date, prayer) DO UPDATE SET
         status = excluded.status,
         jamaah = excluded.jamaah,
         masjid = excluded.masjid,
         logged_at = excluded.logged_at`,
      date,
      prayer,
      status,
      opts.jamaah ? 1 : 0,
      opts.masjid ?? null,
      slot.time,
      Date.now(),
    );

    // A missed prayer creates qada debt; correcting it back repays the debt.
    const wasMissed = prior?.status === "missed";
    if (status === "missed" && !wasMissed) this.addQada(prayer, 1, date);
    else if (status !== "missed" && wasMissed) this.addQada(prayer, -1, date);
    return { status };
  }

  clear(prayer: PrayerId, localDate: string): void {
    const existing = this.#db.get<{ status: string }>(
      "SELECT status FROM prayer_log WHERE local_date = ? AND prayer = ?",
      localDate,
      prayer,
    );
    this.#db.run("DELETE FROM prayer_log WHERE local_date = ? AND prayer = ?", localDate, prayer);
    if (existing?.status === "missed") this.addQada(prayer, -1, localDate);
  }

  /** Current qada debt (read path used by the service's own tests). */
  qada(): QadaSummary {
    return qadaDebt(this.qadaEvents());
  }

  /** Record a make-up of a previously missed prayer. */
  repayQada(prayer: PrayerId, count = 1, localDate?: string): QadaSummary {
    if (!PRAYERS.includes(prayer)) throw new Error(`unknown prayer: ${prayer}`);
    // Clamp to the outstanding debt: an over-repayment would be silently
    // swallowed by the per-prayer floor and a later missed prayer would net ≤0.
    const outstanding = qadaDebt(this.qadaEvents()).byPrayer[prayer] ?? 0;
    const repay = Math.min(Math.abs(count), outstanding);
    if (repay > 0) this.addQada(prayer, -repay, localDate ?? localDateKey(new Date()));
    return qadaDebt(this.qadaEvents());
  }

  /** F-SALAH-07: daily completion for the weekly/monthly heatmap. */
  completion(days = 30, now = new Date()): Array<{ localDate: string; logged: number; total: number }> {
    const out: Array<{ localDate: string; logged: number; total: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000);
      const key = localDateKey(d);
      const logged =
        this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prayer_log WHERE local_date = ?", key)?.n ?? 0;
      out.push({ localDate: key, logged, total: PRAYER_COUNT });
    }
    return out;
  }

  /** Per-prayer completion for the heatmap (last N days). */
  history(
    days: number,
    now = new Date(),
  ): Array<{ localDate: string; logged: number; missed: number; excused: number }> {
    return this.recentDays(days, now);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private addQada(prayer: PrayerId, delta: number, localDate: string): void {
    this.#db.run(
      "INSERT INTO qada_event (prayer, delta, local_date, note, created_at) VALUES (?, ?, ?, NULL, ?)",
      prayer,
      delta,
      localDate,
      Date.now(),
    );
  }

  private qadaEvents() {
    return this.#db
      .all<{ prayer: string; delta: number; local_date: string }>(
        "SELECT prayer, delta, local_date FROM qada_event",
      )
      .map((r) => ({ prayer: r.prayer as PrayerId, delta: r.delta, localDate: r.local_date }));
  }

  private logsFor(localDate: string): PrayerLog[] {
    return this.#db
      .all<{
        local_date: string;
        prayer: string;
        status: string;
        jamaah: number;
        masjid: string | null;
        prayer_time: string;
        logged_at: number;
      }>(
        "SELECT local_date, prayer, status, jamaah, masjid, prayer_time, logged_at FROM prayer_log WHERE local_date = ?",
        localDate,
      )
      .map((r) => ({
        localDate: r.local_date,
        prayer: r.prayer as PrayerId,
        status: r.status as PrayerStatus,
        jamaah: r.jamaah === 1,
        masjid: r.masjid,
        prayerTime: r.prayer_time,
        loggedAt: r.logged_at,
      }));
  }

  /**
   * Per-day prayer counts for the last `days` days, oldest first.
   *
   * Every day in the window is present, including days with no rows: a heatmap
   * that only returns logged days is not a calendar — it collapses to however
   * many days the user happened to log, and the gaps that carry the meaning
   * disappear. The window ends *today* inclusive, so it spans exactly `days`
   * dates.
   */
  private recentDays(days: number, now: Date) {
    const today = localDateKey(now);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const rows = this.#db.all<{ local_date: string; status: string }>(
      `SELECT local_date, status FROM prayer_log
        WHERE local_date >= ? AND local_date <= ?
        ORDER BY local_date`,
      localDateKey(start),
      today,
    );

    const byDate = new Map<string, { logged: number; missed: number; excused: number }>();
    for (const r of rows) {
      const e = byDate.get(r.local_date) ?? { logged: 0, missed: 0, excused: 0 };
      e.logged++;
      if (r.status === "missed") e.missed++;
      if (r.status === "excused") e.excused++;
      byDate.set(r.local_date, e);
    }

    const out: Array<{ localDate: string; logged: number; missed: number; excused: number }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = localDateKey(d);
      out.push({ localDate: key, ...(byDate.get(key) ?? { logged: 0, missed: 0, excused: 0 }) });
    }
    return out;
  }
}

export type { PrayerId, PrayerSlot };
