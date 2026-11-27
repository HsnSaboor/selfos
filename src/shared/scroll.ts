/**
 * Reading-position scroll maths, shared by the reader and its tests.
 *
 * `reading_position.scroll_offset` is declared 0..1 within the page
 * (STACK §4.2), but the reader used to store `scrollTop` in CSS pixels. The
 * content height is the raster height, which changes with zoom and with the
 * window width, so a pixel offset restored after either change landed
 * somewhere else. These two functions are the conversion, kept pure so the
 * round trip is testable without a browser.
 */

/**
 * Scroll position as a 0..1 fraction of the scrollable range.
 *
 * Divides by the range (`scrollHeight - clientHeight`), not by `scrollHeight`:
 * at the bottom of the page `scrollTop` equals the range, so normalizing by
 * `scrollHeight` would store less than 1 at the very end and restore short of
 * it. A container that cannot scroll has no position to remember.
 */
export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  const range = scrollHeight - clientHeight;
  if (!Number.isFinite(range) || range <= 0) return 0;
  if (!Number.isFinite(scrollTop)) return 0;
  return Math.min(1, Math.max(0, scrollTop / range));
}

/** Inverse of `scrollFraction`: the pixel offset for a stored fraction. */
export function scrollTopFor(fraction: number, scrollHeight: number, clientHeight: number): number {
  const range = scrollHeight - clientHeight;
  if (!Number.isFinite(range) || range <= 0) return 0;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction)) * range;
}
