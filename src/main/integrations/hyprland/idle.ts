/**
 * Idle / lock detection for the collector.
 *
 * STACK §2.6 prescribes three signals, and all three are used here:
 *  - `powerMonitor.getSystemIdleState(threshold)` — "Primary idle signal on
 *    Linux", and the only one that actually measures an idle *duration*.
 *  - `loginctl show-session -p LockedHint -p IdleHint` — "Fallback/authority on
 *    Wayland", polled every 5 s.
 *  - `hyprctl -j monitors` — DPMS state.
 *
 * `powerMonitor`'s lock/unlock events are macOS/Windows only, so the lock
 * authority on Linux is `loginctl`. Suspend/resume/shutdown are wired in the
 * collector, where the segment that must be closed lives.
 */
import { execFile } from "node:child_process";
import { powerMonitor } from "electron";

export interface ActivityState {
  locked: boolean;
  idle: boolean;
  dpmsOff: boolean;
  /** Reason tracking should pause, or null when the user is present. */
  pauseReason: "locked" | "idle" | "dpms-off" | null;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function readSessionState(sessionId: string): Promise<{ locked: boolean; idle: boolean }> {
  try {
    const out = await run("loginctl", ["show-session", sessionId, "-p", "LockedHint", "-p", "IdleHint"]);
    const locked = /LockedHint=yes/.test(out);
    const idle = /IdleHint=yes/.test(out);
    return { locked, idle };
  } catch {
    return { locked: false, idle: false };
  }
}

export async function readDpmsOff(): Promise<boolean> {
  try {
    const out = await run("hyprctl", ["-j", "monitors"]);
    const monitors = JSON.parse(out) as Array<{ dpmsStatus?: boolean }>;
    if (!Array.isArray(monitors) || monitors.length === 0) return false;
    // All monitors off == the machine is effectively not in use.
    return monitors.every((m) => m.dpmsStatus === false);
  } catch {
    return false;
  }
}

/**
 * Is the user away for longer than `thresholdMs`?
 *
 * `powerMonitor.getSystemIdleState` is the only signal here that measures an
 * idle *duration*. The previous code used the threshold as a sign test
 * (`idleThresholdMs >= 0`) and then read the session's binary `IdleHint`, so the
 * configured 120 s was decorative: tracking paused only if the compositor
 * happened to set the hint, which is not the same thing and is not in our
 * control. An AFK afternoon with a window focused was billed as focus.
 *
 * Returns null when the answer is unavailable, so the caller falls back to the
 * lock hint rather than treating "unknown" as "present" or as "away".
 */
export function isIdleBeyond(thresholdMs: number): boolean | null {
  try {
    const state = powerMonitor.getSystemIdleState(thresholdMs);
    // `locked` counts as away: the session is not in use either way.
    if (state === "active") return false;
    if (state === "idle" || state === "locked") return true;
    return null; // "unknown"
  } catch {
    return null;
  }
}

export async function readActivityState(sessionId: string, idleThresholdMs: number): Promise<ActivityState> {
  const [{ locked, idle }, dpmsOff] = await Promise.all([readSessionState(sessionId), readDpmsOff()]);
  // The measured idle state wins where it is available; `loginctl`'s IdleHint is
  // the documented Wayland authority and remains the fallback.
  const measured = isIdleBeyond(idleThresholdMs);
  const away = measured ?? idle;
  const pauseReason = locked ? "locked" : away ? "idle" : dpmsOff ? "dpms-off" : null;
  return { locked, idle: away, dpmsOff, pauseReason };
}
