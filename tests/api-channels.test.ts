import { describe, expect, it } from "vitest";
import {
  API_CHANNELS,
  EVENT_NAMES,
  isApiChannel,
  isEventName,
  isValidEventPayload,
  transportFailure,
} from "../src/shared/api";

/**
 * The preload bridge must expose a closed list, not a generic passthrough
 * (STACK §2.3/§3.4). These pin the runtime guard the bridge relies on.
 */
describe("isApiChannel", () => {
  it("accepts every declared channel", () => {
    for (const name of API_CHANNELS) expect(isApiChannel(name)).toBe(true);
  });

  it("refuses channels outside the Api map", () => {
    // An invented name that is not in the `Api` map (`reading.pickBook` is the
    // real channel for the native picker).
    expect(isApiChannel("dialog:pickBook")).toBe(false);
    expect(isApiChannel("system.nope")).toBe(false);
    expect(isApiChannel("")).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isApiChannel(undefined)).toBe(false);
    expect(isApiChannel(null)).toBe(false);
    expect(isApiChannel(42)).toBe(false);
    expect(isApiChannel({})).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(API_CHANNELS).size).toBe(API_CHANNELS.length);
  });
});

/**
 * `bridge.on` is guarded by `isEventName` for the same reason `invoke` is
 * guarded by `isApiChannel`: the event name is a compile-time type only, so
 * without a runtime check any main→renderer channel would be subscribable.
 * This path had no coverage at all while the `invoke` path had a full suite —
 * it carries the theme and collector-status pushes.
 */
describe("isEventName", () => {
  it("accepts every declared event", () => {
    for (const name of EVENT_NAMES) expect(isEventName(name)).toBe(true);
  });

  it("refuses events outside the Events map", () => {
    expect(isEventName("api-channel-name")).toBe(false);
    expect(isEventName("system.health")).toBe(false);
    expect(isEventName("")).toBe(false);
  });

  it("refuses non-strings", () => {
    expect(isEventName(undefined)).toBe(false);
    expect(isEventName(null)).toBe(false);
    expect(isEventName(42)).toBe(false);
    expect(isEventName({})).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });

  it("shares no name with the invoke channel list", () => {
    // The two lists are separate namespaces; a collision would mean a name that
    // is both a channel and an event, which the `selfos:` / `selfos:event:`
    // prefixing would silently disambiguate rather than surface.
    const channels = new Set<string>(API_CHANNELS);
    expect(EVENT_NAMES.filter((e) => channels.has(e))).toEqual([]);
  });
});

describe("transportFailure", () => {
  it("converts a rejection into the result union", () => {
    const res = transportFailure(new Error("no handler registered for selfos:x"));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("no handler registered for selfos:x");
  });

  it("stringifies a non-Error rejection", () => {
    const res = transportFailure("boom");
    expect(res.ok === false && res.error).toBe("boom");
  });

  it("never yields an empty message, which would render as a blank banner", () => {
    const res = transportFailure(new Error(""));
    expect(res.ok === false && res.error).toBe("IPC call failed");
  });
});

/**
 * Event payloads are rendered directly, unlike `invoke` results which have a
 * result union to absorb a bad value. A `theme-changed` push with a missing
 * `palette` made `themeVars()` (App.tsx:67) throw inside App's own render —
 * above the module boundary — verified as `TypeError: Cannot convert undefined
 * or null to object`. The preload now drops payloads that fail this check.
 */
describe("isValidEventPayload", () => {
  const theme = {
    name: "omarchy",
    mode: "dark",
    background: "#111",
    sunken: "#101010",
    raised: "#191919",
    foreground: "#eee",
    muted: "#999",
    selection: "#333",
    accent: "#7aa2f7",
    palette: { red: "#f00" },
  };

  it("accepts a well-formed theme payload", () => {
    expect(isValidEventPayload("theme-changed", theme)).toBe(true);
  });

  it("refuses a theme payload with a null palette", () => {
    expect(isValidEventPayload("theme-changed", { ...theme, palette: null })).toBe(false);
  });

  it("refuses a theme payload missing palette entirely", () => {
    const { palette: _drop, ...rest } = theme;
    expect(isValidEventPayload("theme-changed", rest)).toBe(false);
  });

  it("refuses a theme payload missing a dereferenced field", () => {
    const { accent: _drop, ...rest } = theme;
    expect(isValidEventPayload("theme-changed", rest)).toBe(false);
  });

  it("refuses non-objects", () => {
    expect(isValidEventPayload("theme-changed", null)).toBe(false);
    expect(isValidEventPayload("theme-changed", "dark")).toBe(false);
  });

  it("checks collector-status on its own fields", () => {
    expect(isValidEventPayload("collector-status", { running: true, paused: false })).toBe(true);
    expect(isValidEventPayload("collector-status", { running: true })).toBe(false);
    expect(isValidEventPayload("collector-status", theme)).toBe(false);
  });
});

/**
 * The enum mirrors are `as const satisfies readonly T[]`, which proves only that
 * every listed string is a *valid* member — it does not prove every member is
 * listed. A member added to the union and omitted from the array compiles
 * silently, and the runtime guard then refuses a value the type permits. That
 * was documented in a comment in round 8 but not closed; round 10 added the
 * two-way `Exclude<…> extends never` proof beside each mirror, matching the one
 * `API_CHANNELS` already had.
 *
 * These pin the runtime half: each list must contain every member of its union.
 * The compile-time half is enforced by the proofs in `api.ts` — deleting
 * "clean" from ENTRY_STATUSES fails the build with `Type 'true' is not
 * assignable to type '"clean"'`, verified.
 */
describe("enum mirrors cover their unions", () => {
  // The expected members, written out here so a silent removal from the source
  // list is caught by this test rather than only by a compile error.
  const EXPECTED: Record<string, string[]> = {
    ENTRY_STATUSES: ["done", "partial", "skipped", "slipped", "clean"],
    HABIT_KINDS: ["boolean", "count", "duration", "avoid"],
    SCHEDULE_KINDS: ["daily", "weekdays", "times_per_week", "times_per_month"],
    PRAYER_IDS: ["fajr", "dhuhr", "asr", "maghrib", "isha"],
    PRAYER_STATUSES: ["on_time", "late", "missed", "excused"],
    BACKUP_KINDS: ["daily", "weekly", "manual"],
    PAGE_BACKGROUNDS: ["original", "dark", "sepia", "black"],
    ZOOM_MODES: ["fit-width", "fit-page", "custom"],
    READER_LAYOUTS: ["scroll", "single"],
  };

  it("each mirror lists exactly its expected members", async () => {
    const api = await import("../src/shared/api");
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const actual = [...(api as Record<string, readonly string[]>)[name]];
      expect({ name, actual: actual.sort() }).toEqual({ name, actual: [...expected].sort() });
    }
  });

  it("no mirror has duplicates", async () => {
    const api = await import("../src/shared/api");
    for (const name of Object.keys(EXPECTED)) {
      const list = (api as Record<string, readonly string[]>)[name];
      expect({ name, unique: new Set(list).size }).toEqual({ name, unique: list.length });
    }
  });
});
