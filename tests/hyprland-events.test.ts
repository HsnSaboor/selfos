import { describe, expect, it } from "vitest";
import {
  type FocusSegment,
  mergeSegments,
  parseActiveWindow,
  parseEventLine,
  SegmentBuilder,
  SegmentMerger,
  splitLines,
} from "../src/main/integrations/hyprland/events";

describe("parseEventLine", () => {
  it("parses a normal event", () => {
    expect(parseEventLine("activewindow>>helium,YouTube - Helium")).toEqual({
      name: "activewindow",
      data: "helium,YouTube - Helium",
    });
  });

  it("rejects lines without a separator", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("garbage")).toBeNull();
    expect(parseEventLine(">>leading")).toBeNull();
  });
});

describe("splitLines", () => {
  it("keeps an unterminated tail buffered", () => {
    const first = splitLines("", "a>>1\nb>>2\npartial");
    expect(first.lines).toEqual(["a>>1", "b>>2"]);
    expect(first.rest).toBe("partial");
  });

  it("reassembles an event split across chunks", () => {
    const a = splitLines("", "activewindow>>hel");
    expect(a.lines).toEqual([]);
    const b = splitLines(a.rest, "ium,title\n");
    expect(b.lines).toEqual(["activewindow>>helium,title"]);
    expect(b.rest).toBe("");
  });
});

describe("parseActiveWindow", () => {
  it("splits on the first comma only, preserving commas in the title", () => {
    expect(parseActiveWindow("helium,News, Weather - Helium")).toEqual({
      appClass: "helium",
      appTitle: "News, Weather - Helium",
    });
  });

  it("handles a missing title", () => {
    expect(parseActiveWindow("foot,")).toEqual({ appClass: "foot", appTitle: "" });
  });

  it("reports an empty class for layer-shell surfaces", () => {
    expect(parseActiveWindow(",quickshell")).toEqual({ appClass: "", appTitle: "quickshell" });
  });
});

describe("SegmentBuilder", () => {
  it("closes the previous segment when a new sample arrives", () => {
    const b = new SegmentBuilder();
    b.sample({ at: 1000, appClass: "helium", appTitle: "A", workspaceId: "1" });
    const closed = b.sample({ at: 4000, appClass: "foot", appTitle: "B", workspaceId: "1" });
    expect(closed).toEqual({
      startedAt: 1000,
      endedAt: 4000,
      appClass: "helium",
      appTitle: "A",
      workspaceId: "1",
      source: "hypr-ipc",
    });
  });

  it("does not open a segment for an empty class (bar / lock surface)", () => {
    const b = new SegmentBuilder();
    b.sample({ at: 1000, appClass: "helium", appTitle: "A", workspaceId: "1" });
    const closed = b.sample({ at: 2000, appClass: "", appTitle: "quickshell", workspaceId: "1" });
    expect(closed?.endedAt).toBe(2000);
    expect(b.current()).toBeNull();
  });

  it("retitle updates the open segment without splitting it", () => {
    const b = new SegmentBuilder();
    b.sample({ at: 1000, appClass: "helium", appTitle: "Tab 1", workspaceId: "1" });
    b.retitle("Tab 2");
    const closed = b.close(5000);
    expect(closed?.appTitle).toBe("Tab 2");
    expect(closed?.startedAt).toBe(1000);
  });

  it("drops zero-length segments", () => {
    const b = new SegmentBuilder();
    b.sample({ at: 1000, appClass: "helium", appTitle: "A", workspaceId: "1" });
    expect(b.close(1000)).toBeNull();
  });

  it("close is idempotent", () => {
    const b = new SegmentBuilder();
    b.sample({ at: 1000, appClass: "helium", appTitle: "A", workspaceId: "1" });
    expect(b.close(2000)).not.toBeNull();
    expect(b.close(3000)).toBeNull();
  });
});

describe("mergeSegments", () => {
  const seg = (startedAt: number, endedAt: number, appClass: string, appTitle = "t"): FocusSegment => ({
    startedAt,
    endedAt,
    appClass,
    appTitle,
    workspaceId: "1",
    source: "hypr-ipc",
  });

  it("merges adjacent identical app+title segments", () => {
    const out = mergeSegments([seg(0, 1000, "helium"), seg(1000, 3000, "helium")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startedAt: 0, endedAt: 3000 });
  });

  it("absorbs a sub-threshold flicker into the following segment", () => {
    const out = mergeSegments([seg(0, 200, "bar"), seg(200, 5000, "helium")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startedAt: 0, endedAt: 5000, appClass: "helium" });
  });

  it("keeps genuinely distinct app switches", () => {
    const out = mergeSegments([seg(0, 5000, "helium"), seg(5000, 9000, "foot")]);
    expect(out).toHaveLength(2);
  });
});

describe("SegmentMerger", () => {
  const seg = (startedAt: number, endedAt: number, appClass: string, appTitle = "t"): FocusSegment => ({
    startedAt,
    endedAt,
    appClass,
    appTitle,
    workspaceId: "1",
    source: "hypr-ipc",
  });

  /** Feed a stream through the merger and collect everything it releases. */
  function run(segments: FocusSegment[]): FocusSegment[] {
    const merger = new SegmentMerger();
    const out = segments.flatMap((s) => merger.push(s));
    return [...out, ...merger.flush()];
  }

  it("absorbs a sub-second flicker backward, not forward", () => {
    // The bug `spikes/RESULTS.md` records fixing: a 200 ms blip must not claim
    // the following seconds of a different app. The bar appears for 200 ms and
    // then the user is in helium — helium should own the whole 4.8 s.
    const out = run([seg(0, 200, "quickshell"), seg(200, 5000, "helium")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.appClass).toBe("helium");
    expect(out[0]?.startedAt).toBe(0);
    expect(out[0]?.endedAt).toBe(5000);
  });

  it("merges contiguous segments of the same app and title", () => {
    const out = run([seg(0, 1000, "helium", "A"), seg(1000, 3000, "helium", "A")]);
    expect(out).toHaveLength(1);
    expect(out[0]?.startedAt).toBe(0);
    expect(out[0]?.endedAt).toBe(3000);
  });

  it("keeps a real switch: a long segment is never absorbed", () => {
    const out = run([seg(0, 5000, "helium"), seg(5000, 9000, "foot")]);
    expect(out.map((s) => s.appClass)).toEqual(["helium", "foot"]);
  });

  it("does not merge a title change, because the app+title pair differs", () => {
    const out = run([seg(0, 1000, "helium", "Tab 1"), seg(1000, 3000, "helium", "Tab 2")]);
    expect(out).toHaveLength(2);
  });

  it("holds at most one segment back", () => {
    // Three sub-second blips in a row. Each is absorbed by the next, so the run
    // collapses to a single segment starting at the first blip — and only the
    // last one can still be absorbed, so nothing is buffered up behind it.
    const merger = new SegmentMerger();
    const out = [
      ...merger.push(seg(0, 100, "a")),
      ...merger.push(seg(100, 300, "b")),
      ...merger.push(seg(300, 400, "c")),
      ...merger.flush(),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]?.appClass).toBe("c");
    expect(out[0]?.startedAt).toBe(0);
    expect(out[0]?.endedAt).toBe(400);
  });

  it("never loses time across a flush", () => {
    const merger = new SegmentMerger();
    const pushed = merger.push(seg(0, 100, "blip"));
    expect(pushed).toEqual([]); // held, not dropped
    const flushed = merger.flush();
    expect(flushed.map((s) => [s.startedAt, s.endedAt])).toEqual([[0, 100]]);
    expect(merger.flush()).toEqual([]); // idempotent
  });

  it("drops a zero-length segment", () => {
    const merger = new SegmentMerger();
    expect(merger.push(seg(500, 500, "x"))).toEqual([]);
    expect(merger.flush()).toEqual([]);
  });
});
