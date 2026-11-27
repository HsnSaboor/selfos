/**
 * Highlight anchoring (PRD F-READ-07/08, STACK §6.3).
 *
 * SP-5 measured the behaviour this encodes:
 *  - Rects normalized to the viewport are invariant across zoom (zero drift
 *    1×–3×, ≤0.001 px round-trip), so zoom changes need no re-anchoring.
 *  - They are NOT invariant under rotation (790 px error for a 0° anchor on a
 *    90° page), so the anchor stores the rotation it was captured at and any
 *    mismatch forces text-search re-anchoring.
 *
 * Everything here is pure so the resolution order is testable without pdf.js.
 *
 * Lives in `shared/` because both processes use it: main validates and stamps
 * anchors when a highlight is saved, and the renderer resolves them against the
 * live text layer when it paints (PRD N-MAINT-02, STACK §12.1).
 */

export const ANCHOR_VERSION = 1;

export interface Rect {
  /** Normalized 0..1 within the page viewport. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HighlightAnchor {
  page: number;
  rects: Rect[];
  /** The text the highlight covers, used for re-anchoring. */
  text: string;
  /** Page rotation (degrees) at capture time. */
  rotation: number;
  anchorVersion: number;
  /** Context either side of the selection, for fuzzy matching. */
  prefix?: string;
  suffix?: string;
}

export interface TextItem {
  str: string;
  /** Screen-space rect at the current viewport. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ResolveMethod = "exact" | "text-search" | "fuzzy" | "orphaned";

export interface ResolveResult {
  method: ResolveMethod;
  rects: Rect[];
  /** 0..1 confidence; exact and text-search are 1.0 by construction. */
  confidence: number;
}

const EPSILON = 0.001;

/** Does this anchor's rotation match the page currently being rendered? */
export function rotationMatches(anchor: HighlightAnchor, currentRotation: number): boolean {
  return normalizeRotation(anchor.rotation) === normalizeRotation(currentRotation);
}

export function normalizeRotation(deg: number): number {
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r;
}

/** Normalize a screen-space rect against the viewport size. */
export function toNormalized(x: number, y: number, w: number, h: number, vw: number, vh: number): Rect {
  return { x: x / vw, y: y / vh, w: w / vw, h: h / vh };
}

/** Project a normalized rect back to screen space at any zoom. */
export function toScreen(rect: Rect, vw: number, vh: number): { x: number; y: number; w: number; h: number } {
  return { x: rect.x * vw, y: rect.y * vh, w: rect.w * vw, h: rect.h * vh };
}

/** Do two normalized rect sets agree within epsilon? */
export function rectsMatch(a: Rect[], b: Rect[], epsilon = EPSILON): boolean {
  if (a.length !== b.length) return false;
  return a.every((ra, i) => {
    const rb = b[i];
    if (!rb) return false;
    return (
      Math.abs(ra.x - rb.x) <= epsilon &&
      Math.abs(ra.y - rb.y) <= epsilon &&
      Math.abs(ra.w - rb.w) <= epsilon &&
      Math.abs(ra.h - rb.h) <= epsilon
    );
  });
}

/** Collapse whitespace so hyphenation and line wrapping do not defeat matching. */
export function normalizeText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/­/g, "") // soft hyphen
    .replace(/-\s+/g, "") // hyphenation at a line break
    .trim()
    .toLowerCase();
}

/**
 * Find the rects covering `text` in a page's text items.
 * Returns null unless the match is unique — an ambiguous match must not move a
 * highlight to the wrong place.
 */
export function findByText(items: TextItem[], text: string, vw: number, vh: number): Rect[] | null {
  const needle = normalizeText(text);
  if (!needle) return null;

  const hits: TextItem[][] = [];
  // Try every starting item, accumulating until the normalized text matches.
  for (let start = 0; start < items.length; start++) {
    let acc = "";
    const run: TextItem[] = [];
    for (let i = start; i < items.length; i++) {
      const item = items[i];
      if (!item) break;
      acc = normalizeText(`${acc} ${item.str}`);
      run.push(item);
      if (acc === needle) {
        hits.push([...run]);
        break;
      }
      if (acc.length > needle.length) break;
    }
  }

  if (hits.length !== 1) return null;
  const hit = hits[0];
  if (!hit) return null;
  return hit.map((i) => toNormalized(i.x, i.y, i.w, i.h, vw, vh));
}

/**
 * Fuzzy match: the anchor text plus its surrounding context.
 * Used when the text layer changed slightly (ligatures, spacing) but the
 * passage is still recognisably there.
 *
 * Unlike `findByText`, this searches for the context as a *substring* of the
 * page's text, because the context deliberately extends past the highlight.
 * The match must still be unique.
 */
export function findByContext(
  items: TextItem[],
  anchor: Pick<HighlightAnchor, "text" | "prefix" | "suffix">,
  vw: number,
  vh: number,
): Rect[] | null {
  if (!anchor.prefix && !anchor.suffix) return null;

  const text = normalizeText(anchor.text);
  const needle = normalizeText(`${anchor.prefix ?? ""} ${anchor.text} ${anchor.suffix ?? ""}`);
  if (!needle || !text) return null;

  // Flatten the page into one string while remembering which item each
  // character came from, so a substring hit maps back to rects.
  let flat = "";
  const owners: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const piece = normalizeText(items[i]?.str ?? "");
    if (!piece) continue;
    if (flat) {
      flat += " ";
      owners.push(-1);
    }
    for (let c = 0; c < piece.length; c++) owners.push(i);
    flat += piece;
  }

  const hits: number[] = [];
  let from = flat.indexOf(needle);
  while (from !== -1) {
    hits.push(from);
    from = flat.indexOf(needle, from + 1);
  }
  if (hits.length !== 1) return null;

  const at = hits[0];
  if (at === undefined) return null;
  // Narrow the matched span to the highlight text itself, so the rects cover
  // the highlight rather than its context.
  const textStart = at + needle.indexOf(text);
  const textEnd = textStart + text.length;
  const touched = new Set<number>();
  for (let c = textStart; c < textEnd && c < owners.length; c++) {
    const owner = owners[c];
    if (owner !== undefined && owner >= 0) touched.add(owner);
  }
  if (touched.size === 0) return null;

  return [...touched]
    .sort((a, b) => a - b)
    .map((i) => items[i])
    .filter((i): i is TextItem => Boolean(i))
    .map((i) => toNormalized(i.x, i.y, i.w, i.h, vw, vh));
}

/**
 * Resolve an anchor against the page as it renders now.
 * Order matters: cheap and exact first, then progressively weaker, and finally
 * report it as orphaned rather than dropping it (F-READ-07 never silently
 * loses a highlight).
 */
export function resolveAnchor(
  anchor: HighlightAnchor,
  items: TextItem[],
  vw: number,
  vh: number,
  currentRotation: number,
): ResolveResult {
  // Rotation changed: the stored rects are meaningless on this page shape.
  // A future anchor version must not trust v1 rects either: fall through to
  // text search rather than guessing (STACK §6.3 migration hook).
  if (anchor.anchorVersion === ANCHOR_VERSION && rotationMatches(anchor, currentRotation)) {
    const stillValid = anchor.rects.every(
      (r) => r.x >= -0.01 && r.x <= 1.01 && r.y >= -0.01 && r.y <= 1.01 && r.w >= 0 && r.h >= 0,
    );
    if (stillValid) return { method: "exact", rects: anchor.rects, confidence: 1 };
  }

  const byText = findByText(items, anchor.text, vw, vh);
  if (byText) return { method: "text-search", rects: byText, confidence: 1 };

  const byContext = findByContext(items, anchor, vw, vh);
  if (byContext) return { method: "fuzzy", rects: byContext, confidence: 0.6 };

  return { method: "orphaned", rects: [], confidence: 0 };
}

export function isOrphaned(result: ResolveResult): boolean {
  return result.method === "orphaned";
}
