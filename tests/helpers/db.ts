import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tempDir } from "./temp";
import { Db } from "../../src/main/db/driver";
import { migrate } from "../../src/main/db/migrate";

/**
 * A fresh migrated database in a temp dir that is removed after the test.
 *
 * `freshDb()` was copy-pasted in four test files and rebuilt inline in more;
 * one helper keeps the schema version and cleanup in one place.
 */
export function freshDb(prefix = "selfos-test-"): Db {
  const dir = tempDir(prefix);
  const db = Db.open(join(dir, "selfos.sqlite"));
  migrate(db);
  return db;
}

export function rawDb(file: string): DatabaseSync {
  return new DatabaseSync(file);
}