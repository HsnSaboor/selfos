import { describe, expect, it, vi } from "vitest";

/**
 * `isIdleBeyond` is the only part of idle detection that measures a duration,
 * and it was previously replaced by a sign test (`idleThresholdMs >= 0`) that
 * made the configured threshold inert. These pin the mapping from Electron's
 * four-state answer, including the two cases that must NOT be collapsed:
 * "unknown" is not "present", and "locked" is away.
 */
const state = vi.fn();

vi.mock("electron", () => ({
  powerMonitor: {
    getSystemIdleState: (threshold: number) => state(threshold),
  },
}));

const { isIdleBeyond } = await import("../src/main/integrations/hyprland/idle");

describe("isIdleBeyond", () => {
  it("converts milliseconds to the seconds Electron expects", () => {
    state.mockReturnValue("active");
    isIdleBeyond(120_000);
    expect(state).toHaveBeenCalledWith(120);
  });

  it("treats active as present", () => {
    state.mockReturnValue("active");
    expect(isIdleBeyond(120_000)).toBe(false);
  });

  it("treats idle as away", () => {
    state.mockReturnValue("idle");
    expect(isIdleBeyond(120_000)).toBe(true);
  });

  it("treats locked as away, because the session is not in use", () => {
    state.mockReturnValue("locked");
    expect(isIdleBeyond(120_000)).toBe(true);
  });

  it("reports unknown rather than guessing", () => {
    // Returning `false` here would bill an unattributable gap to the last app;
    // returning `true` would pause tracking on a signal we do not have. The
    // caller falls back to loginctl's hint instead.
    state.mockReturnValue("unknown");
    expect(isIdleBeyond(120_000)).toBeNull();
  });

  it("reports unknown when the call throws", () => {
    state.mockImplementation(() => {
      throw new Error("powerMonitor unavailable");
    });
    expect(isIdleBeyond(120_000)).toBeNull();
  });
});
