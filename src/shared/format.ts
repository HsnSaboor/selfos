/**
 * Display formatters shared by the renderer's screens.
 *
 * These were previously copy-pasted per component (four duration formatters,
 * two clock formatters), which let the same value render differently on
 * different screens. Pure functions only — no React, no Electron, no Node.
 */

/**
 * Human duration from seconds: `42s`, `7m`, `1h 05m`.
 *
 * Minutes are zero-padded only when hours are present, so a column of values
 * stays aligned without showing a leading zero on short durations.
 */
export function formatDuration(seconds: number): string {
  // Sub-minute values stay in seconds. Rounding to minutes first (the fix for
  // 3599 s rendering as "60m") also turned 42 s into "1m", which contradicted
  // this function's own contract and overstated short sessions.
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** `HH:MM` in local time, or `fallback` when the value is missing. */
export function formatClock(ms: number | null | undefined, fallback = "—"): string {
  if (ms === null || ms === undefined) return fallback;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `d/m` from a `YYYY-MM-DD` key. */
export function formatShortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d}/${m}`;
}

/** `3 Nov 2026` from a `YYYY-MM-DD` key. */
export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Relative age of a timestamp.
 *
 * Sub-day granularity first (`just now`, `12m ago`, `3h ago`), then
 * `today 14:05` / `yesterday` / `3 days ago` / a date. `coarse` skips the
 * sub-day tiers for "last read"-style labels.
 */
export function formatRelative(
  ms: number | null | undefined,
  { never = "never", coarse = false }: { never?: string; coarse?: boolean } = {},
): string {
  if (!ms) return never;
  const diff = Date.now() - ms;
  // A timestamp in the future (clock skew, a file with a future mtime) would
  // otherwise fall through to `Math.floor(negative / day)` and render
  // "-1 days ago".
  if (diff < 0) return "just now";
  if (!coarse) {
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return `today ${formatClock(ms)}`;
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString();
}

/** Absolute timestamp: `3 Nov, 14:05`. */
export function formatDateTime(ms: number | null | undefined, never = "—"): string {
  if (ms === null || ms === undefined) return never;
  return new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human byte size: `512 B`, `41 KB`, `41.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `3 Nov` from an instant — a compact date with no year. */
export function formatDayMonth(ms: number | null | undefined, never = "—"): string {
  if (ms === null || ms === undefined) return never;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
