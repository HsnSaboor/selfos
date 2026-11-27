import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/main/db/driver";
import { migrate } from "../src/main/db/migrate";
import { ReadingService } from "../src/main/modules/reading/service";
import {
  ANCHOR_VERSION,
  findByContext,
  findByText,
  type HighlightAnchor,
  normalizeRotation,
  normalizeText,
  rectsMatch,
  resolveAnchor,
  rotationMatches,
  type TextItem,
  toNormalized,
  toScreen,
} from "../src/shared/anchors";
import { tempDir } from "./helpers/temp";

const VW = 612;
const VH = 792;

/** Three text items laid out like a real page. */
const items: TextItem[] = [
  { str: "The quick brown fox", x: 72, y: 100, w: 180, h: 14 },
  { str: "jumps over the lazy dog.", x: 72, y: 120, w: 220, h: 14 },
  { str: "Unique marker line here.", x: 72, y: 140, w: 200, h: 14 },
];

function anchor(partial: Partial<HighlightAnchor> = {}): HighlightAnchor {
  return {
    page: 1,
    rects: [toNormalized(72, 100, 180, 14, VW, VH)],
    text: "The quick brown fox",
    rotation: 0,
    anchorVersion: ANCHOR_VERSION,
    ...partial,
  };
}

describe("normalizeText", () => {
  it("collapses whitespace and case", () => {
    expect(normalizeText("  The   QUICK\nbrown  fox ")).toBe("the quick brown fox");
  });

  it("removes soft hyphens and line-break hyphenation", () => {
    expect(normalizeText("inter-\nnational")).toBe("international");
    expect(normalizeText("inter­national")).toBe("international");
  });
});

describe("normalization round-trip", () => {
  it("is stable across zoom levels (SP-5)", () => {
    const at1 = toNormalized(72, 100, 180, 14, VW, VH);
    const scaled = toScreen(at1, VW * 2, VH * 2);
    const at2 = toNormalized(scaled.x, scaled.y, scaled.w, scaled.h, VW * 2, VH * 2);
    expect(rectsMatch([at1], [at2])).toBe(true);
  });

  it("projects back to the same screen rect", () => {
    const n = toNormalized(72, 100, 180, 14, VW, VH);
    const s = toScreen(n, VW, VH);
    expect(s.x).toBeCloseTo(72, 6);
    expect(s.w).toBeCloseTo(180, 6);
  });
});

describe("rotationMatches", () => {
  it("treats equivalent rotations as equal", () => {
    expect(rotationMatches(anchor({ rotation: 0 }), 0)).toBe(true);
    expect(rotationMatches(anchor({ rotation: 360 }), 0)).toBe(true);
    expect(rotationMatches(anchor({ rotation: -90 }), 270)).toBe(true);
  });

  it("detects a real rotation change", () => {
    expect(rotationMatches(anchor({ rotation: 0 }), 90)).toBe(false);
  });

  it("normalizes rotation values", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
  });
});

describe("findByText", () => {
  it("finds a single item's text", () => {
    const rects = findByText(items, "The quick brown fox", VW, VH);
    expect(rects).not.toBeNull();
    expect(rects).toHaveLength(1);
  });

  it("finds text spanning multiple items", () => {
    const rects = findByText(items, "The quick brown fox jumps over the lazy dog.", VW, VH);
    expect(rects).toHaveLength(2);
  });

  it("is case and whitespace insensitive", () => {
    expect(findByText(items, "  the QUICK   brown fox ", VW, VH)).not.toBeNull();
  });

  it("returns null for absent text", () => {
    expect(findByText(items, "nothing like this", VW, VH)).toBeNull();
  });

  it("returns null when the match is ambiguous", () => {
    const repeated: TextItem[] = [
      { str: "same", x: 0, y: 0, w: 10, h: 10 },
      { str: "same", x: 0, y: 20, w: 10, h: 10 },
    ];
    expect(findByText(repeated, "same", VW, VH)).toBeNull();
  });
});

describe("resolveAnchor", () => {
  it("uses exact rects when rotation matches and they are in range", () => {
    const r = resolveAnchor(anchor(), items, VW, VH, 0);
    expect(r.method).toBe("exact");
    expect(r.confidence).toBe(1);
  });

  it("falls back to text search when the rotation changed", () => {
    // A 90° page invalidates the stored rects (SP-5 measured a 790 px error).
    const r = resolveAnchor(anchor(), items, VW, VH, 90);
    expect(r.method).toBe("text-search");
    expect(r.rects.length).toBeGreaterThan(0);
  });

  it("falls back to text search when rects are out of range", () => {
    const bad = anchor({ rects: [{ x: 5, y: 5, w: 0.1, h: 0.1 }] });
    expect(resolveAnchor(bad, items, VW, VH, 0).method).toBe("text-search");
  });

  it("uses context when the exact text is missing but context is present", () => {
    const a = anchor({
      text: "quick brown",
      prefix: "The",
      suffix: "fox jumps",
    });
    const r = resolveAnchor(a, items, VW, VH, 90);
    expect(["text-search", "fuzzy"]).toContain(r.method);
    expect(r.method).not.toBe("orphaned");
  });

  it("reports orphaned rather than dropping the highlight", () => {
    const a = anchor({ text: "text that no longer exists" });
    const r = resolveAnchor(a, items, VW, VH, 90);
    expect(r.method).toBe("orphaned");
    expect(r.rects).toEqual([]);
  });
});

describe("findByContext", () => {
  it("matches on prefix + text + suffix", () => {
    const rects = findByContext(
      items,
      {
        text: "quick brown fox",
        prefix: "The",
        suffix: "jumps",
      },
      VW,
      VH,
    );
    expect(rects).not.toBeNull();
  });

  it("returns null without any context", () => {
    expect(findByContext(items, { text: "quick" }, VW, VH)).toBeNull();
  });
});

/**
 * A malformed anchor read back from storage must not crash the renderer.
 *
 * `reading.addHighlight` validates anchors at the IPC boundary, but
 * `highlight.rects_json` is a plain TEXT column and rows written before that
 * guard existed still reach `ReadingService.highlights()`. Its old blind
 * `JSON.parse(...) as HighlightAnchor` handed `resolveAnchor` whatever was
 * stored; a string `rects` threw `TypeError` during render, and with no error
 * boundary the whole React root unmounted. These run against the real service.
 */
describe("malformed stored anchors degrade instead of throwing", () => {
  const items: TextItem[] = [{ text: "probe", x: 0, y: 0, w: 10, h: 10, items: [] } as never];

  function seedHighlight(rectsJson: string) {
    const db = Db.open(join(tempDir("selfos-anchor-"), "test.sqlite"));
    migrate(db);
    db.run(
      `INSERT INTO book (title, file_path, sha256, page_count, added_at) VALUES ('b','/x.pdf','deadbeef',10,1)`,
    );
    const row = db.get<{ id: number }>("SELECT id FROM book LIMIT 1") as { id: number };
    db.run(
      `INSERT INTO highlight (book_id, page, color, text, rects_json, rotation, anchor_version, created_at)
       VALUES (?, 1, 'yellow', 'probe', ?, 0, 1, 1)`,
      Number(row.id),
      rectsJson,
    );
    const svc = new ReadingService(db, tempDir("selfos-anchor-lib-"));
    return svc.highlights(Number(row.id));
  }

  it("rects stored as a string no longer reaches resolveAnchor as a string", () => {
    const rows = seedHighlight(
      JSON.stringify({ page: 1, rects: "nope", text: "probe", rotation: 0, anchorVersion: 1 }),
    );
    expect(rows[0].anchor.rects).toEqual([]);
    expect(() => resolveAnchor(rows[0].anchor, items, VW, VH, 0)).not.toThrow();
  });

  it("unparseable JSON degrades to an orphaned anchor", () => {
    const rows = seedHighlight("{not json");
    expect(rows[0].anchor.rects).toEqual([]);
    expect(() => resolveAnchor(rows[0].anchor, items, VW, VH, 0)).not.toThrow();
  });

  it("keeps the highlight row and its text even when the anchor is unusable", () => {
    const rows = seedHighlight(JSON.stringify({ page: 1, rects: [], rotation: 0, anchorVersion: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("probe");
    expect(rows[0].anchor.text).toBe("probe");
  });

  it("passes a valid anchor through unchanged", () => {
    const good = {
      page: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.05 }],
      text: "probe",
      rotation: 0,
      anchorVersion: ANCHOR_VERSION,
    };
    const rows = seedHighlight(JSON.stringify(good));
    expect(rows[0].anchor.rects).toEqual(good.rects);
    expect(resolveAnchor(rows[0].anchor, items, VW, VH, 0).method).toBe("exact");
  });
});
