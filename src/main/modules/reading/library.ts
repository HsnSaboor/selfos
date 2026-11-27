/**
 * Book library storage (PRD F-READ-01, STACK §6.5).
 *
 * Books are copied into a managed folder keyed by content hash, so re-importing
 * the same file is a no-op and the original path is only a record.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  type BookSettingsView,
  PAGE_BACKGROUNDS,
  READER_LAYOUTS,
  READER_SETTING_RANGE,
  ZOOM_MODES,
} from "../../../shared/api";
import { isInside } from "../../../shared/paths";
import type { Db } from "../../db/driver";

export interface BookRow {
  id: number;
  title: string;
  author: string | null;
  filePath: string;
  sourcePath: string | null;
  sha256: string;
  pageCount: number;
  settings: BookSettings | null;
  addedAt: number;
  archivedAt: number | null;
}

/**
 * Display overrides, per book (PRD F-READ-04).
 *
 * An alias, not a second declaration: this interface used to restate every
 * member of `BookSettingsView`, so adding a setting to the shared contract left
 * the main-process copy — and `DEFAULT_SETTINGS` below — silently behind.
 */
export type BookSettings = BookSettingsView;

export const DEFAULT_SETTINGS: BookSettings = {
  pageBackground: "original",
  invert: false,
  brightness: 1,
  contrast: 1,
  zoomMode: "fit-width",
  zoom: 1,
  layout: "scroll",
  cropMargins: 0,
  hideHeaders: false,
};

/**
 * Read a stored settings blob, repairing anything the current contract no
 * longer allows.
 *
 * The IPC handler validates what it writes, but a row written by an earlier
 * build (or by the versions before that validation existed) is still on disk and
 * is read on every open. `{...DEFAULT_SETTINGS, ...parsed}` trusted the blob
 * wholesale, so an unknown `pageBackground` was handed to the render path and a
 * `null` — how JSON represents a stored `NaN` — was interpolated into the CSS
 * filter string as `brightness(null)`.
 *
 * Each field is checked against the same lists and bounds the writer uses, and
 * falls back to its default rather than refusing the book: a bad setting must
 * not make a book unopenable.
 */
export function parseSettings(raw: string | null): BookSettings {
  if (!raw) return DEFAULT_SETTINGS;
  let v: Partial<BookSettings>;
  try {
    v = JSON.parse(raw) as Partial<BookSettings>;
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!v || typeof v !== "object") return DEFAULT_SETTINGS;

  const inRange = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;

  return {
    pageBackground: PAGE_BACKGROUNDS.includes(v.pageBackground as never)
      ? (v.pageBackground as BookSettings["pageBackground"])
      : DEFAULT_SETTINGS.pageBackground,
    invert: typeof v.invert === "boolean" ? v.invert : DEFAULT_SETTINGS.invert,
    brightness: inRange(
      v.brightness,
      READER_SETTING_RANGE.brightness.min,
      READER_SETTING_RANGE.brightness.max,
      DEFAULT_SETTINGS.brightness,
    ),
    contrast: inRange(
      v.contrast,
      READER_SETTING_RANGE.contrast.min,
      READER_SETTING_RANGE.contrast.max,
      DEFAULT_SETTINGS.contrast,
    ),
    zoomMode: ZOOM_MODES.includes(v.zoomMode as never)
      ? (v.zoomMode as BookSettings["zoomMode"])
      : DEFAULT_SETTINGS.zoomMode,
    zoom: inRange(
      v.zoom,
      READER_SETTING_RANGE.zoom.min,
      READER_SETTING_RANGE.zoom.max,
      DEFAULT_SETTINGS.zoom,
    ),
    layout: READER_LAYOUTS.includes(v.layout as never)
      ? (v.layout as BookSettings["layout"])
      : DEFAULT_SETTINGS.layout,
    cropMargins: inRange(
      v.cropMargins,
      READER_SETTING_RANGE.cropMargins.min,
      READER_SETTING_RANGE.cropMargins.max,
      DEFAULT_SETTINGS.cropMargins,
    ),
    hideHeaders: typeof v.hideHeaders === "boolean" ? v.hideHeaders : DEFAULT_SETTINGS.hideHeaders,
  };
}

export class BookStore {
  #db: Db;
  #libraryDir: string;
  /** Every root a stored book may live under (a move adds the new one). */
  #roots: Set<string>;

  constructor(db: Db, libraryDir: string) {
    this.#db = db;
    this.#libraryDir = libraryDir;
    this.#roots = new Set([resolve(libraryDir)]);
    mkdirSync(libraryDir, { recursive: true });
  }

  get libraryDir(): string {
    return this.#libraryDir;
  }

  /** F-SET-02: move the library folder; existing books keep their paths. */
  setLibraryDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    // Keep the old root: books already imported still live there, and
    // resolveFile must keep opening them (F-SET-02).
    this.#roots.add(resolve(this.#libraryDir));
    this.#roots.add(resolve(dir));
    this.#libraryDir = dir;
  }

  /** Import a file, deduplicating by content hash. Returns the book id. */
  import(
    sourcePath: string,
    meta?: { title?: string; pageCount?: number },
  ): { id: number; created: boolean } {
    if (!existsSync(sourcePath)) throw new Error(`file not found: ${sourcePath}`);
    const stat = statSync(sourcePath);
    if (!stat.isFile()) throw new Error("not a file");
    if (extname(sourcePath).toLowerCase() !== ".pdf") throw new Error("only PDF files are supported");

    // Stream the file into the hash: a 100 MB PDF must not be resident in
    // main-process memory (F-READ-15, N-PERF-05, S1).
    const sha256 = createHash("sha256");
    const fd = openSync(sourcePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      let read = readSync(fd, buffer, 0, buffer.length, null);
      while (read > 0) {
        sha256.update(buffer.subarray(0, read));
        read = readSync(fd, buffer, 0, buffer.length, null);
      }
    } finally {
      closeSync(fd);
    }
    const digest = sha256.digest("hex");

    const existing = this.#db.get<{ id: number }>("SELECT id FROM book WHERE sha256 = ?", digest);
    if (existing) return { id: existing.id, created: false };

    const dest = join(this.#libraryDir, `${sha256}.pdf`);
    if (!existsSync(dest)) copyFileSync(sourcePath, dest);

    const result = this.#db.run(
      `INSERT INTO book (title, author, file_path, source_path, sha256, page_count, settings_json, added_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
      meta?.title?.trim() || basename(sourcePath, extname(sourcePath)),
      dest,
      sourcePath,
      digest,
      meta?.pageCount ?? 0,
      JSON.stringify(DEFAULT_SETTINGS),
      Date.now(),
    );
    return { id: Number(result.lastInsertRowid), created: true };
  }

  /**
   * Back-fill what the file itself knows once it has been opened.
   *
   * `author` is written as NULL on import (`#insert` never had a value for it),
   * and pdf.js exposes it in the same metadata call the reader already makes for
   * `Title`. F-READ-02 (MUST) asks for "author (from metadata when present)", so
   * this is the one place it can arrive. Both fields are COALESCEd: a PDF that
   * omits a field must not blank what is already stored.
   */
  setPageCount(id: number, pageCount: number, title?: string, author?: string): void {
    // A zero means "pdf.js could not page this file", not "this book has no
    // pages". Writing it would reset a count discovered by an earlier open, so
    // the column is left alone and only the metadata is back-filled.
    this.#db.run(
      `UPDATE book
          SET page_count = CASE WHEN ? > 0 THEN ? ELSE page_count END,
              title = COALESCE(?, title),
              author = COALESCE(?, author)
        WHERE id = ?`,
      pageCount,
      pageCount,
      title?.trim() || null,
      author?.trim() || null,
      id,
    );
  }

  list(): BookRow[] {
    return this.#db
      .all<{
        id: number;
        title: string;
        author: string | null;
        file_path: string;
        source_path: string | null;
        sha256: string;
        page_count: number;
        settings_json: string | null;
        added_at: number;
        archived_at: number | null;
      }>(
        `SELECT id, title, author, file_path, source_path, sha256, page_count, settings_json, added_at, archived_at
         FROM book WHERE archived_at IS NULL ORDER BY added_at DESC`,
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        author: r.author,
        filePath: r.file_path,
        sourcePath: r.source_path,
        sha256: r.sha256,
        pageCount: r.page_count,
        settings: parseSettings(r.settings_json),
        addedAt: r.added_at,
        archivedAt: r.archived_at,
      }));
  }

  get(id: number): BookRow | null {
    // A point query: `list().find()` re-parsed every book and re-ran every
    // count, so listing N books was O(n²) (round-15).
    const r = this.#db.get<{
      id: number;
      title: string;
      author: string | null;
      file_path: string;
      source_path: string;
      sha256: string;
      page_count: number;
      settings_json: string | null;
      added_at: number;
      archived_at: number | null;
    }>("SELECT * FROM book WHERE id = ?", id);
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      author: r.author,
      filePath: r.file_path,
      sourcePath: r.source_path,
      sha256: r.sha256,
      pageCount: r.page_count,
      settings: parseSettings(r.settings_json),
      addedAt: r.added_at,
      archivedAt: r.archived_at,
    };
  }

  /** Path for the privileged protocol handler; refuses anything outside the library. */
  resolveFile(id: number): string | null {
    const row = this.#db.get<{ file_path: string }>("SELECT file_path FROM book WHERE id = ?", id);
    if (!row) return null;
    // Containment against any root this library has had, with resolve+relative
    // (a prefix test accepts `…/library-evil`).
    if (![...this.#roots].some((root) => isInside(root, row.file_path))) return null;
    return existsSync(row.file_path) ? row.file_path : null;
  }

  saveSettings(id: number, settings: BookSettings): void {
    this.#db.run("UPDATE book SET settings_json = ? WHERE id = ?", JSON.stringify(settings), id);
  }

  archive(id: number, archived = true): void {
    this.#db.run("UPDATE book SET archived_at = ? WHERE id = ?", archived ? Date.now() : null, id);
  }

  // ── reading position and sessions ─────────────────────────────────────

  position(bookId: number): { page: number; scrollOffset: number; zoom: number } | null {
    const r = this.#db.get<{ page: number; scroll_offset: number; zoom: number }>(
      "SELECT page, scroll_offset, zoom FROM reading_position WHERE book_id = ?",
      bookId,
    );
    if (!r) return null;
    // `scroll_offset` is a 0..1 fraction of the scrollable range (STACK §4.2).
    // Rows written before that was honoured hold a pixel offset, which can only
    // be > 1. Those cannot be converted without the range they were captured
    // in, so they reset to the top of the page — the page number, which is the
    // primary position, is still exact. Out-of-range values are clamped rather
    // than passed through, so a bad row cannot throw the reader to the bottom.
    const offset = r.scroll_offset > 1 ? 0 : Math.min(1, Math.max(0, r.scroll_offset));
    // Clamp zoom on read too: a bad row must not reach the reader transform.
    const zoom = Number.isFinite(r.zoom)
      ? Math.min(READER_SETTING_RANGE.zoom.max, Math.max(READER_SETTING_RANGE.zoom.min, r.zoom))
      : 1;
    return { page: r.page, scrollOffset: offset, zoom };
  }

  /**
   * Persist the reading position.
   *
   * `scrollOffset` and `zoom` are optional: the page-turn path knows the page
   * but not the offset (the container still holds the previous page's scroll),
   * and the scroll listener knows the offset but not the zoom. Omitting a field
   * preserves the stored value instead of overwriting it with a guess.
   */
  savePosition(bookId: number, page: number, scrollOffset?: number, zoom?: number): void {
    const prev = this.position(bookId);
    this.#db.run(
      `INSERT INTO reading_position (book_id, page, scroll_offset, zoom, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
         page = excluded.page, scroll_offset = excluded.scroll_offset,
         zoom = excluded.zoom, updated_at = excluded.updated_at`,
      bookId,
      page,
      scrollOffset ?? prev?.scrollOffset ?? 0,
      zoom ?? prev?.zoom ?? 1,
      Date.now(),
    );
  }

  startSession(bookId: number, localDate: string): number {
    const r = this.#db.run(
      "INSERT INTO reading_session (book_id, started_at, ended_at, local_date, pages_turned, active_seconds) VALUES (?, ?, ?, ?, 0, 0)",
      bookId,
      Date.now(),
      Date.now(),
      localDate,
    );
    return Number(r.lastInsertRowid);
  }

  /** Close a session, recording active seconds and pages turned. */
  endSession(sessionId: number, activeSeconds: number, pagesTurned: number): void {
    this.#db.run(
      "UPDATE reading_session SET ended_at = ?, active_seconds = ?, pages_turned = ? WHERE id = ?",
      Date.now(),
      Math.max(0, Math.round(activeSeconds)),
      Math.max(0, pagesTurned),
      sessionId,
    );
  }

  progress(bookId: number): {
    page: number;
    scrollOffset: number;
    percent: number;
    lastReadAt: number | null;
  } {
    const pos = this.position(bookId);
    const book = this.get(bookId);
    const pages = book?.pageCount ?? 0;
    const last = this.#db.get<{ at: number }>(
      "SELECT MAX(ended_at) AS at FROM reading_session WHERE book_id = ?",
      bookId,
    );
    return {
      page: pos?.page ?? 1,
      scrollOffset: pos?.scrollOffset ?? 0,
      percent: pages > 0 ? Math.min(1, (pos?.page ?? 1) / pages) : 0,
      lastReadAt: last?.at ?? null,
    };
  }
}
