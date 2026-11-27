/**
 * Hyprland event stream parsing and focus-segment construction.
 *
 * Pure functions only — no I/O — so the segment logic can be tested by
 * replaying recorded events (STACK.md §5.2, §12.3).
 */

export interface FocusSample {
  at: number;
  appClass: string;
  appTitle: string;
  workspaceId: string | null;
}

export interface FocusSegment {
  startedAt: number;
  endedAt: number;
  appClass: string;
  appTitle: string;
  workspaceId: string | null;
  source: "hypr-ipc" | "hyprctl-reconcile" | "title-site-change";
  /** Set on snapshot rows that the final row will replace. */
  provisional?: boolean;
}

export interface HyprEvent {
  name: string;
  data: string;
}

/** Parse one `event>>data` line. Returns null for blank/greeting lines. */
export function parseEventLine(line: string): HyprEvent | null {
  const idx = line.indexOf(">>");
  if (idx <= 0) return null;
  return { name: line.slice(0, idx), data: line.slice(idx + 2) };
}

/** Split a chunk into complete lines, returning the unterminated remainder. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/**
 * `activewindow>>CLASS,TITLE`. The title may contain commas, so only the first
 * comma is a separator. A CLASS of `,` (empty class) means the focused surface
 * is a layer shell (e.g. the bar), not an application.
 */
export function parseActiveWindow(data: string): { appClass: string; appTitle: string } {
  const comma = data.indexOf(",");
  if (comma < 0) return { appClass: data.trim(), appTitle: "" };
  return { appClass: data.slice(0, comma).trim(), appTitle: data.slice(comma + 1) };
}

/** `activewindowv2>>ADDRESS` carries only the window address. */
export function parseActiveWindowV2(data: string): { address: string } {
  return { address: data.trim() };
}

/**
 * Merge adjacent segments that share app + title. Hyprland emits redundant
 * activewindow events on some transitions; without this the timeline fills with
 * sub-second fragments (STACK.md §5.2 step 4).
 */
export function mergeSegments(segments: FocusSegment[], minMs = 1000): FocusSegment[] {
  const merged: FocusSegment[] = [];
  for (const original of segments) {
    const seg = { ...original };
    const prev = merged[merged.length - 1];
    if (prev) {
      const contiguous = prev.endedAt === seg.startedAt;
      const sameApp = prev.appClass === seg.appClass && prev.appTitle === seg.appTitle;
      const prevTiny = prev.endedAt - prev.startedAt < minMs;

      if (sameApp) {
        prev.endedAt = seg.endedAt;
        continue;
      }
      if (contiguous && prevTiny) {
        // A sub-threshold flicker must be absorbed by the segment that follows
        // it, not the other way round — otherwise a 200 ms blip would claim the
        // next several seconds of a different app.
        merged.pop();
        seg.startedAt = prev.startedAt;
      }
    }
    merged.push(seg);
  }
  return merged;
}

/**
 * Build segments from a time-ordered sample stream. A sample opens a segment;
 * the next sample closes it. `gapAfter` marks a period where tracking was
 * suspended (lock/idle/DPMS/socket loss) so the gap is never attributed to the
 * last focused app (F-TIME-02, F-TIME-11).
 */
export class SegmentBuilder {
  #open: FocusSegment | null = null;

  current(): FocusSegment | null {
    return this.#open;
  }

  /** Close the open segment at `at` and return it (may be null). */
  close(at: number): FocusSegment | null {
    if (!this.#open) return null;
    const seg = this.#open;
    this.#open = null;
    if (at <= seg.startedAt) return null;
    return { ...seg, endedAt: at };
  }

  /** Close any open segment and start a new one. */
  sample(s: FocusSample, source: FocusSegment["source"] = "hypr-ipc"): FocusSegment | null {
    const closed = this.close(s.at);
    // A layer-shell surface (bar, lock screen) reports an empty class.
    if (!s.appClass) return closed;
    this.#open = {
      startedAt: s.at,
      endedAt: s.at,
      appClass: s.appClass,
      appTitle: s.appTitle,
      workspaceId: s.workspaceId,
      source,
    };
    return closed;
  }

  /** Update the title of the open segment without starting a new one. */
  retitle(title: string): void {
    if (this.#open) this.#open.appTitle = title;
  }
}

/**
 * Merge a closed segment into the run being written, absorbing sub-second
 * flickers the way a whole-stream merge would — but streaming, one segment at a time.
 *
 * Why a streaming merger rather than a whole-array merge:
 * the collector writes each
 * segment as it closes so a crash loses at most one flush interval (N-REL-01).
 * Buffering the day to merge it at the end would trade a documented correctness
 * bug for a data-loss window.
 *
 * The rule is the one
 * `spikes/RESULTS.md` records fixing: a segment shorter than `minMs` is absorbed
 * **backward** into the segment that follows it, because a 200 ms blip must not
 * claim the next several seconds of a different app.
 *
 * Callers must `flush()` on a gap (disconnect, idle, pause, shutdown) — a gap
 * means the pending tail has no successor to be merged into, so holding it would
 * defer real time indefinitely.
 */
export class SegmentMerger {
  /** The most recent segment, still mutable: a later one may absorb it. */
  #pending: FocusSegment | null = null;
  #minMs: number;

  constructor(minMs = 1000) {
    this.#minMs = minMs;
  }

  /**
   * Take one closed segment, returning the segments that are now final.
   *
   * A pending segment is only held while it is short enough to be absorbed. The
   * moment a segment is long enough to stand on its own it is released, so at
   * most one segment is ever held back.
   */
  push(seg: FocusSegment): FocusSegment[] {
    if (seg.endedAt <= seg.startedAt) return [];
    const out: FocusSegment[] = [];
    const pending = this.#pending;
    if (pending) {
      const contiguous = pending.endedAt === seg.startedAt;
      const sameApp = pending.appClass === seg.appClass && pending.appTitle === seg.appTitle;
      if (sameApp && contiguous) {
        // Redundant activewindow event: extend the pending run in place. A
        // same-app segment after a hole is a new run, not a continuation —
        // merging across the hole invents time (round-12 nit).
        pending.endedAt = seg.endedAt;
        return out;
      }
      if (contiguous && pending.endedAt - pending.startedAt < this.#minMs) {
        // The flicker is absorbed by the segment that follows it.
        seg = { ...seg, startedAt: pending.startedAt };
        this.#pending = null;
      } else {
        // The pending segment stands on its own; release it.
        this.#pending = null;
        out.push(pending);
      }
    }
    this.#pending = seg;
    return out;
  }

  /** Release the held segment, if any. Used on every gap and on shutdown. */
  flush(): FocusSegment[] {
    const pending = this.#pending;
    this.#pending = null;
    return pending ? [pending] : [];
  }
}
