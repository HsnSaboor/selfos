import { describe, expect, it } from "vitest";
import {
  buildDayState,
  classifyLog,
  type PrayerWindows,
  prayerStreak,
  qadaDebt,
  settledPrayers,
  windowEnd,
} from "../src/main/modules/salah/log";

// Typical Gujranwala winter times (matches the live salah-ctl output).
const WINDOWS: PrayerWindows = {
  starts: { fajr: "05:20", dhuhr: "13:15", asr: "16:00", maghrib: "17:15", isha: "19:00" },
  sunrise: "06:21",
  fajrTomorrow: "05:21",
};

const at = (hm: string) => {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

describe("windowEnd", () => {
  it("closes Fajr at sunrise, not at Dhuhr", () => {
    expect(windowEnd("fajr", WINDOWS)).toBe(at("06:21"));
    // Without sunrise information it falls back to Dhuhr.
    expect(windowEnd("fajr", { ...WINDOWS, sunrise: undefined })).toBe(at("13:15"));
  });

  it("closes each window at the next prayer", () => {
    expect(windowEnd("dhuhr", WINDOWS)).toBe(at("16:00"));
    expect(windowEnd("asr", WINDOWS)).toBe(at("17:15"));
    expect(windowEnd("maghrib", WINDOWS)).toBe(at("19:00"));
  });

  it("closes Isha at tomorrow's Fajr", () => {
    expect(windowEnd("isha", WINDOWS)).toBe(at("05:21"));
  });
});

describe("classifyLog", () => {
  it("is on time inside the window", () => {
    expect(classifyLog("dhuhr", at("13:30"), WINDOWS)).toBe("on_time");
    expect(classifyLog("dhuhr", at("15:59"), WINDOWS)).toBe("on_time");
  });

  it("is late after the window closes", () => {
    expect(classifyLog("dhuhr", at("16:01"), WINDOWS)).toBe("late");
  });

  it("treats a log before the prayer's time as late (an early make-up)", () => {
    expect(classifyLog("asr", at("10:00"), WINDOWS)).toBe("late");
  });

  it("handles Isha's midnight crossing", () => {
    expect(classifyLog("isha", at("23:00"), WINDOWS)).toBe("on_time");
    // 01:00 next day is still inside Isha's window.
    expect(classifyLog("isha", at("01:00"), WINDOWS)).toBe("on_time");
    // 05:21 is the boundary (tomorrow's Fajr).
    expect(classifyLog("isha", at("05:21"), WINDOWS)).toBe("on_time");
  });
});

describe("settledPrayers", () => {
  it("settles only prayers whose window has closed", () => {
    expect(settledPrayers(at("12:00"), WINDOWS)).toEqual(["fajr"]);
    expect(settledPrayers(at("16:30"), WINDOWS)).toEqual(["fajr", "dhuhr"]);
    expect(settledPrayers(at("19:05"), WINDOWS)).toEqual(["fajr", "dhuhr", "asr", "maghrib"]);
  });

  it("settles nothing before Fajr", () => {
    expect(settledPrayers(at("04:00"), WINDOWS)).toEqual([]);
  });
});

describe("buildDayState", () => {
  const logs = [
    {
      localDate: "2026-11-02",
      prayer: "fajr" as const,
      status: "on_time" as const,
      jamaah: true,
      masjid: null,
      prayerTime: "05:20",
      loggedAt: 1,
    },
    {
      localDate: "2026-11-02",
      prayer: "dhuhr" as const,
      status: "late" as const,
      jamaah: false,
      masjid: null,
      prayerTime: "13:15",
      loggedAt: 2,
    },
  ];

  it("reports logged, on-time, and missed counts", () => {
    const state = buildDayState("2026-11-02", WINDOWS, logs, at("17:00"));
    expect(state.logged).toBe(2);
    expect(state.onTime).toBe(1);
    // At 17:00 only Fajr and Dhuhr have closed, and both were logged.
    expect(state.missed).toBe(0);
    expect(state.complete).toBe(false);
  });

  it("marks unlogged future prayers as upcoming, not missed", () => {
    const state = buildDayState("2026-11-02", WINDOWS, logs, at("12:00"));
    const isha = state.prayers.find((p) => p.id === "isha");
    expect(isha?.expectedStatus).toBe("upcoming");
  });

  it("marks a prayer open while its window is running", () => {
    const state = buildDayState("2026-11-02", WINDOWS, logs, at("16:30"));
    const asr = state.prayers.find((p) => p.id === "asr");
    expect(asr?.expectedStatus).toBe("open");
  });

  it("is complete when all five are logged with none missed", () => {
    const all = (["fajr", "dhuhr", "asr", "maghrib", "isha"] as const).map((prayer) => ({
      localDate: "2026-11-02",
      prayer,
      status: "on_time" as const,
      jamaah: false,
      masjid: null,
      prayerTime: "00:00",
      loggedAt: 1,
    }));
    const state = buildDayState("2026-11-02", WINDOWS, all, at("23:00"));
    expect(state.complete).toBe(true);
    expect(state.missed).toBe(0);
  });

  it("does not write missed prayers to the log", () => {
    const state = buildDayState("2026-11-02", WINDOWS, logs, at("17:00"));
    expect(state.prayers.filter((p) => p.status !== null)).toHaveLength(2);
  });
});

describe("qadaDebt", () => {
  it("accumulates per prayer and totals", () => {
    const debt = qadaDebt([
      { prayer: "fajr", delta: 1, localDate: "2026-11-01" },
      { prayer: "fajr", delta: 1, localDate: "2026-11-02" },
      { prayer: "isha", delta: 1, localDate: "2026-11-02" },
    ]);
    expect(debt.byPrayer.fajr).toBe(2);
    expect(debt.byPrayer.isha).toBe(1);
    expect(debt.total).toBe(3);
  });

  it("repayments reduce debt", () => {
    const debt = qadaDebt([
      { prayer: "asr", delta: 3, localDate: "2026-10-01" },
      { prayer: "asr", delta: -1, localDate: "2026-11-01" },
    ]);
    expect(debt.byPrayer.asr).toBe(2);
  });

  it("never goes negative", () => {
    const debt = qadaDebt([{ prayer: "maghrib", delta: -5, localDate: "2026-11-01" }]);
    expect(debt.byPrayer.maghrib).toBe(0);
    expect(debt.total).toBe(0);
  });
});

describe("prayerStreak", () => {
  const day = (localDate: string, logged: number, missed: number, excused = 0) => ({
    localDate,
    logged,
    missed,
    excused,
  });

  it("counts consecutive complete days", () => {
    const r = prayerStreak(
      [day("2026-11-02", 5, 0), day("2026-11-01", 5, 0), day("2026-10-31", 5, 0)],
      "2026-11-02",
    );
    expect(r.current).toBe(3);
    expect(r.longest).toBe(3);
  });

  it("does not count today while it is still in progress", () => {
    // Two logged, three still outstanding: today has not failed, but it is not
    // complete either, so it does not extend the streak yet.
    const r = prayerStreak(
      [day("2026-11-02", 2, 0), day("2026-11-01", 5, 0), day("2026-10-31", 5, 0)],
      "2026-11-02",
    );
    expect(r.current).toBe(2);
  });

  it("does not count a day with no rows at all", () => {
    // Regression: `missed === 0` was the whole test, so a day the user never
    // logged qualified — a user who never opens the app gained a growing streak.
    const r = prayerStreak(
      [day("2026-11-02", 0, 0), day("2026-11-01", 0, 0), day("2026-10-31", 0, 0)],
      "2026-11-02",
    );
    expect(r.current).toBe(0);
    expect(r.longest).toBe(0);
  });

  it("breaks on a past day with a missed prayer", () => {
    const r = prayerStreak(
      [day("2026-11-02", 5, 0), day("2026-11-01", 4, 1), day("2026-10-31", 5, 0), day("2026-10-30", 5, 0)],
      "2026-11-02",
    );
    expect(r.current).toBe(1);
    // 10-31 and 10-30 form a separate run of two.
    expect(r.longest).toBe(2);
  });

  it("treats excused prayers as accounted for", () => {
    // Five prayers, one of them excused: a complete day, because excused is not
    // a miss. The fixture used to be logged=4, which under `logged`'s real
    // meaning (every row, excused included — see `recentDays`) is only FOUR of
    // the five prayers, so it asserted a complete day from an incomplete one.
    // That is the double-count this change fixes: the fixture, not the intent.
    const r = prayerStreak([day("2026-11-02", 5, 0), day("2026-11-01", 5, 0, 1)], "2026-11-02");
    expect(r.current).toBe(2);
  });

  it("does not count a day with outstanding prayers as complete", () => {
    const r = prayerStreak([day("2026-11-02", 5, 0), day("2026-11-01", 3, 0, 0)], "2026-11-02");
    expect(r.current).toBe(1);
  });
});

/**
 * `logged` counts every row, excused included (`recentDays` does `e.logged++`
 * unconditionally). The streak test used to be `d.logged + d.excused >=
 * PRAYER_COUNT`, counting excused rows twice, so a day with four rows of which
 * one was excused qualified — awarding an F-SALAH-11 streak day for five
 * prayers that were not all accounted for. These fail against the old form.
 */
describe("prayerStreak does not double-count excused", () => {
  it("four rows (one excused) and one prayer unlogged does NOT qualify", () => {
    const days = [{ localDate: "2026-11-01", logged: 4, missed: 0, excused: 1 }];
    expect(prayerStreak(days, "2026-11-01").current).toBe(0);
  });

  it("five rows with one excused DOES qualify", () => {
    const days = [{ localDate: "2026-11-01", logged: 5, missed: 0, excused: 1 }];
    expect(prayerStreak(days, "2026-11-01").current).toBe(1);
  });

  it("five rows, none excused, qualifies", () => {
    const days = [{ localDate: "2026-11-01", logged: 5, missed: 0, excused: 0 }];
    expect(prayerStreak(days, "2026-11-01").current).toBe(1);
  });

  it("a missed prayer still breaks the streak", () => {
    const days = [{ localDate: "2026-11-01", logged: 5, missed: 1, excused: 0 }];
    expect(prayerStreak(days, "2026-11-01").current).toBe(0);
  });
});
