import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "../src/main/modules/reading/library";
import { isDateKey, localDateKey, todayKey } from "../src/shared/dates";
import { splitFrontmatter, stripFrontmatter } from "../src/shared/frontmatter";
import { buildHighlightsMarkdown } from "../src/shared/highlights";
import { describeSchedule, formatWeekdays, isoWeekday } from "../src/shared/schedule";

describe("localDateKey", () => {
  it("formats a local date as YYYY-MM-DD, zero-padded", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("uses the local calendar day, not UTC", () => {
    // Late evening local time is already the next day in UTC east of London;
    // the key must follow the machine's day or every table is bucketed wrong.
    const d = new Date(2026, 5, 15, 23, 30);
    expect(localDateKey(d)).toBe("2026-06-15");
  });

  it("todayKey matches the local date", () => {
    expect(todayKey()).toBe(localDateKey(new Date()));
  });
});

describe("frontmatter", () => {
  it("splits a leading YAML block from the body", () => {
    const src = "---\ntags: [a]\n---\n# Title\nBody";
    expect(splitFrontmatter(src)).toEqual({ frontmatter: "tags: [a]", body: "# Title\nBody" });
    expect(stripFrontmatter(src)).toBe("# Title\nBody");
  });

  it("leaves a document with no frontmatter untouched", () => {
    const src = "# Title\nBody";
    expect(splitFrontmatter(src)).toEqual({ frontmatter: "", body: src });
  });

  it("treats an unterminated block as no frontmatter", () => {
    // Otherwise a note that opens with a horizontal rule loses its content.
    const src = "---\ntags: [a]\nno close";
    expect(splitFrontmatter(src)).toEqual({ frontmatter: "", body: src });
  });

  it("does not treat a mid-document `---` as an opener", () => {
    const src = "# Title\n\n---\n\nBody";
    expect(stripFrontmatter(src)).toBe(src);
  });
});

describe("buildHighlightsMarkdown", () => {
  it("groups by page and counts highlights", () => {
    const md = buildHighlightsMarkdown("Seerah", [
      { page: 1, text: "first", note: null },
      { page: 2, text: "second", note: "a note" },
      { page: 2, text: "third", note: null },
    ]);
    expect(md).toContain("# Seerah");
    expect(md).toContain("3 highlights");
    // One heading per page, not one per highlight.
    expect(md.match(/## Page 2/g)?.length).toBe(1);
    expect(md).toContain("**Note:** a note");
  });

  it("uses the singular for one highlight", () => {
    expect(buildHighlightsMarkdown("B", [{ page: 1, text: "x", note: null }])).toContain("1 highlight\n");
  });

  it("collapses newlines inside a highlight so the blockquote stays one line", () => {
    const md = buildHighlightsMarkdown("B", [{ page: 1, text: "a\nb", note: null }]);
    expect(md).toContain("> a b");
    expect(md).not.toContain("> a\nb");
  });
});

describe("schedule formatting", () => {
  it("computes ISO weekdays (Monday = 1, Sunday = 7)", () => {
    expect(isoWeekday("2026-11-02")).toBe(1); // Monday
    expect(isoWeekday("2026-11-08")).toBe(7); // Sunday
  });

  it("formats weekday lists", () => {
    expect(formatWeekdays([1, 3])).toBe("Mon, Wed");
    expect(formatWeekdays([])).toBe("—");
    expect(formatWeekdays(null)).toBe("—");
  });

  it("describes each schedule kind", () => {
    expect(describeSchedule({ kind: "daily" })).toBe("Every day");
    expect(describeSchedule({ kind: "weekdays", weekdays: [2] })).toBe("Tue");
    expect(describeSchedule({ kind: "times_per_week", timesPerPeriod: 3 })).toBe("3× per week");
    expect(describeSchedule({ kind: "times_per_month" })).toBe("1× per month");
    expect(describeSchedule(null)).toBe("No schedule");
  });
});

describe("isDateKey", () => {
  it("accepts a real calendar date", () => {
    expect(isDateKey("2026-11-03")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true); // leap year
    expect(isDateKey("2026-01-01")).toBe(true);
    expect(isDateKey("2026-12-31")).toBe(true);
  });

  it("rejects anything that is not a YYYY-MM-DD string", () => {
    expect(isDateKey("junk")).toBe(false);
    expect(isDateKey("")).toBe(false);
    expect(isDateKey("2026-11-03T00:00:00Z")).toBe(false);
    expect(isDateKey("26-11-03")).toBe(false);
    expect(isDateKey("2026-1-3")).toBe(false);
    expect(isDateKey(2026_1103)).toBe(false);
    expect(isDateKey(null)).toBe(false);
    expect(isDateKey(undefined)).toBe(false);
    expect(isDateKey({})).toBe(false);
  });

  it("rejects a well-shaped but impossible date", () => {
    // The shape check alone passes these; only the round trip catches them.
    // Each would otherwise be stored and then be invisible to every range query.
    expect(isDateKey("2026-13-45")).toBe(false);
    expect(isDateKey("2026-00-10")).toBe(false);
    expect(isDateKey("2026-11-31")).toBe(false);
    expect(isDateKey("2025-02-29")).toBe(false); // not a leap year
  });

  it("does not accept a date that Date would normalise", () => {
    // `new Date(2026, 1, 30)` silently becomes 2 March; comparing the round trip
    // back to the input is what stops "2026-02-30" being treated as valid.
    expect(isDateKey("2026-02-30")).toBe(false);
  });

  it("agrees with localDateKey on every day of a year", () => {
    for (let i = 0; i < 365; i++) {
      const d = new Date(2026, 0, 1 + i);
      expect(isDateKey(localDateKey(d))).toBe(true);
    }
  });
});

describe("parseSettings", () => {
  it("returns the defaults for a missing or unparseable blob", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("42")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps every valid field", () => {
    const stored = {
      pageBackground: "sepia",
      invert: true,
      brightness: 1.2,
      contrast: 0.9,
      zoomMode: "fit-page",
      zoom: 2,
      layout: "single",
      cropMargins: 0.1,
      hideHeaders: true,
    };
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored);
  });

  it("repairs an out-of-contract blob instead of trusting it", () => {
    // What an earlier build (or a hand-edited row, or a stored NaN) can leave:
    // JSON has no NaN, so a previously-saved NaN reads back as null.
    const raw = JSON.stringify({
      pageBackground: "evil",
      invert: "yes",
      brightness: null,
      contrast: 99,
      zoomMode: "nope",
      zoom: -5,
      layout: "two-column",
      cropMargins: 5,
      hideHeaders: 1,
    });
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("drops unknown keys", () => {
    const parsed = parseSettings(JSON.stringify({ ...DEFAULT_SETTINGS, evil: "payload" }));
    expect(parsed).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it("repairs one bad field without discarding the good ones", () => {
    const parsed = parseSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, brightness: null, pageBackground: "sepia" }),
    );
    expect(parsed.brightness).toBe(DEFAULT_SETTINGS.brightness);
    expect(parsed.pageBackground).toBe("sepia");
  });
});
