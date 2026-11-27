/**
 * Obsidian vault index (PRD F-NOTES-01..10, STACK §9).
 *
 * The vault is the user's primary knowledge store and may be synced elsewhere,
 * so this module is read-only by default. Writes happen only through explicit,
 * atomic, user-initiated actions, and never rewrite existing content.
 *
 * The index lives in its own SQLite file so a re-index never bloats the main
 * database or contends with collector writes.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Db } from "../../db/driver";

export interface VaultConfig {
  path: string;
  name: string;
}

export interface NoteHit {
  path: string;
  title: string;
  snippet: string;
  tags: string[];
  modifiedAt: number;
}

const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
const OBSIDIAN_CONFIG = join(homedir(), ".config/obsidian/obsidian.json");

/**
 * Discover vaults from Obsidian's own config. The recorded path may no longer
 * exist (it does not on this machine), so every candidate is validated.
 */
export function discoverVaults(): VaultConfig[] {
  try {
    const raw = JSON.parse(readFileSync(OBSIDIAN_CONFIG, "utf8")) as {
      vaults?: Record<string, { path?: string }>;
    };
    const out: VaultConfig[] = [];
    for (const v of Object.values(raw.vaults ?? {})) {
      if (typeof v.path !== "string") continue;
      if (!existsSync(v.path)) continue;
      out.push({ path: v.path, name: basename(v.path) });
    }
    return out;
  } catch {
    return [];
  }
}

interface NoteRow {
  path: string;
  title: string;
  body: string;
  tags: string;
  modified_at: number;
  size: number;
}

// One implementation, shared with the renderer (src/shared/frontmatter.ts).
import { splitFrontmatter } from "../../../shared/frontmatter";

export { splitFrontmatter };

/** Inline #tags plus frontmatter `tags:` entries. */
export function extractTags(frontmatter: string, body: string): string[] {
  const tags = new Set<string>();
  for (const m of body.matchAll(/(^|\s)#([\w/-]{2,})/g)) {
    if (m[2]) tags.add(m[2]);
  }
  const fmTags = frontmatter.match(/^tags:\s*(.+)$/m);
  if (fmTags?.[1]) {
    const raw = fmTags[1].replace(/[[\]]/g, "");
    for (const t of raw.split(/[,\s]+/)) {
      const clean = t.trim().replace(/^["']|["']$/g, "");
      if (clean) tags.add(clean);
    }
  }
  return [...tags];
}

/**
 * First `count` lines of prose, for search snippets.
 * Headings, images, and fenced code blocks are skipped so a snippet shows the
 * note's actual content rather than its title or markup.
 */
export function firstLines(body: string, count = 2): string {
  const out: string[] = [];
  let inFence = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) continue;
    if (line.startsWith("#")) continue; // heading
    if (line.startsWith("![")) continue; // image
    if (line.startsWith("|") || (/^[-*]\s/.test(line) === false && /^[-=]{3,}$/.test(line))) continue;

    out.push(line.replace(/^>\s*/, ""));
    if (out.length >= count) break;
  }
  return out.join(" ");
}

/**
 * Resolve a vault-relative path, refusing anything that escapes the vault.
 *
 * `join(vault, rel).startsWith(vault)` is not containment: a sibling directory
 * whose name shares the prefix (`…/Notes` vs `…/Notes-private`) passes, so
 * `../Notes-private/secret.md` reads and writes outside the vault. Resolve
 * first, then require the relative path to stay inside.
 */
export function resolveInVault(vaultPath: string, relPath: string): string {
  if (isAbsolute(relPath)) throw new Error("path escapes the vault");
  const root = resolve(vaultPath);
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the vault");
  }
  return abs;
}

/** Reject a folder argument that would leave the vault or name a file. */
export function safeFolder(folder: string): string {
  const clean = folder
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  if (!clean) throw new Error("folder is required");
  for (const part of clean.split("/")) {
    if (part === "" || part === "." || part === "..") throw new Error("invalid folder");
  }
  return clean;
}

export class NotesIndex {
  /**
   * The shared driver. `node:sqlite` is imported only by `driver.ts`
   * (that module's header), so the FTS index goes through it too rather than
   * making this the second file a driver swap would have to touch.
   */
  #db: Db;
  #vault: VaultConfig | null = null;

  constructor(indexPath: string) {
    mkdirSync(dirname(indexPath), { recursive: true });
    this.#db = Db.open(indexPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS note (
        path TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '', modified_at INTEGER NOT NULL, size INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
        path UNINDEXED, title, body, tags, tokenize='unicode61'
      );
    `);
  }

  get vault(): VaultConfig | null {
    return this.#vault;
  }

  /** Point the index at a vault. Returns the number of notes indexed. */
  setVault(vault: VaultConfig | null): number {
    if (!vault) {
      this.#vault = null;
      this.#db.exec("DELETE FROM note; DELETE FROM note_fts;");
      return 0;
    }
    // Assign only after a successful index, so a failed selection cannot leave
    // the index pointing at a vault whose contents were never read.
    const previous = this.#vault;
    this.#vault = vault;
    try {
      return this.reindex();
    } catch (err) {
      this.#vault = previous;
      throw err;
    }
  }

  /** Full re-index. Incremental updates reuse `upsertFile`. */
  reindex(): number {
    if (!this.#vault) return 0;
    const files = walkMarkdown(this.#vault.path);
    const seen = new Set<string>();

    for (const abs of files) {
      const rel = relative(this.#vault.path, abs).split(sep).join("/");
      seen.add(rel);
      this.upsertFile(abs, rel);
    }

    // Remove notes deleted outside the app.
    const rows = this.#db.all<{ path: string }>("SELECT path FROM note");
    for (const r of rows) {
      if (!seen.has(r.path)) {
        this.#db.run("DELETE FROM note WHERE path = ?", r.path);
        this.#db.run("DELETE FROM note_fts WHERE path = ?", r.path);
      }
    }
    return files.length;
  }

  /** Index or refresh one file. Skips work when mtime and size are unchanged. */
  upsertFile(absPath: string, relPath?: string): boolean {
    if (!this.#vault) return false;
    const rel = relPath ?? relative(this.#vault.path, absPath).split(sep).join("/");
    // A directory named `x.md`, or a note that vanished between the watch event
    // and this call, must be skipped rather than throwing into a timer callback
    // (which would be an uncaught exception in the main process).
    let stat: ReturnType<typeof statSync>;
    let src: string;
    try {
      stat = statSync(absPath);
      if (!stat.isFile()) return false;
      src = readFileSync(absPath, "utf8");
    } catch {
      return false;
    }
    const existing = this.#db.get<{ modified_at: number; size: number }>(
      "SELECT modified_at, size FROM note WHERE path = ?",
      rel,
    );
    if (existing && existing.modified_at === stat.mtimeMs && existing.size === stat.size) return false;

    const { frontmatter, body } = splitFrontmatter(src);
    const title = basename(rel, ".md");
    const tags = extractTags(frontmatter, body);

    this.#db.run(
      `INSERT INTO note (path, title, body, tags, modified_at, size) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title, body = excluded.body, tags = excluded.tags,
         modified_at = excluded.modified_at, size = excluded.size`,
      rel,
      title,
      body,
      tags.join(" "),
      stat.mtimeMs,
      stat.size,
    );

    this.#db.run("DELETE FROM note_fts WHERE path = ?", rel);
    this.#db.run(
      "INSERT INTO note_fts (path, title, body, tags) VALUES (?, ?, ?, ?)",
      rel,
      title,
      body,
      tags.join(" "),
    );
    return true;
  }

  removeFile(relPath: string): void {
    this.#db.run("DELETE FROM note WHERE path = ?", relPath);
    this.#db.run("DELETE FROM note_fts WHERE path = ?", relPath);
  }

  list(limit = 200): NoteHit[] {
    const rows = this.#db.all<NoteRow>(
      "SELECT path, title, body, tags, modified_at FROM note ORDER BY modified_at DESC LIMIT ?",
      limit,
    );
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      snippet: firstLines(r.body),
      tags: r.tags ? r.tags.split(" ").filter(Boolean) : [],
      modifiedAt: r.modified_at,
    }));
  }

  /** Full-text search with highlighted snippets. */
  search(query: string, limit = 50): NoteHit[] {
    const q = query.trim();
    if (!q) return [];
    // FTS5 treats bare punctuation as syntax; quote each term.
    const terms = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, "")}"*`)
      .join(" ");
    try {
      const rows = this.#db.all<{
        path: string;
        title: string;
        snip: string;
        tags: string;
        modified_at: number;
      }>(
        `SELECT n.path, n.title, snippet(note_fts, 2, '<<', '>>', '…', 12) AS snip,
                n.tags, n.modified_at
           FROM note_fts JOIN note n ON n.path = note_fts.path
          WHERE note_fts MATCH ? ORDER BY rank LIMIT ?`,
        terms,
        limit,
      );
      return rows.map((r) => ({
        path: r.path,
        title: r.title,
        snippet: cleanSnippet(r.snip),
        tags: r.tags ? r.tags.split(" ").filter(Boolean) : [],
        modifiedAt: r.modified_at,
      }));
    } catch {
      return [];
    }
  }

  read(relPath: string): string | null {
    if (!this.#vault) return null;
    let abs: string;
    try {
      abs = resolveInVault(this.#vault.path, relPath);
    } catch {
      return null;
    }
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  }

  count(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM note")?.n ?? 0;
  }

  // ── writes (explicit, atomic, never destructive) ──────────────────────

  /**
   * Append to a note, creating it if absent. Used for quick capture and the
   * daily note. Existing content is never rewritten or reordered.
   */
  append(relPath: string, text: string): { path: string; created: boolean } {
    if (!this.#vault) throw new Error("no vault selected");
    const abs = resolveInVault(this.#vault.path, relPath);
    mkdirSync(dirname(abs), { recursive: true });

    const created = !existsSync(abs);
    const existing = created ? "" : readFileSync(abs, "utf8");
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    const next = `${existing}${separator}${text.trim()}\n`;

    // Atomic replace: write a sibling temp file, then rename over the original.
    const tmp = `${abs}.selfos-tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, abs);
    this.upsertFile(abs, relPath);
    return { path: relPath, created };
  }

  /** Create a note only if it does not exist. Never overwrites. */
  createIfAbsent(relPath: string, content: string): { path: string; created: boolean } {
    if (!this.#vault) throw new Error("no vault selected");
    const abs = resolveInVault(this.#vault.path, relPath);
    if (existsSync(abs)) return { path: relPath, created: false };
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.upsertFile(abs, relPath);
    return { path: relPath, created: true };
  }

  /** Obsidian URI for a note, optionally at a heading. */
  uri(relPath: string, heading?: string): string {
    const vaultName = this.#vault?.name ?? "";
    const file = encodeURIComponent(relPath.replace(/\.md$/, ""));
    const base = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${file}`;
    return heading ? `${base}&heading=${encodeURIComponent(heading)}` : base;
  }

  close(): void {
    this.#db.close();
  }
}

function walkMarkdown(root: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const abs = join(root, entry);
    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) walkMarkdown(abs, out);
      else if (entry.toLowerCase().endsWith(".md")) out.push(abs);
    } catch {
      /* unreadable entry: skip */
    }
  }
  return out;
}

/**
 * FTS5 snippets come back with the source markup intact. Strip the parts that
 * are noise in a one-line preview while keeping the `<<`/`>>` match markers.
 */
export function cleanSnippet(snip: string): string {
  return snip
    .replace(/```[\w-]*/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Content hash that makes highlight exports idempotent.
 *
 * It must cover the *content*, not just the row count: deleting one highlight
 * and adding another leaves the count unchanged, so a count-keyed marker
 * reports "up to date" while the note still holds the old text. Editing a
 * highlight's note had the same effect.
 */
export function exportMarker(bookId: number, content: string): string {
  return `selfos:${createHash("sha1").update(`${bookId}:${content}`).digest("hex").slice(0, 12)}`;
}
