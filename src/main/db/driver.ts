/**
 * SQLite driver boundary.
 *
 * This is the ONLY module allowed to import `node:sqlite` (STACK.md §4.1).
 * `node:sqlite` is Stability 1.2 (release candidate), so keeping the surface
 * here means a swap to better-sqlite3 touches one file.
 *
 * SP-1 findings encoded below:
 *  - there is no `db.transaction()` helper -> explicit BEGIN/COMMIT/ROLLBACK
 *  - browser history needs immutable/snapshot opens, not plain readOnly
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Row = Record<string, unknown>;

export interface OpenOptions {
  readonly?: boolean;
  /** Set true when reading a foreign DB that must not be modified (browser history). */
  immutable?: boolean;
  busyTimeoutMs?: number;
}

export class Db {
  readonly raw: DatabaseSync;
  /** Absolute path of the open file (":memory:" for tests). */
  readonly filePath: string;
  #depth = 0;

  private constructor(raw: DatabaseSync, filePath: string) {
    this.raw = raw;
    this.filePath = filePath;
  }

  static open(file: string, opts: OpenOptions = {}): Db {
    if (!opts.readonly) mkdirSync(dirname(file), { recursive: true });
    const uri = opts.immutable ? `file:${file}?immutable=1` : file;
    const raw = new DatabaseSync(uri, { readOnly: opts.readonly ?? false });
    const db = new Db(raw, file);
    db.raw.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000};`);
    if (!opts.readonly) {
      db.raw.exec("PRAGMA journal_mode = WAL;");
      db.raw.exec("PRAGMA synchronous = NORMAL;");
      db.raw.exec("PRAGMA foreign_keys = ON;");
    }
    return db;
  }

  /**
   * Execute multi-statement SQL with no parameters.
   *
   * Used for schema setup (a `CREATE TABLE` batch), never for data. A value
   * cannot be bound through `exec`, so anything carrying data must go through
   * `run`/`all` — see the note on `BackupService.create`.
   */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | null {
    const st = this.raw.prepare(sql);
    return (st.get(...(params as never[])) as T | undefined) ?? null;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    const st = this.raw.prepare(sql);
    return st.all(...(params as never[])) as T[];
  }

  /**
   * Read rows with INTEGER columns as `bigint`.
   *
   * Chromium timestamp columns (`visit_time`, `visit_duration`) are microseconds
   * since 1601 and exceed `Number.MAX_SAFE_INTEGER` (SP-1), so reading them as
   * numbers silently loses precision. Kept here rather than exposing
   * `StatementSync`/`setReadBigInts` to callers: `node:sqlite` types are meant to
   * stay inside this module (see the header), and the ingest path used to import
   * them directly to get at this one call.
   */
  allBigInt<T = Row>(sql: string, ...params: unknown[]): T[] {
    const st = this.raw.prepare(sql);
    st.setReadBigInts(true);
    return st.all(...(params as never[])) as T[];
  }

  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const st = this.raw.prepare(sql);
    const r = st.run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  /** Explicit transaction. node:sqlite has no db.transaction() (SP-1). */
  transaction<T>(fn: () => T): T {
    const outermost = this.#depth === 0;
    // Capture the savepoint name before incrementing: COMMIT/RELEASE can throw,
    // and the name must not depend on a depth that the error path also changes.
    const savepoint = `sp_${this.#depth}`;
    if (outermost) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${savepoint}`);
    this.#depth++;
    try {
      const out = fn();
      if (outermost) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${savepoint}`);
      return out;
    } catch (err) {
      try {
        if (outermost) this.raw.exec("ROLLBACK");
        else this.raw.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        /* the rollback itself failed; the original error is what matters */
      }
      throw err;
    } finally {
      // Decrement exactly once, on every path. A failed COMMIT (disk full,
      // deferred FK, SQLITE_BUSY) must not leave the depth negative, or every
      // later transaction in the process emits invalid `SAVEPOINT sp_-1` SQL.
      this.#depth--;
    }
  }

  integrityCheck(): string {
    const r = this.get<{ integrity_check: string }>("PRAGMA integrity_check");
    return r?.integrity_check ?? "unknown";
  }

  close(): void {
    this.raw.close();
  }
}
