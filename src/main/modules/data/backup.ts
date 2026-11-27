/**
 * Backup and export (PRD F-SET-03, F-SET-04).
 *
 * Backups use `VACUUM INTO`, which is the only way to take a consistent copy of
 * a live WAL database through node:sqlite: it is atomic with respect to
 * concurrent writers and needs no exclusive lock, so the collector keeps
 * running while a backup is written.
 *
 * Retention is a pure function so it can be tested without touching the disk.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { BackupKind } from "../../../shared/api";
import type { Db } from "../../db/driver";
import { localDateKey } from "../time/aggregate";

/**
 * Re-exported for the module's own callers. The declaration lives in
 * `shared/api.ts` beside `BackupFileView`, which carries the same union across
 * the IPC contract — declaring it here as well left the two free to drift.
 */
export type { BackupKind };

export interface BackupFile {
  name: string;
  path: string;
  kind: BackupKind;
  bytes: number;
  createdAt: number;
}

/** `selfos-2026-11-02.sqlite` for daily, `selfos-week-2026-W44.sqlite` weekly. */
export function backupName(kind: BackupKind, date: Date, manualLabel?: string): string {
  const day = localDateKey(date);
  if (kind === "weekly") {
    const { year, week } = isoWeek(date);
    return `selfos-week-${year}-W${String(week).padStart(2, "0")}.sqlite`;
  }
  if (kind === "manual") {
    const stamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return `selfos-manual-${manualLabel ? `${manualLabel}-` : ""}${stamp}.sqlite`;
  }
  return `selfos-${day}.sqlite`;
}

export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * Which backups to delete, newest first kept.
 *
 * Manual backups are never pruned — the user asked for them explicitly. Weekly
 * copies are kept longer than dailies because they are the ones that survive a
 * mistake noticed a month later.
 */
export function pruneList(
  files: Array<{ name: string; kind: BackupKind; createdAt: number }>,
  opts: { daily: number; weekly: number },
): string[] {
  const byNewest = [...files].sort((a, b) => b.createdAt - a.createdAt);
  const drop: string[] = [];
  const counts: Record<BackupKind, number> = { daily: 0, weekly: 0, manual: 0 };
  for (const f of byNewest) {
    counts[f.kind]++;
    const limit =
      f.kind === "daily" ? opts.daily : f.kind === "weekly" ? opts.weekly : Number.POSITIVE_INFINITY;
    if (counts[f.kind] > limit) drop.push(f.name);
  }
  return drop;
}

export function classifyBackup(name: string): BackupKind {
  if (name.includes("-week-")) return "weekly";
  if (name.includes("-manual-")) return "manual";
  return "daily";
}

export class BackupService {
  #db: Db;
  #dir: string;

  constructor(db: Db, dir: string) {
    this.#db = db;
    this.#dir = dir;
  }

  get directory(): string {
    return this.#dir;
  }

  /** F-SET-02: move future backups to another folder. */
  setDirectory(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.#dir = dir;
  }

  list(): BackupFile[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .filter((n) => n.endsWith(".sqlite"))
      .map((name) => {
        const path = join(this.#dir, name);
        const stat = statSync(path);
        return { name, path, kind: classifyBackup(name), bytes: stat.size, createdAt: stat.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Write a backup now. Existing files with the same name are replaced. */
  create(kind: BackupKind = "manual", now = new Date()): BackupFile {
    mkdirSync(this.#dir, { recursive: true });
    const name = backupName(kind, now);
    const path = join(this.#dir, name);
    if (existsSync(path)) rmSync(path);
    // A prepared statement is required: `exec` does not bind parameters, and
    // the filename is data, not SQL.
    this.#db.raw.prepare("VACUUM INTO ?").run(path);
    const stat = statSync(path);
    return { name, path, kind, bytes: stat.size, createdAt: stat.mtimeMs };
  }

  /** Daily retention: one backup per day, pruned to `daily` + `weekly`. */
  runScheduled(now = new Date(), retention = { daily: 14, weekly: 8 }): BackupFile | null {
    const dayName = backupName("daily", now);
    const weeklyName = backupName("weekly", now);
    mkdirSync(this.#dir, { recursive: true });

    let created: BackupFile | null = null;
    if (!existsSync(join(this.#dir, dayName))) created = this.create("daily", now);
    // Sunday is the ISO week's last day; taking the weekly copy then captures
    // the whole week.
    if (now.getDay() === 0 && !existsSync(join(this.#dir, weeklyName))) {
      const weekly = this.create("weekly", now);
      created = created ?? weekly;
    }

    const files = this.list().map((f) => ({ name: f.name, kind: f.kind, createdAt: f.createdAt }));
    for (const name of pruneList(files, retention)) rmSync(join(this.#dir, name), { force: true });
    return created;
  }
}

/** Full JSON export of every user table (F-SET-03). */
export function exportJson(db: Db): { exportedAt: string; tables: Record<string, unknown[]> } {
  const tables = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    // Table names come from sqlite_master, never from user input, and are
    // quoted so a table called "group" or "select" still works.
    out[t] = db.all(`SELECT * FROM "${t.replace(/"/g, '""')}"`);
  }
  return { exportedAt: new Date().toISOString(), tables: out };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV for one table, with a header row (F-SET-03). */
export function tableToCsv(db: Db, table: string, opts: { from?: string; to?: string } = {}): string {
  const exists = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  );
  if (!exists) throw new Error(`no such table: ${table}`);

  const columns = db.all<{ name: string }>(`PRAGMA table_info("${table.replace(/"/g, '""')}")`);
  if (columns.length === 0) throw new Error(`no columns in ${table}`);

  // Date filtering applies only to tables that carry a date column.
  const dateCol = columns.find((c) => ["local_date", "start_date"].includes(c.name))?.name;
  const where: string[] = [];
  const params: unknown[] = [];
  if (dateCol && (opts.from || opts.to)) {
    if (opts.from) {
      where.push(`${dateCol} >= ?`);
      params.push(opts.from);
    }
    if (opts.to) {
      where.push(`${dateCol} <= ?`);
      params.push(opts.to);
    }
  }

  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM "${table.replace(/"/g, '""')}"${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
    ...params,
  );
  const head = columns.map((c) => csvCell(c.name)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.name])).join(","));
  return [head, ...body].join("\n");
}

/**
 * Stage a restore: validate and copy the backup aside, and record a pending
 * marker. The swap itself must happen with no open connection, so it runs on
 * the next launch (see `applyPendingRestore`).
 *
 * Copying over a live WAL database does not work: the open connection keeps
 * writing through its WAL, the safety copy taken from the main file alone has
 * no tables in it, and when the connection closes it checkpoints the old pages
 * back over the restored file — silently undoing the restore. Verified.
 */
export function stageRestore(backupPath: string, livePath: string): { staged: true; backupName: string } {
  if (!existsSync(backupPath)) throw new Error("backup not found");
  const staged = `${livePath}.pending-restore`;
  copyFileSync(backupPath, staged);
  return { staged: true, backupName: basename(backupPath) };
}

/**
 * Apply a staged restore. Call this BEFORE the database is opened.
 * Returns the safety copy path, or null when nothing was staged.
 *
 * The safety copy must include the previous process's `-wal`: after a kill
 * (earlyoom prefers Electron on this machine, SP-2) the newest committed rows
 * live only there, and deleting the sidecars before copying lost them. The
 * staged file is then moved into place with a rename rather than copied over
 * the live path, so an ENOSPC or a crash mid-swap cannot leave a truncated
 * database behind.
 */
export function applyPendingRestore(livePath: string): string | null {
  const staged = `${livePath}.pending-restore`;
  if (!existsSync(staged)) return null;

  const safetyCopy = `${livePath}.pre-restore-${Date.now()}`;
  if (existsSync(livePath)) copyFileSync(livePath, safetyCopy);
  // A hot WAL belongs to the database being replaced, so it is preserved next
  // to the safety copy instead of being discarded.
  for (const suffix of ["-wal", "-shm"]) {
    const side = `${livePath}${suffix}`;
    if (existsSync(side)) copyFileSync(side, `${safetyCopy}${suffix}`);
  }

  // Move the staged file beside the live one, then rename over it: rename is
  // atomic within a filesystem, copyFileSync over a live file is not.
  const next = `${livePath}.restoring-${process.pid}`;
  copyFileSync(staged, next);
  renameSync(next, livePath);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${livePath}${suffix}`, { force: true });
  rmSync(staged, { force: true });
  return safetyCopy;
}

/** Write a string to disk, creating the directory first. */
export function writeExport(path: string, content: string): { path: string; bytes: number } {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { path, bytes: Buffer.byteLength(content) };
}

/**
 * Where an export lands: `<userData>/exports/selfos-YYYY-MM-DD[-table].ext`.
 * The renderer never supplies a path, so an export cannot overwrite arbitrary
 * files. An existing file is overwritten only if it is today's export.
 */
export function exportPath(
  userDataDir: string,
  ext: "json" | "csv",
  table?: string,
  now = new Date(),
): string {
  const safeTable = table ? table.replace(/[^\w.-]/g, "_") : "";
  const name = `selfos-${localDateKey(now)}${safeTable ? `-${safeTable}` : ""}.${ext}`;
  return join(userDataDir, "exports", name);
}
