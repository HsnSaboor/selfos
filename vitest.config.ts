import { defineConfig } from "vitest/config";

/**
 * Vitest pool bounds — an OOM guard, not a speed knob.
 *
 * This project had no vitest config, so vitest used its defaults: the `forks`
 * pool spawns a full Node process per test file, up to `nproc` (8 here)
 * concurrently, each holding its own Vite transform cache. On a 7.6 GB machine
 * that is enough to matter, and full-suite runs were implicated in
 * `systemd-oomd` killing entire session cgroups (146 and 129 processes at once
 * on 2026-11-03).
 *
 * `maxWorkers: 1` is the measured floor, not a guess: peak RSS for the full
 * suite is ~282 MB, against ~343 MB at 2 workers and the unbounded default
 * above that. The suite runs in a few seconds either way, so the memory saving
 * is free.
 *
 * `isolate: false` and `fileParallelism: false` were tried and REJECTED: they
 * cut memory further but 4 tests failed, because files share process state.
 * Do not re-enable them to save memory — the isolation is load-bearing.
 *
 * This bounds one run. It does not stop repeated runs from adding up; for a
 * hard ceiling that cannot contribute to system pressure at all, run the suite
 * through `just test`, which wraps it in a memory-capped scope (the uncapped
 * `bunx vitest run` stays available as `just test-plain`).
 */
export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
