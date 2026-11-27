/**
 * Salah time source (STACK.md §5.4).
 *
 * The existing stack (salah-ctl + salah-daemon + Quickshell widget) owns prayer
 * *times* and adhan *alarms*. SelfOS owns prayer *logging*, which the existing
 * stack has no concept of. This module only reads from it — it never writes
 * state, never plays audio, and never creates competing timers (F-SALAH-09).
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";

export type PrayerId = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";
export const PRAYERS: PrayerId[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];
export const PRAYER_LABELS: Record<PrayerId, string> = {
  fajr: "Fajr",
  dhuhr: "Dhuhr",
  asr: "Asr",
  maghrib: "Maghrib",
  isha: "Isha",
};

export interface PrayerSlot {
  id: PrayerId;
  name: string;
  /** "HH:MM" in local time, already including any custom override. */
  time: string;
  /** The astronomical time before overrides, when the source provides it. */
  autoTime?: string;
  isCustom?: boolean;
  enabled?: boolean;
}

export interface SalahTimes {
  source: "salah-ctl" | "computed";
  location: string;
  hijri: string;
  /** Sunrise (HH:MM) closing Fajr's on-time window; computed when absent. */
  sunrise?: string;
  prayers: PrayerSlot[];
  /** The prayer whose window is currently open, if any. */
  current: PrayerId | null;
  next: { id: PrayerId; time: string; remainingSec: number } | null;
  /** Present when the external source failed and we computed locally. */
  fallbackReason?: string;
}

export const SALAH_CTL = `${homedir()}/.local/bin/salah-ctl`;
export const SALAH_CONFIG = `${homedir()}/.config/omarchy/salah.json`;

interface RawStatus {
  location?: unknown;
  hijri?: unknown;
  prayers?: unknown;
  current?: { id?: unknown } | undefined;
  next?: { id?: unknown; time?: unknown; remainingSec?: unknown } | undefined;
}

/**
 * Validate the external JSON by hand rather than trusting it. The stack is
 * another program that can change; a shape change must degrade to the computed
 * fallback, not crash the dashboard (PRD §8, STACK S6).
 */
export function parseStatus(raw: unknown): SalahTimes | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as RawStatus;
  if (!Array.isArray(s.prayers)) return null;

  const prayers: PrayerSlot[] = [];
  for (const entry of s.prayers) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    const id = p.id;
    if (typeof id !== "string" || !PRAYERS.includes(id as PrayerId)) continue;
    if (p.isPrayer === false) continue;
    if (typeof p.time !== "string" || !/^\d{2}:\d{2}$/.test(p.time)) continue;
    prayers.push({
      id: id as PrayerId,
      name: typeof p.name === "string" ? p.name : PRAYER_LABELS[id as PrayerId],
      time: p.time,
      ...(typeof p.autoTime === "string" ? { autoTime: p.autoTime } : {}),
      ...(typeof p.isCustom === "boolean" ? { isCustom: p.isCustom } : {}),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
    });
  }
  if (prayers.length !== 5) return null;

  const currentId = s.current?.id;
  const nextId = s.next?.id;
  const nextTime = s.next?.time;
  const remaining = s.next?.remainingSec;

  return {
    source: "salah-ctl",
    location: typeof s.location === "string" ? s.location : "",
    hijri: typeof s.hijri === "string" ? s.hijri : "",
    ...(typeof (s as { sunrise?: unknown }).sunrise === "string"
      ? { sunrise: (s as { sunrise: string }).sunrise }
      : {}),
    prayers,
    current:
      typeof currentId === "string" && PRAYERS.includes(currentId as PrayerId)
        ? (currentId as PrayerId)
        : null,
    next:
      typeof nextId === "string" && PRAYERS.includes(nextId as PrayerId) && typeof nextTime === "string"
        ? {
            id: nextId as PrayerId,
            time: nextTime,
            remainingSec: typeof remaining === "number" ? remaining : 0,
          }
        : null,
  };
}

/** Run `salah-ctl status`. Read-only; a short timeout keeps the UI responsive. */
export function readSalahStatus(): Promise<SalahTimes | null> {
  return new Promise((resolve) => {
    execFile(SALAH_CTL, ["status"], { timeout: 2500 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(parseStatus(JSON.parse(stdout)));
      } catch {
        resolve(null);
      }
    });
  });
}
