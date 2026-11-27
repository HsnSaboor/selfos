import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autostartEnabled, setAutostart } from "../src/main/autostart";
import { contrastPairs, contrastRatio, FALLBACK_THEME } from "../src/main/integrations/omarchy-theme";
import { summarizeDay } from "../src/main/modules/dashboard/summary";
import type { HabitView } from "../src/shared/api";

const habit = (over: Partial<HabitView>): HabitView => ({
  id: 1,
  name: "x",
  kind: "boolean",
  unit: null,
  target: null,
  icon: null,
  color: null,
  schedule: null,
  todayEntry: null,
  streak: { current: 0, longest: 0, unit: "days" },
  completion30d: 0,
  dueToday: true,
  archivedAt: null,
  ...over,
});

describe("summarizeDay", () => {
  it("counts only habits due today, not every logged row", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: undefined,
      habitStates: [
        habit({ id: 1, todayEntry: { localDate: "2026-11-27", value: 1, status: "done" } }),
        habit({ id: 2, todayEntry: { localDate: "2026-11-27", value: 0, status: "skipped" } }),
        habit({ id: 3, dueToday: false }),
      ],
      prayersLogged: 2,
      hijri: "1 Jumada I 1448",
      hijriSource: "computed",
      watchSeconds: 0,
    });
    expect(day.habitsDone).toBe(1);
    expect(day.habitsTotal).toBe(2);
  });

  it("adds browser watch time to local-player media time", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: {
        screen_seconds: 3600,
        focused_seconds: 3000,
        media_seconds: 600,
        reading_seconds: 1200,
        first_activity: 1,
        last_activity: 2,
        switches: 5,
      },
      habitStates: [],
      prayersLogged: 0,
      hijri: "x",
      hijriSource: "salah-ctl",
      watchSeconds: 1800,
    });
    expect(day.mediaSeconds).toBe(600);
    expect(day.watchSeconds).toBe(2400);
  });

  it("keeps the best streak across active habits", () => {
    const day = summarizeDay({
      localDate: "2026-11-27",
      agg: undefined,
      habitStates: [
        habit({ streak: { current: 4, longest: 9, unit: "days" } }),
        habit({ id: 2, streak: { current: 7, longest: 9, unit: "days" } }),
      ],
      prayersLogged: 0,
      hijri: "x",
      hijriSource: "computed",
      watchSeconds: 0,
    });
    expect(day.bestStreak).toBe(7);
  });
});

describe("fallback theme contrast (WCAG AA)", () => {
  it("clears 4.5:1 for every text/surface pair", () => {
    for (const [pair, fg, bg] of contrastPairs(FALLBACK_THEME)) {
      const ratio = contrastRatio(fg, bg);
      expect(Number.isFinite(ratio)).toBe(true);
      expect(ratio, `${pair} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("autostart entry", () => {
  it("writes a --hidden desktop entry and removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "selfos-autostart-"));
    const file = join(dir, "selfos.desktop");
    try {
      expect(autostartEnabled(file)).toBe(false);
      expect(setAutostart(true, file)).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("X-GNOME-Autostart-enabled=true");
      expect(text).toContain("--hidden");
      expect(setAutostart(false, file)).toBe(false);
      expect(autostartEnabled(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
