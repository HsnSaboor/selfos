/**
 * Forward-only migrations (STACK.md §4.3).
 * `PRAGMA user_version` is the level. A backup is taken before any upgrade.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./driver";

const MIGRATIONS_DIR = join(__dirname, "migrations");

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 4)),
      name: f,
      sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8"),
    }));
}

export function currentVersion(db: Db): number {
  const row = db.get<{ user_version: number }>("PRAGMA user_version");
  return row?.user_version ?? 0;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
}

export function migrate(db: Db): MigrateResult {
  const from = currentVersion(db);
  const pending = loadMigrations().filter((m) => m.version > from);
  const applied: string[] = [];

  for (const m of pending) {
    db.transaction(() => {
      db.raw.exec(m.sql);
      db.raw.exec(`PRAGMA user_version = ${m.version}`);
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", "schema_version", String(m.version));
    });
    applied.push(m.name);
  }

  return { from, to: currentVersion(db), applied };
}
