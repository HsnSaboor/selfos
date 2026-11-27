/**
 * Local-date helpers shared by main, preload, and renderer.
 *
 * The local date is the key every table is bucketed by (STACK D-04), so there
 * must be exactly one implementation: a DST or timezone fix applied in one
 * process has to reach the others. `src/main/modules/time/aggregate.ts`
 * re-exports this, so main-process imports keep working.
 */

/** `YYYY-MM-DD` in the machine's local timezone. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's local date key. */
export function todayKey(): string {
  return localDateKey(new Date());
}

/** Add (or subtract) calendar days to a `YYYY-MM-DD` key, in UTC. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Clamp a renderer-supplied day count to the range every range-taking channel
 * shares (1..366). Non-finite values are refused rather than clamped:
 * `Math.min(366, Math.max(1, NaN))` is NaN, and a NaN handed to a date walk
 * throws `Invalid time value` from deep inside `Date`.
 */
export function dayCount(value: unknown, fallback: number): number {
  const days = value ?? fallback;
  if (typeof days !== "number" || !Number.isFinite(days)) {
    throw new Error("days must be a finite number");
  }
  return Math.min(366, Math.max(1, Math.trunc(days)));
}

/**
 * Is this a real `YYYY-MM-DD` calendar date?
 *
 * `local_date` is the key every table is bucketed by (STACK D-04) and the only
 * column most range queries filter on, so a malformed value does not fail — it
 * silently lands outside every `BETWEEN` and `= ?` the app issues. A row written
 * under `"junk"` is invisible to the dashboard, the streak, the heatmap and the
 * daily aggregate at once, with no error anywhere. Verified: `salah.log` with
 * `localDate: "junk"` stored the row and the day then reported 0 logged.
 *
 * The shape check alone is not enough: it accepts `2026-13-45`. The round-trip
 * through `Date` rejects an impossible month or day, and comparing the result
 * back to the input rejects the normalisation `Date` would otherwise apply
 * (`2026-02-30` becomes `2026-03-02`).
 */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  return (
    roundTrip.getUTCFullYear() === y && roundTrip.getUTCMonth() === m - 1 && roundTrip.getUTCDate() === d
  );
}
