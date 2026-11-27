/**
 * Temp-directory helper for tests.
 *
 * `mkdtempSync` alone leaks a directory per call. The suite creates several
 * per file, and repeated runs accumulated hundreds of them (811 at one point),
 * which filled `/tmp` and broke unrelated tooling. `afterEach` removes
 * everything created through here, so a run leaves nothing behind whether it
 * passes or fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Create a temp directory that is removed after the current test file. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
