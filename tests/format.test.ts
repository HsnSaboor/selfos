import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatClock,
  formatDayMonth,
  formatDuration,
  formatLongDate,
  formatRelative,
  formatShortDate,
} from "../src/shared/format";

describe("formatDuration", () => {
  it("rounds to minutes before choosing a branch", () => {
    // 3599 s is 59.98 minutes: it must not render as "60m" in one place and
    // "1h 00m" in another depending on which branch rounds.
    expect(formatDuration(3599)).toBe("1h 00m");
    expect(formatDuration(3540)).toBe("59m");
  });

  it("keeps short durations in seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(59)).toBe("59s");
    // 60 s is a full minute.
    expect(formatDuration(60)).toBe("1m");
    // 89 s rounds to 1 minute, not to "1m 29s" or "2m".
    expect(formatDuration(89)).toBe("1m");
  });

  it("zero-pads minutes only when hours are present", () => {
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(300)).toBe("5m");
  });
});

describe("formatShortDate / formatLongDate", () => {
  it("reads a YYYY-MM-DD key without a timezone shift", () => {
    expect(formatShortDate("2026-11-03")).toBe("3/11");
    expect(formatLongDate("2026-11-03")).toContain("2026");
    expect(formatLongDate("2026-11-03")).toContain("Nov");
  });
});

describe("formatClock", () => {
  it("falls back for a missing value", () => {
    expect(formatClock(null)).toBe("—");
    expect(formatClock(undefined)).toBe("—");
    expect(formatClock(null, "never")).toBe("never");
  });
});

describe("formatRelative", () => {
  it("uses sub-day tiers when not coarse", () => {
    const now = Date.now();
    expect(formatRelative(now - 5_000)).toBe("just now");
    expect(formatRelative(now - 12 * 60_000)).toBe("12m ago");
    expect(formatRelative(now - 3 * 3_600_000)).toBe("3h ago");
  });

  it("skips the sub-day tiers when coarse", () => {
    const now = Date.now();
    expect(formatRelative(now - 3 * 3_600_000, { coarse: true })).toMatch(/^today /);
  });

  it("never renders a negative age for a future timestamp", () => {
    const future = Date.now() + 60 * 60_000;
    const out = formatRelative(future);
    expect(out).not.toContain("-");
    expect(out).toBe("just now");
  });

  it("uses the caller's fallback for a missing value", () => {
    expect(formatRelative(null)).toBe("never");
    expect(formatRelative(undefined, { never: "—" })).toBe("—");
  });
});

describe("formatBytes", () => {
  it("switches unit at the right boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("does not render a 41 MB database as 41984 KB", () => {
    // The dashboard's own conversion did exactly that: it always divided by
    // 1024 and always appended "KB".
    expect(formatBytes(41 * 1024 * 1024)).toBe("41.0 MB");
  });

  it("renders a dash for a non-finite or negative size", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatDayMonth", () => {
  it("renders a compact day and month with no year", () => {
    const ms = new Date(2026, 10, 3, 12).getTime();
    expect(formatDayMonth(ms)).toBe("3 Nov");
  });

  it("falls back for a missing instant", () => {
    expect(formatDayMonth(null)).toBe("—");
    expect(formatDayMonth(undefined)).toBe("—");
  });
});
