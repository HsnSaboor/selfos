/**
 * Time collector (STACK.md §5.2).
 *
 * Owns the Hyprland client, the segment builder, idle detection, and writes to
 * `focus_event`. Designed to be startable/stoppable without leaking sockets or
 * timers, and to never attribute a gap to the previously focused app.
 */
import { execFileSync } from "node:child_process";
import { powerMonitor } from "electron";
import { isSelfOSApp } from "../../../shared/api";
import type { Db } from "../../db/driver";
import { guessSite, isBrowserClass, pageTitle } from "../../integrations/browser-history/title";
import { HyprlandClient } from "../../integrations/hyprland/client";
import { type FocusSegment, SegmentBuilder, SegmentMerger } from "../../integrations/hyprland/events";
import { readActivityState } from "../../integrations/hyprland/idle";
import { localDateKey, rebuildDay } from "../../modules/time/aggregate";

export interface CollectorStatus {
  running: boolean;
  paused: boolean;
  connected: boolean;
  lastEventAt: number | null;
  lastFlushAt: number | null;
  lastGapAt: number | null;
  pauseReason: string | null;
  segmentsWritten: number;
  eventCounts: Record<string, number>;
  error: string | null;
}

export interface CollectorOptions {
  sessionId: string;
  flushIntervalMs?: number;
  idlePollMs?: number;
  idleThresholdMs?: number;
  rebuildIntervalMs?: number;
  socketPath?: string;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Split a focus segment at each local midnight it crosses.
 *
 * A segment that runs 23:00–01:00 belongs to two days. `local_date` is derived
 * from `started_at`, so without this the whole segment lands on the first day:
 * that day is over-counted, the next day shows zero, and the 24-hour profile
 * places the post-midnight hour in the previous day.
 */
export function splitAtMidnight(seg: FocusSegment): FocusSegment[] {
  const parts: FocusSegment[] = [];
  let start = seg.startedAt;
  while (start < seg.endedAt) {
    const d = new Date(start);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
    const end = Math.min(seg.endedAt, nextMidnight);
    // Guard against a zero-length or non-advancing boundary.
    if (end <= start) break;
    parts.push({ ...seg, startedAt: start, endedAt: end });
    start = end;
  }
  return parts;
}

export class TimeCollector {
  #db: Db;
  #opts: Required<Omit<CollectorOptions, "socketPath">> & { socketPath?: string };
  #client: HyprlandClient | null = null;
  #builder = new SegmentBuilder();
  /**
   * Absorbs sub-second flickers before a segment is written.
   *
   * `mergeSegments` was written and unit-tested for exactly this (STACK §5.2
   * step 4, and the flicker fix recorded in `spikes/RESULTS.md`), but nothing on
   * the ingest path called it — so the fix it describes never ran and the
   * timeline filled with the fragments it was meant to remove. This is the
   * streaming form of the same rule; see `SegmentMerger`.
   */
  #merger = new SegmentMerger();
  #paused = false;
  #running = false;
  #lastEventAt: number | null = null;
  #lastFlushAt: number | null = null;
  #lastGapAt: number | null = null;
  #pauseReason: string | null = null;
  #segmentsWritten = 0;
  #eventCounts: Record<string, number> = {};
  #error: string | null = null;
  #dirtyDates = new Set<string>();
  #flushTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #rebuildTimer: NodeJS.Timeout | null = null;
  #lastWorkspace: string | null = null;
  #lastTitle = "";
  #titleProfile: number | null = null;
  /** App classes the user excluded (F-SET-01); never written as events. */
  #excluded = new Set<string>();

  constructor(db: Db, opts: CollectorOptions) {
    this.#db = db;
    this.#opts = {
      flushIntervalMs: 10_000,
      idlePollMs: 5_000,
      idleThresholdMs: 120_000,
      rebuildIntervalMs: 60_000,
      now: () => Date.now(),
      ...opts,
    };
  }

  get running(): boolean {
    return this.#running;
  }

  /** Excluded app classes, normalised the same way events are. */
  excludedApps(): string[] {
    return [...this.#excluded];
  }

  /**
   * Replace the excluded-app set (F-SET-01).
   *
   * Exclusion applies to events written from now on; rows already stored are
   * left alone, because deleting history behind a settings change is the
   * `data.deleteRange` action's job, not a side effect of a checkbox.
   */
  setExcluded(classes: string[]): void {
    this.#excluded = new Set(
      classes.map((c) => TimeCollector.#normalizeClass(c.trim().toLowerCase())).filter(Boolean),
    );
  }

  status(): CollectorStatus {
    return {
      running: this.#running,
      // An automatic pause (lock, idle, lost socket) is still a pause. Reporting
      // only the manual flag made the health page say "active" while the
      // collector had no open segment and was writing nothing.
      paused: this.#paused || this.#pauseReason !== null,
      connected: this.#client?.connected ?? false,
      lastEventAt: this.#lastEventAt,
      lastFlushAt: this.#lastFlushAt,
      lastGapAt: this.#lastGapAt,
      pauseReason: this.#pauseReason,
      segmentsWritten: this.#segmentsWritten,
      eventCounts: { ...this.#eventCounts },
      error: this.#error,
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#error = null;

    // Reconcile once so the first segment starts from real state rather than
    // waiting for the user to change focus.
    const initial = this.#reconcile();
    if (initial) this.#builder.sample({ ...initial, at: this.#opts.now() }, "hyprctl-reconcile");

    this.#client = new HyprlandClient({
      ...(this.#opts.socketPath ? { signature: undefined, runtimeDir: undefined } : {}),
      onFocus: (appClass, appTitle) => this.#onFocus(appClass, appTitle),
      onTitle: (title) => this.#onTitle(title),
      onWorkspace: (id) => {
        this.#lastWorkspace = id;
      },
      onConnected: () => {
        this.#error = null;
        // Reconnect may follow a gap; start a fresh segment from real state.
        const s = this.#reconcile();
        if (s) this.#builder.sample({ ...s, at: this.#opts.now() }, "hyprctl-reconcile");
      },
      onDisconnected: (reason) => this.#onDisconnected(reason),
      onEvent: (name) => {
        this.#eventCounts[name] = (this.#eventCounts[name] ?? 0) + 1;
        this.#lastEventAt = this.#opts.now();
      },
    });
    this.#client.start();

    this.#flushTimer = setInterval(() => this.#flush(), this.#opts.flushIntervalMs);
    this.#idleTimer = setInterval(() => void this.#pollIdle(), this.#opts.idlePollMs);
    this.#rebuildTimer = setInterval(() => this.#rebuildDirty(), this.#opts.rebuildIntervalMs);

    // Immediate events, not polled: see #onSuspend.
    powerMonitor.on("suspend", this.#onSuspend);
    powerMonitor.on("resume", this.#onResume);
    powerMonitor.on("shutdown", this.#onSuspend);
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#client?.stop();
    this.#client = null;
    for (const t of [this.#flushTimer, this.#idleTimer, this.#rebuildTimer]) if (t) clearInterval(t);
    // Listeners on a module-owned emitter must come off, or a restart would
    // leave a second pair attached to the same singleton.
    powerMonitor.off("suspend", this.#onSuspend);
    powerMonitor.off("resume", this.#onResume);
    powerMonitor.off("shutdown", this.#onSuspend);
    this.#flushTimer = this.#idleTimer = this.#rebuildTimer = null;
    this.#flush();
    // Shutdown is a gap: release the held tail so no tracked time is lost.
    this.#commitGap();
  }

  setPaused(paused: boolean, reason = "manual"): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#pauseReason = paused ? reason : null;
    if (paused) {
      // Close the open segment so paused time is never attributed.
      this.#commit(this.#builder.close(this.#opts.now()));
      this.#commitGap();
      this.#lastGapAt = this.#opts.now();
    } else {
      const s = this.#reconcile();
      if (s) this.#builder.sample({ ...s, at: this.#opts.now() }, "hyprctl-reconcile");
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * SelfOS reports its Wayland app_id as `electron` (it cannot be changed from
   * inside the process — see launch-mode.ts). Recording that verbatim would
   * conflate SelfOS with any other Electron app on the machine, including T3
   * Code, which is what `isSelfOSApp` exists to prevent. The class is
   * normalised here so both the event path and the reconcile path agree.
   */
  static #normalizeClass(appClass: string): string {
    return isSelfOSApp(appClass) ? "selfos" : appClass;
  }

  #onFocus(appClass: string, appTitle: string): void {
    const now = this.#opts.now();
    if (this.#paused) return;
    this.#lastTitle = appTitle;
    const closed = this.#builder.sample({
      at: now,
      appClass: TimeCollector.#normalizeClass(appClass),
      appTitle,
      workspaceId: this.#lastWorkspace,
    });
    this.#commit(closed);
  }

  #onTitle(title: string): void {
    if (this.#paused) return;
    if (title === this.#lastTitle) return;
    this.#lastTitle = title;
    this.#builder.retitle(title);
  }

  #onDisconnected(reason: string): void {
    // A lost socket is a tracking gap, not a continuation of the last app.
    const now = this.#opts.now();
    this.#commit(this.#builder.close(now));
    // The tail has no successor to merge into; write it rather than hold it.
    this.#commitGap();
    this.#lastGapAt = now;
    if (reason !== "closed") this.#error = `hyprland socket: ${reason}`;
  }

  #reconcile(): { appClass: string; appTitle: string; workspaceId: string | null } | null {
    try {
      const out = execFileSync("hyprctl", ["-j", "activewindow"], { encoding: "utf8", timeout: 2000 });
      const j = JSON.parse(out) as { class?: string; title?: string; workspace?: { id?: number | string } };
      const ws = j.workspace?.id;
      this.#lastWorkspace = ws !== undefined ? String(ws) : this.#lastWorkspace;
      return {
        appClass: TimeCollector.#normalizeClass(j.class ?? ""),
        appTitle: j.title ?? "",
        workspaceId: this.#lastWorkspace,
      };
    } catch {
      return null;
    }
  }

  async #pollIdle(): Promise<void> {
    if (this.#paused || !this.#running) return;
    const state = await readActivityState(this.#opts.sessionId, this.#opts.idleThresholdMs);
    if (state.pauseReason) {
      const now = this.#opts.now();
      this.#commit(this.#builder.close(now));
      this.#commitGap();
      this.#lastGapAt = now;
      this.#pauseReason = state.pauseReason;
    } else if (this.#pauseReason && this.#pauseReason !== "manual") {
      this.#pauseReason = null;
      const s = this.#reconcile();
      if (s) this.#builder.sample({ ...s, at: this.#opts.now() }, "hyprctl-reconcile");
    }
  }

  /**
   * Suspend, resume and shutdown, wired to the segment lifecycle.
   *
   * STACK §2.6: "Close the open segment on suspend; reconcile on resume" and
   * "Flush the open segment before exit". Without these the 5 s poll is the only
   * defence, and it cannot cover suspend at all: the process is frozen, so no
   * timer runs, and the usual wake cause is user input — which returns the lock
   * hint to "present" before the next poll. The segment opened before suspend
   * then stays open and its `ended_at` becomes the *next focus change*: a laptop
   * closed at 23:00 and reopened at 07:00 was recorded as eight hours of focused
   * time on the last app. That is exactly what F-TIME-02 and N-REL-04 forbid.
   */
  #onSuspend = (): void => {
    const now = this.#opts.now();
    this.#commit(this.#builder.close(now));
    this.#commitGap();
    this.#lastGapAt = now;
  };

  #onResume = (): void => {
    // Suspend was a gap, so start a fresh segment from real state rather than
    // resuming one that would span it.
    if (this.#paused) return;
    const s = this.#reconcile();
    if (s) this.#builder.sample({ ...s, at: this.#opts.now() }, "hyprctl-reconcile");
  };

  #flush(): void {
    const now = this.#opts.now();
    const open = this.#builder.current();
    if (!open) {
      this.#lastFlushAt = now;
      return;
    }
    // Write a snapshot of the open segment without closing it, so a crash loses
    // at most flushIntervalMs (N-REL-01). Marked provisional so the final row
    // replaces it instead of stacking on top.
    this.#writeRow({ ...open, endedAt: now, provisional: true });
    this.#lastFlushAt = now;
    this.#lastEventAt = this.#lastEventAt ?? now;
  }

  #commit(seg: FocusSegment | null): void {
    if (seg) this.#commitParts(this.#merger.push(seg));
    // Rebuild once per commit, not once per part or per gap.
    this.#rebuildDirty();
  }

  /**
   * Release the held segment because tracking stopped for a while.
   *
   * A gap means the pending tail has no successor to be merged into, so holding
   * it would defer real time until the next unrelated event.
   */
  #commitGap(): void {
    this.#commitParts(this.#merger.flush());
    this.#rebuildDirty();
  }

  #commitParts(parts: FocusSegment[]): void {
    for (const seg of parts) {
      // Split at local midnight: a film from 23:00 to 01:00 belongs to two days,
      // and attributing the whole segment to its start date inflates that day
      // and leaves the next day empty.
      for (const part of splitAtMidnight(seg)) this.#writeRow(part);
    }
  }

  #writeRow(seg: FocusSegment): void {
    const date = localDateKey(new Date(seg.startedAt));
    // An excluded app is not tracked at all: no row, no aggregate contribution.
    if (this.#excluded.has(TimeCollector.#normalizeClass(seg.appClass))) return;
    try {
      // A snapshot row for an still-open segment is provisional: remove it
      // before writing the final row so the range is never counted twice.
      this.#db.run(
        "DELETE FROM focus_event WHERE started_at = ? AND source LIKE ?",
        seg.startedAt,
        "%:snapshot",
      );
      const source = seg.provisional ? `${seg.source}:snapshot` : seg.source;
      this.#db.run(
        `INSERT INTO focus_event
           (started_at, ended_at, local_date, app_class, app_title, workspace_id, monitor_id, source, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        seg.startedAt,
        seg.endedAt,
        date,
        seg.appClass,
        seg.appTitle,
        seg.workspaceId,
        source,
        this.#opts.sessionId,
        Date.now(),
      );
      this.#segmentsWritten++;
      this.#dirtyDates.add(date);
      // Only the final row carries the real duration. A provisional snapshot is
      // re-written every flush interval at the same key, so attributing it
      // would leave the site row stuck at one interval's worth of time.
      if (!seg.provisional) this.#attributeSite(seg, date);
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Window-title fallback for site time (F-TIME-05).
   *
   * Only browser windows whose title names a recognisable site produce a row,
   * and only the focused seconds of that segment are attributed. History
   * ingestion later fills in the same domains; `siteUsage` reconciles the two
   * by taking the larger, so this never double counts.
   */
  #attributeSite(seg: FocusSegment, localDate: string): void {
    if (!isBrowserClass(seg.appClass)) return;
    const guess = guessSite(seg.appTitle);
    if (!guess) return;
    const seconds = Math.max(0, Math.round((seg.endedAt - seg.startedAt) / 1000));
    if (seconds <= 0) return;
    try {
      this.#db.run(
        `INSERT INTO browser_visit
           (profile_id, url, title, domain, visit_time_us, visit_at, local_date,
            duration_us, transition, source, ingest_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'window-title', NULL)
         ON CONFLICT(profile_id, url, visit_time_us) DO UPDATE SET
           duration_us = MAX(duration_us, excluded.duration_us)`,
        this.#titleProfileId(),
        `https://${guess.site}/`,
        pageTitle(seg.appTitle),
        guess.site,
        BigInt(seg.startedAt) * 1000n,
        seg.startedAt,
        localDate,
        BigInt(seconds) * 1_000_000n,
      );
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Synthetic profile that owns window-title rows, created on first use. */
  #titleProfileId(): number {
    if (this.#titleProfile !== null) return this.#titleProfile;
    this.#db.run(
      `INSERT INTO browser_profile (browser, profile_dir, history_path)
       VALUES ('window-title', '__window_title__', '')
       ON CONFLICT(profile_dir) DO NOTHING`,
    );
    const row = this.#db.get<{ id: number }>(
      "SELECT id FROM browser_profile WHERE profile_dir = '__window_title__'",
    );
    this.#titleProfile = row?.id ?? 0;
    return this.#titleProfile;
  }

  #rebuildDirty(): void {
    for (const date of this.#dirtyDates) {
      try {
        rebuildDay(this.#db, date);
      } catch (err) {
        this.#error = err instanceof Error ? err.message : String(err);
      }
    }
    this.#dirtyDates.clear();
  }

  /** Force a rebuild for a date (used by the health page). */
  rebuild(localDate: string): void {
    rebuildDay(this.#db, localDate);
  }
}
