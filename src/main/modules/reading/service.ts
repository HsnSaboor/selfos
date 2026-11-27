/**
 * Reading service: library, position, sessions, highlights (PRD §5.2).
 */

import { ANCHOR_VERSION, type HighlightAnchor } from "../../../shared/anchors";
import type { BookSettingsView, BookView } from "../../../shared/api";
import { localDateKey } from "../../../shared/dates";
import { buildHighlightsMarkdown } from "../../../shared/highlights";
import type { Db } from "../../db/driver";
import { rebuildDay } from "../time/aggregate";
import { BookStore, DEFAULT_SETTINGS } from "./library";

export interface HighlightRow {
  id: number;
  bookId: number;
  page: number;
  color: string;
  text: string;
  anchor: HighlightAnchor;
  note: string | null;
  createdAt: number;
}

/**
 * Read a stored anchor defensively.
 *
 * `reading.addHighlight` validates the anchor at the IPC boundary, but that
 * guard only covers writes made through it. `rects_json` is a plain TEXT column
 * with no CHECK, so a row written before the guard existed — or by a migration,
 * a restore of an old backup, or any future writer — reaches the renderer
 * unchecked. The renderer's `resolveAnchor` runs `rects.every(...)` and
 * `normalizeText(text)` on the anchor during render, so a malformed one threw
 * `TypeError` and unmounted the whole React root.
 *
 * A row that cannot be parsed degrades to the "orphaned" state the reader
 * already renders (it lists the highlight in the panel with no rects) instead
 * of crashing the screen. The highlight is never silently dropped.
 */
function parseAnchor(raw: string, text: string, page: number): HighlightAnchor {
  const orphan: HighlightAnchor = {
    page,
    rects: [],
    text: typeof text === "string" ? text : "",
    rotation: 0,
    anchorVersion: ANCHOR_VERSION,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return orphan;
  }
  if (!parsed || typeof parsed !== "object") return orphan;
  const a = parsed as Record<string, unknown>;
  const rectsOk =
    Array.isArray(a.rects) &&
    a.rects.every((r) => {
      if (!r || typeof r !== "object") return false;
      const o = r as Record<string, unknown>;
      return [o.x, o.y, o.w, o.h].every((n) => typeof n === "number" && Number.isFinite(n));
    });
  if (!rectsOk) return orphan;
  if (typeof a.text !== "string") return orphan;
  if (typeof a.rotation !== "number" || !Number.isFinite(a.rotation)) return orphan;
  if (!Number.isInteger(a.page) || (a.page as number) < 1) return orphan;
  return {
    page: a.page as number,
    rects: a.rects as HighlightAnchor["rects"],
    text: a.text,
    rotation: a.rotation,
    anchorVersion: typeof a.anchorVersion === "number" ? a.anchorVersion : ANCHOR_VERSION,
  };
}

export class ReadingService {
  readonly store: BookStore;
  #db: Db;
  #sessions = new Map<number, { id: number; startedAt: number; pagesTurned: number; localDate: string }>();
  /** Last visible time the renderer reported for an open session. */
  #visibleSeconds = new Map<number, number>();

  constructor(db: Db, libraryDir: string) {
    this.#db = db;
    this.store = new BookStore(db, libraryDir);
  }

  /** Reading seconds for a day; the time module's rebuild takes this as input. */
  readingSeconds(localDate: string): number {
    return (
      this.#db.get<{ ms: number | null }>(
        "SELECT SUM(active_seconds) AS ms FROM reading_session WHERE local_date = ?",
        localDate,
      )?.ms ?? 0
    );
  }

  list(): BookView[] {
    return this.store.list().map((b) => {
      const progress = this.store.progress(b.id);
      const count = this.#db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM highlight WHERE book_id = ? AND deleted_at IS NULL",
        b.id,
      );
      // Built field by field from the contract, not spread from `BookRow`:
      // the row also carries `filePath` (an absolute path under the user data
      // directory), `sourcePath` (where the user imported it from), `sha256`
      // and `addedAt`. None of those are in `BookView`, but `...b` sent them
      // anyway because a structural type only has to be assignable.
      return {
        id: b.id,
        title: b.title,
        author: b.author,
        pageCount: b.pageCount,
        settings: b.settings ?? DEFAULT_SETTINGS,
        page: progress.page,
        scrollOffset: progress.scrollOffset,
        percent: progress.percent,
        lastReadAt: progress.lastReadAt,
        highlightCount: count?.n ?? 0,
      };
    });
  }

  importBook(sourcePath: string): { id: number; created: boolean } {
    return this.store.import(sourcePath);
  }

  /** Called by the renderer once pdf.js knows the real page count. */
  /**
   * Record what the renderer learned from the file.
   *
   * `pageCount` may legitimately be 0: pdf.js loads a PDF it cannot page (an
   * encrypted or structurally empty file) and reports `numPages === 0`. The old
   * guard threw `"invalid page count"` for that, which failed the *whole* call —
   * so the title and author read from the same metadata were discarded and the
   * error surfaced was about the page count, not about the file being unreadable.
   * A zero now skips only the page-count write; the metadata back-fill still
   * lands. A negative or non-integer count is still refused: that is a caller bug,
   * not a property of the file.
   */
  setPageCount(id: number, pageCount: number, title?: string, author?: string): void {
    if (!Number.isInteger(pageCount) || pageCount < 0) throw new Error("invalid page count");
    this.store.setPageCount(id, pageCount, title, author);
  }

  saveSettings(id: number, settings: BookSettingsView): void {
    this.store.saveSettings(id, settings);
  }

  savePosition(bookId: number, page: number, scrollOffset?: number, zoom?: number): void {
    this.store.savePosition(bookId, Math.max(1, Math.round(page)), scrollOffset, zoom);
  }

  // ── sessions ──────────────────────────────────────────────────────────

  startSession(bookId: number): number {
    const localDate = localDateKey(new Date());
    // A previous session for this book that was never closed (the window was
    // hidden and the app killed, or the renderer left before start resolved)
    // would stay open forever and keep counting. Close it first.
    // Close it with the last heartbeat the renderer reported, not wall clock:
    // an open reader left in the tray would otherwise bill hours of "reading".
    const stale = this.#sessions.get(bookId);
    if (stale) this.endSession(bookId, this.#visibleSeconds.get(bookId));
    const id = this.store.startSession(bookId, localDate);
    this.#sessions.set(bookId, { id, startedAt: Date.now(), pagesTurned: 0, localDate });
    return id;
  }

  /**
   * Close every open session. Called on shutdown so a reader left open does not
   * leave an `ended_at`-less row behind.
   */
  closeAllSessions(): void {
    // Shutdown: the renderer cannot report visible time, so wall clock is used
    // and clamped by the last reported value where one exists.
    for (const bookId of [...this.#sessions.keys()]) {
      const known = this.#visibleSeconds.get(bookId);
      this.endSession(bookId, known);
    }
  }

  /**
   * Heartbeat from the reader: how many seconds it has been visible this
   * session. Kept so a shutdown can close the session with a truthful value
   * instead of wall clock.
   */
  reportVisibleSeconds(bookId: number, seconds: number): void {
    if (!this.#sessions.has(bookId)) return;
    this.#visibleSeconds.set(bookId, Math.max(0, Math.round(seconds)));
  }

  turnPage(bookId: number): void {
    const s = this.#sessions.get(bookId);
    if (s) s.pagesTurned++;
  }

  /**
   * Close a session.
   *
   * `visibleSeconds` is supplied by the renderer, which is the only place that
   * knows whether the window was visible and focused (STACK §6.4: "counts only
   * time with the reader focused and the window visible"). Wall-clock time is
   * the fallback for callers that cannot report it, but it over-counts badly:
   * the app closes to the tray, so a reader left open would otherwise accrue
   * hours of "reading".
   */
  endSession(bookId: number, visibleSeconds?: number): { activeSeconds: number; pagesTurned: number } {
    const s = this.#sessions.get(bookId);
    if (!s) return { activeSeconds: 0, pagesTurned: 0 };
    this.#sessions.delete(bookId);
    const wallSeconds = Math.round((Date.now() - s.startedAt) / 1000);
    // Always drop the heartbeat: leaving it behind let a later session inherit
    // a stale value if it shut down before reporting its own.
    this.#visibleSeconds.delete(bookId);
    const activeSeconds =
      visibleSeconds === undefined
        ? wallSeconds
        : Math.max(0, Math.min(wallSeconds, Math.round(visibleSeconds)));
    this.store.endSession(s.id, activeSeconds, s.pagesTurned);
    // Rebuild the session's own day: `reading_seconds` comes from
    // reading_session, and nothing else recomputes it when tracking is paused.
    // A session that crosses midnight stays on its start date, so rebuild that
    // date rather than "today".
    rebuildDay(this.#db, s.localDate, this.readingSeconds(s.localDate));
    return { activeSeconds, pagesTurned: s.pagesTurned };
  }

  // ── highlights ────────────────────────────────────────────────────────

  addHighlight(
    bookId: number,
    input: { page: number; color: string; text: string; anchor: HighlightAnchor; note?: string },
  ): number {
    if (!input.text.trim()) throw new Error("highlight text is required");
    const anchor = { ...input.anchor, anchorVersion: ANCHOR_VERSION };
    const r = this.#db.run(
      `INSERT INTO highlight (book_id, page, color, text, rects_json, rotation, anchor_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      bookId,
      input.page,
      input.color,
      input.text,
      JSON.stringify(anchor),
      anchor.rotation,
      anchor.anchorVersion,
      Date.now(),
    );
    const id = Number(r.lastInsertRowid);
    if (input.note?.trim()) {
      this.#db.run(
        "INSERT INTO highlight_note (highlight_id, body, updated_at) VALUES (?, ?, ?)",
        id,
        input.note.trim(),
        Date.now(),
      );
    }
    return id;
  }

  highlights(bookId: number): HighlightRow[] {
    const rows = this.#db.all<{
      id: number;
      book_id: number;
      page: number;
      color: string;
      text: string;
      rects_json: string;
      note: string | null;
      created_at: number;
    }>(
      `SELECT h.id, h.book_id, h.page, h.color, h.text, h.rects_json, n.body AS note, h.created_at
         FROM highlight h
         LEFT JOIN highlight_note n ON n.highlight_id = h.id
        WHERE h.book_id = ? AND h.deleted_at IS NULL
        ORDER BY h.page, h.id`,
      bookId,
    );
    return rows.map((r) => ({
      id: r.id,
      bookId: r.book_id,
      page: r.page,
      color: r.color,
      text: r.text,
      anchor: parseAnchor(r.rects_json, r.text, r.page),
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  updateNote(highlightId: number, body: string): void {
    if (body.trim()) {
      this.#db.run(
        `INSERT INTO highlight_note (highlight_id, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(highlight_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        highlightId,
        body.trim(),
        Date.now(),
      );
    } else {
      this.#db.run("DELETE FROM highlight_note WHERE highlight_id = ?", highlightId);
    }
  }

  deleteHighlight(highlightId: number): void {
    this.#db.run("UPDATE highlight SET deleted_at = ? WHERE id = ?", Date.now(), highlightId);
  }

  /** Markdown export for Obsidian (F-READ-10). One builder, see shared/highlights. */
  exportMarkdown(bookId: number): { title: string; markdown: string } {
    const book = this.store.get(bookId);
    if (!book) throw new Error("book not found");
    const hs = this.highlights(bookId);
    return {
      title: book.title,
      markdown: buildHighlightsMarkdown(
        book.title,
        hs.map((h) => ({ page: h.page, text: h.text, note: h.note })),
      ),
    };
  }
}
