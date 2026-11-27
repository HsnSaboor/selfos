/**
 * Launch-mode detection for verification runs.
 *
 * Why this exists (measured on Hyprland 0.56.2 + Electron 45):
 *  - SelfOS is parked on workspace 5 by a Hyprland rule matching class
 *    `^(selfos|electron)$`.
 *  - `app.commandLine.appendSwitch("class", …)` does NOT change the Wayland
 *    app_id on this build: a probe that appended `--class wstest-scratch` was
 *    still reported by `hyprctl clients` as class `electron`. So there is no
 *    in-process way to make a window stop matching that rule.
 *  - The only reliable guard is to never map a window, which is what verifier
 *    mode does. `SELFOS_VERIFY=1` asks for it, but any harness that forgets the
 *    variable (e.g. an ad-hoc probe that `require`s the built main bundle)
 *    maps a window, activates it, and drags the user off their workspace.
 *
 * So we also *infer* the mode: when Electron was not started with this bundle as
 * its entry point, something else loaded it — a spike or a verifier — and the
 * run must not touch the desktop.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** The two filesystem calls this module makes, injectable for tests. */
export interface FsProbe {
  statSync: (path: string) => { isDirectory: () => boolean };
  readFileSync: (path: string, encoding: "utf8") => string;
}

const NODE_FS: FsProbe = {
  statSync: (path) => statSync(path),
  readFileSync: (path, encoding) => readFileSync(path, encoding),
};

/**
 * True when the main bundle was loaded by another script rather than launched
 * by Electron as the app entry point.
 *
 * `argv` is Electron's `process.argv`: `[electronPath, entry, ...flags]`, though
 * Electron inserts some of its own flags *before* the entry point, so the entry
 * is the first argument that is not a switch. A directory entry is resolved
 * through its `package.json` `main`, because that is how `electron .` and
 * `electron-vite dev` start the app.
 */
/**
 * Chromium/Electron switches that take a separate value argument.
 *
 * Without this, `electron --user-data-dir /tmp/x out/main/index.cjs` read
 * `/tmp/x` as the entry point: a real launch was classified as a harness run,
 * its window stayed unmapped and its data went to the scratch directory.
 */
const SWITCHES_WITH_VALUE = new Set([
  "--user-data-dir",
  "--class",
  "--wayland-app-id",
  "--ozone-platform",
  "--lang",
  "--proxy-server",
  "--host-resolver-rules",
  "--disk-cache-dir",
  "--log-file",
  "--remote-debugging-port",
]);

export function isHarnessLaunch(
  argv: readonly string[],
  cwd: string,
  bundlePath: string,
  fs: FsProbe = NODE_FS,
): boolean {
  const args = argv.slice(1);
  let entry: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("-")) {
      if (SWITCHES_WITH_VALUE.has(arg)) i++;
      continue;
    }
    entry = arg;
    break;
  }
  // A packaged app passes the launch path, not a script; nothing to compare.
  if (!entry) return false;

  let resolved: string;
  try {
    resolved = resolve(cwd, entry);
    if (fs.statSync(resolved).isDirectory()) {
      const pkg = JSON.parse(fs.readFileSync(join(resolved, "package.json"), "utf8")) as {
        main?: string;
      };
      if (!pkg.main) return false;
      resolved = resolve(resolved, pkg.main);
    }
  } catch {
    // Unknown path (asar archive, a directory without package.json): assume a
    // real launch. Guessing "harness" here would hide the app's own window.
    return false;
  }

  return resolved !== bundlePath;
}
