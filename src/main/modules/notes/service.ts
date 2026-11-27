/**
 * Notes service: vault selection, search, and the two sanctioned writes
 * (highlight export, daily note capture). STACK §9, F-NOTES-01..10.
 */

import { existsSync, type FSWatcher, readdirSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { localDateKey } from "../../../shared/dates";
import { buildHighlightsMarkdown } from "../../../shared/highlights";
import type { Db } from "../../db/driver";
import { loadHighlights } from "../reading/service";
import {
  discoverVaults,
  exportMarker,
  IGNORED_DIRS,
  type NoteHit,
  NotesIndex,
  resolveInVault,
  safeFolder,
  type VaultConfig,
} from "./index";

export interface NotesStatus {
  vault: VaultConfig | null;
  discovered: VaultConfig[];
  noteCount: number;
  lastIndexAt: number | null;
}

export class NotesService {
  #index: NotesIndex;
  #db: Db;
  #watcher: FSWatcher | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #seen = new Map<string, number>();
  #lastIndexAt: number | null = null;
  #pending = new Set<string>();
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, indexPath: string) {
    this.#db = db;
    this.#index = new NotesIndex(indexPath);

    // Restore the previously selected vault if it still exists. A path the user
    // typed by hand is not in Obsidian's config, so discovery alone would
    // silently forget the selection on every launch. `isDirectory` matters: a
    // vault that was replaced by a file must not be indexed or watched.
    const saved = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'vault_path'");
    if (saved?.value && existsSync(saved.value) && statSync(saved.value).isDirectory()) {
      const discovered = discoverVaults();
      const vault = discovered.find((v) => v.path === saved.value) ?? {
        path: saved.value,
        name: basename(saved.value),
      };
      try {
        this.#index.setVault(vault);
        this.#lastIndexAt = Date.now();
        this.#watchVault(vault.path);
      } catch (err) {
        console.error("[notes] could not restore vault:", err instanceof Error ? err.message : err);
      }
    }
  }

  status(): NotesStatus {
    return {
      vault: this.#index.vault,
      discovered: discoverVaults(),
      noteCount: this.#index.count(),
      lastIndexAt: this.#lastIndexAt,
    };
  }

  selectVault(path: string): NotesStatus {
    // The path arrives from a free-text field, so it is validated here rather
    // than persisted on trust: a typo used to be written to `meta.vault_path`
    // and the UI then reported an empty vault instead of an error, and a path
    // like `/` turned the indexer into a full-filesystem crawl. The discovered
    // list is filtered with `existsSync`; the manual path was not.
    const resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new Error(`vault path is not a directory: ${path}`);
    }
    const vault = { path: resolved, name: basename(resolved) || "vault" };
    const count = this.#index.setVault(vault);
    this.#db.run(
      "INSERT INTO meta(key, value) VALUES ('vault_path', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      vault.path,
    );
    this.#lastIndexAt = Date.now();
    this.#watchVault(vault.path);
    return { ...this.status(), noteCount: count };
  }

  /** Disconnect the vault. The index is cleared; files on disk are untouched. */
  clearVault(): NotesStatus {
    this.#watcher?.close();
    this.#watcher = null;
    this.#index.setVault(null);
    this.#db.run("DELETE FROM meta WHERE key = 'vault_path'");
    this.#lastIndexAt = null;
    return this.status();
  }

  list(): NoteHit[] {
    return this.#index.list();
  }

  search(query: string): NoteHit[] {
    return this.#index.search(query);
  }

  read(path: string): string | null {
    return this.#index.read(path);
  }

  uri(path: string, heading?: string): string {
    return this.#index.uri(path, heading);
  }

  reindex(): number {
    const n = this.#index.reindex();
    this.#lastIndexAt = Date.now();
    return n;
  }

  // ── writes ────────────────────────────────────────────────────────────

  /**
   * Export a book's highlights into a vault note. Idempotent: the note is only
   * rewritten when the highlight count changed, tracked via a marker line.
   */
  exportHighlights(
    bookId: number,
    folder = "SelfOS/Books",
  ): { path: string; created: boolean; skipped: boolean } {
    if (!this.#index.vault) throw new Error("no vault selected");
    const exportData = this.#exportFor(bookId);
    // Include the book id in the name: two PDFs titled "Untitled" would
    // otherwise share one note and overwrite each other on every export.
    const rel = `${safeFolder(folder)}/${sanitizeFilename(exportData.title)}-${bookId}.md`;
    const marker = exportMarker(bookId, exportData.contentKey);
    const existing = this.#index.read(rel);

    if (existing?.includes(marker)) {
      return { path: rel, created: false, skipped: true };
    }

    const body = `${exportData.markdown}\n\n<!-- ${marker} -->\n`;
    if (existing) {
      // Replace only our own managed note; it is generated, not hand-written.
      this.#writeNote(rel, body);
      return { path: rel, created: false, skipped: false };
    }
    const res = this.#index.createIfAbsent(rel, body);
    return { path: rel, created: res.created, skipped: false };
  }

  /** Append a line to today's daily note, creating it if needed. */
  quickCapture(text: string, folder = "Daily"): { path: string; created: boolean } {
    if (!this.#index.vault) throw new Error("no vault selected");
    if (!text.trim()) throw new Error("nothing to capture");
    const date = localDateKey(new Date());
    const rel = `${safeFolder(folder)}/${date}.md`;
    const created = !this.#index.read(rel);
    const line = `- ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — ${text.trim()}`;
    const res = this.#index.append(rel, line);
    return { path: res.path, created };
  }

  /** Create today's daily note with a heading if it does not exist. */
  ensureDailyNote(folder = "Daily"): { path: string; created: boolean } {
    if (!this.#index.vault) throw new Error("no vault selected");
    const date = localDateKey(new Date());
    const rel = `${safeFolder(folder)}/${date}.md`;
    return this.#index.createIfAbsent(rel, `# ${date}\n\n`);
  }

  close(): void {
    this.#watcher?.close();
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#index.close();
  }

  // ── internals ─────────────────────────────────────────────────────────

  #exportFor(bookId: number): { title: string; markdown: string; contentKey: string } {
    // ReadingService owns the export formatting; both call the shared builder
    // in shared/highlights.ts, so the two cannot drift.
    const book = this.#db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", bookId);
    if (!book) throw new Error("book not found");
    // Reading owns its tables; notes consumes the shared query (P-1).
    const rows = loadHighlights(this.#db, bookId);
    const markdown = buildHighlightsMarkdown(
      book.title,
      rows.map((r) => ({ page: r.page, text: r.text, note: r.note })),
    );
    // The marker must change whenever any row changes, not just when the
    // count does — otherwise a swapped or edited highlight is never re-exported.
    const contentKey = rows.map((r) => `${r.page}\u0000${r.text}\u0000${r.note ?? ""}`).join("\u0001");
    return { title: book.title, markdown, contentKey };
  }

  #writeNote(rel: string, content: string): void {
    if (!this.#index.vault) throw new Error("no vault selected");
    const abs = resolveInVault(this.#index.vault.path, rel);
    const tmp = `${abs}.selfos-tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
    this.#index.upsertFile(abs, rel);
  }

  /** Fallback watcher for platforms without recursive fs.watch (Linux). */
  #pollVault(root: string): void {
    const walk = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = join(dir, name);
        try {
          const stat = statSync(abs);
          if (stat.isDirectory()) {
            if (!IGNORED_DIRS.has(name)) walk(abs);
            continue;
          }
          if (!name.endsWith(".md")) continue;
          if ((this.#seen.get(abs) ?? 0) !== stat.mtimeMs) {
            this.#seen.set(abs, stat.mtimeMs);
            this.#index.upsertFile(abs, relative(root, abs).split(sep).join("/"));
          }
        } catch {
          /* vanished mid-walk */
        }
      }
    };
    walk(root);
  }

  /** Debounced watch so external edits appear without a full re-index. */
  #watchVault(root: string): void {
    this.#watcher?.close();
    try {
      this.#watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename?.endsWith(".md")) return;
        this.#pending.add(String(filename));
        if (this.#flushTimer) clearTimeout(this.#flushTimer);
        this.#flushTimer = setTimeout(() => {
          for (const rel of this.#pending) {
            // One unreadable or vanished note must not crash the main process:
            // this runs in a timer, so a throw would be uncaught.
            try {
              const abs = join(root, rel);
              if (existsSync(abs)) this.#index.upsertFile(abs, rel);
              else this.#index.removeFile(rel);
            } catch (err) {
              console.error("[notes] watch update failed:", rel, err instanceof Error ? err.message : err);
            }
          }
          this.#pending.clear();
          this.#lastIndexAt = Date.now();
        }, 500);
      });
    } catch {
      // `fs.watch(recursive)` is macOS/Windows only. On Linux fall back to a
      // 2 s mtime poll so external edits still appear (F-NOTES-06).
      this.#watcher = null;
      this.#pollTimer = setInterval(() => this.#pollVault(root), 2000);
    }
  }
}

export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "untitled"
  );
}
