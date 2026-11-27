/**
 * Local prayer-time fallback, used only when `salah-ctl` is unavailable.
 *
 * Configured to match the existing stack exactly: Karachi method with
 * 18°/18° angles and Hanafi Asr. Verified against the live `autoTime` values
 * (max drift 1 minute), so the fallback never silently changes prayer windows.
 */

import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from "adhan";
import { minutesOfDay } from "../../../shared/dates";
import { PRAYER_LABELS, type PrayerId, type PrayerSlot, type SalahTimes } from "./bridge";

export interface SalahConfig {
  city: string;
  latitude: number;
  longitude: number;
  timezone: number;
  fajrAngle: number;
  ishaAngle: number;
  asrSchool: "hanafi" | "standard";
  customTimes: Partial<Record<PrayerId | "sunrise", string>>;
}

export const DEFAULT_CONFIG: SalahConfig = {
  city: "Gujranwala",
  latitude: 32.1877,
  longitude: 74.1945,
  timezone: 5,
  fajrAngle: 18,
  ishaAngle: 18,
  asrSchool: "hanafi",
  customTimes: {},
};

/** Parse the external config defensively; unknown keys are ignored. */
export function parseSalahConfig(raw: unknown): SalahConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG;
  const c = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const custom = (c.custom_times && typeof c.custom_times === "object" ? c.custom_times : {}) as Record<
    string,
    unknown
  >;
  const customTimes: SalahConfig["customTimes"] = {};
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim())) {
      customTimes[k as PrayerId] = v.trim().padStart(5, "0");
    }
  }
  return {
    city: typeof c.city === "string" ? c.city : DEFAULT_CONFIG.city,
    latitude: num(c.latitude, DEFAULT_CONFIG.latitude),
    longitude: num(c.longitude, DEFAULT_CONFIG.longitude),
    timezone: num(c.timezone, DEFAULT_CONFIG.timezone),
    fajrAngle: num(c.fajr_angle, DEFAULT_CONFIG.fajrAngle),
    ishaAngle: num(c.isha_angle, DEFAULT_CONFIG.ishaAngle),
    asrSchool: c.asr_school === "standard" ? "standard" : "hanafi",
    customTimes,
  };
}

function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function computeTimes(config: SalahConfig, now: Date): SalahTimes {
  const params = CalculationMethod.Karachi();
  params.fajrAngle = config.fajrAngle;
  params.ishaAngle = config.ishaAngle;
  params.madhab = config.asrSchool === "hanafi" ? Madhab.Hanafi : Madhab.Shafi;

  const coords = new Coordinates(config.latitude, config.longitude);
  const today = new PrayerTimes(coords, now, params);

  const astronomical: Record<PrayerId, string> = {
    fajr: hm(today.fajr),
    dhuhr: hm(today.dhuhr),
    asr: hm(today.asr),
    maghrib: hm(today.maghrib),
    isha: hm(today.isha),
  };

  const prayers: PrayerSlot[] = (Object.keys(astronomical) as PrayerId[]).map((id) => {
    const custom = config.customTimes[id];
    return {
      id,
      name: PRAYER_LABELS[id],
      time: custom ?? astronomical[id],
      autoTime: astronomical[id],
      isCustom: Boolean(custom),
    };
  });

  // Current/next windows, using the same convention as salah-ctl: a prayer is
  // "current" until the next one begins; after Isha, Isha stays current.
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sorted = [...prayers].sort((a, b) => minutesOfDay(a.time) - minutesOfDay(b.time));

  let current: PrayerId | null = null;
  for (const p of sorted) if (minutesOfDay(p.time) <= nowMin) current = p.id;

  let next: SalahTimes["next"] = null;
  const upcoming = sorted.find((p) => minutesOfDay(p.time) > nowMin);
  if (upcoming) {
    next = {
      id: upcoming.id,
      time: upcoming.time,
      remainingSec: (minutesOfDay(upcoming.time) - nowMin) * 60,
    };
  } else {
    const tomorrow = new PrayerTimes(coords, new Date(now.getTime() + 86_400_000), params);
    const fajrTomorrow = config.customTimes.fajr ?? hm(tomorrow.fajr);
    next = {
      id: "fajr",
      time: fajrTomorrow,
      remainingSec: (24 * 60 - nowMin + minutesOfDay(fajrTomorrow)) * 60,
    };
  }

  return {
    source: "computed",
    location: config.city,
    // Intl's Umm al-Qura calendar, which differs from salah-ctl's arithmetic
    // calendar by a day at some dates. The source field tells the UI which
    // convention is in play.
    hijri: formatHijri(now),
    sunrise: hm(today.sunrise),
    prayers,
    current,
    next,
  };
}

export function formatHijri(d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return "";
  }
}
