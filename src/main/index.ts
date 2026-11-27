/**
 * Main process entry (STACK.md §2.3, §2.5).
 *
 * Lifecycle decisions encoded here:
 *  - close hides to tray; quit is explicit (F-SHELL-04)
 *  - single instance lock (F-SHELL-10)
 *  - window size persisted, position NOT (Wayland cannot place windows, C-13)
 *  - theme changes are pushed to the renderer (F-SET-08)
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { app, BrowserWindow, dialog, Menu, nativeImage, protocol, shell, Tray } from "electron";
import { PRAYER_IDS } from "../shared/api";
import { isInside } from "../shared/paths";
import { isSafeExternalUrl } from "./external-url";
import { watchTheme } from "./integrations/omarchy-theme";
import { PRAYER_LABELS } from "./integrations/salah/bridge";
import { registerIpc } from "./ipc/handlers";
import { isHarnessLaunch } from "./launch-mode";
import { Services } from "./services/context";

const isDev = !app.isPackaged;

// Without this, userData defaults to ~/.config/Electron, shared with every
// other Electron app on the machine.
app.setName("SelfOS");

/**
 * Verification runs must not steal focus or move the user's workspace.
 *
 * The Hyprland rule that parks SelfOS on workspace 5 matches class
 * `^(selfos|electron)$`, so a headless verifier launched with those classes
 * yanks the user off whatever workspace they are on. Two things guard it:
 *  - `SELFOS_VERIFY=1` asks for verifier mode explicitly (just recipes set it),
 *    and every window stays unmapped.
 *  - a harness launch is *inferred* when this bundle was `require`d by another
 *    script instead of being Electron's entry point (see `launch-mode.ts`).
 *    That catches ad-hoc probes which never set the variable.
 *
 * There is deliberately no attempt to give verifier windows a different app_id.
 * On this Wayland build the app_id is always `electron` and cannot be changed
 * from inside the process: `appendSwitch("class")`, `app.setName()`, `--class`,
 * and `--wayland-app-id` were each measured, and `hyprctl clients` reported
 * `electron` for every one. A window cannot be made to stop matching the rule,
 * so leaving it unmapped is the only guard that works.
 *
 * Inference is skipped when `app.isPackaged` is true: a packaged app is launched
 * from an executable, so a non-flag argument is a user-supplied file (a future
 * "open with SelfOS"), not a harness entry point — reading it as a verifier
 * would leave the window permanently hidden.
 */
const isVerifier =
  (isDev && process.env.SELFOS_VERIFY === "1") ||
  (isDev && isHarnessLaunch(process.argv, process.cwd(), __filename));

/** F-SHELL-05: a login item may start the app with `--hidden`. */
const startHidden = process.argv.includes("--hidden");

/**
 * A verifier must never touch the user's real data.
 *
 * Verifier mode already keeps windows unmapped so the workspace rule cannot drag
 * the user away, but nothing redirected `userData`: `just verify-*` opened the
 * real `~/.config/SelfOS/selfos.sqlite` and wrote to it. Confirmed by diffing the
 * user's backup against the live file after one `verify-salah` run — today's
 * `isha` went `late` → `on_time` and `qada_event` gained 5 rows from the
 * verifier's missed→repay→clear cycle.
 *
 * So a verifier runs against a scratch directory instead. The path is stable
 * (`~/.cache/SelfOS-verify`) rather than a fresh temp dir per run, so a verifier
 * can assert on state it wrote in an earlier step, and it is swept on boot. The
 * user's real data is then unreachable from a verification run by construction,
 * not by everyone remembering.
 *
 * `SELFOS_USERDATA` overrides it for a probe that wants a specific directory.
 * Must run before anything reads `app.getPath("userData")`.
 */
if (isVerifier) {
  const override = process.env.SELFOS_USERDATA;
  if (override) {
    app.setPath("userData", override);
  } else {
    const scratch = join(homedir(), ".cache", "SelfOS-verify");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    app.setPath("userData", scratch);
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let services: Services | null = null;
let quitting = false;
/** Set by `buildTray`; the tracking-change hook rebuilds the menu. */
let rebuildTray: (() => void) | null = null;

const WINDOW_STATE = () => join(app.getPath("userData"), "window-state.json");

interface WindowState {
  width: number;
  height: number;
  maximized: boolean;
}

function readWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(WINDOW_STATE(), "utf8")) as Partial<WindowState>;
    // A hand-edited or truncated file must not reach `new BrowserWindow` as
    // NaN: an invalid dimension throws inside the ready handler, which used to
    // leave a process with no window and no message.
    const finite = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return {
      width: Math.max(900, finite(s.width, 1280)),
      height: Math.max(600, finite(s.height, 820)),
      maximized: Boolean(s.maximized),
    };
  } catch {
    return { width: 1280, height: 820, maximized: false };
  }
}

function saveWindowState(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const size = win.getSize();
  const width = size[0] ?? 1280;
  const height = size[1] ?? 820;
  const state: WindowState = { width, height, maximized: win.isMaximized() };
  try {
    writeFileSync(WINDOW_STATE(), JSON.stringify(state));
  } catch {
    /* losing window size is not worth surfacing */
  }
}

function createWindow(): BrowserWindow {
  const state = readWindowState();
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#1e1e1e",
    title: "SelfOS",
    icon: existsSync(join(__dirname, "../../build/icon.png"))
      ? join(__dirname, "../../build/icon.png")
      : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Maximizing also maps the window; a verifier stays hidden and unmaximized.
  if (state.maximized && !isVerifier) win.maximize();

  // A verifier drives the renderer over the debugger; mapping the window would
  // steal focus and let window rules move the user's workspace. A login start
  // (`--hidden`, F-SHELL-05) also stays in the tray.
  if (isVerifier) {
    win.setSkipTaskbar(true);
  } else if (!startHidden) {
    win.once("ready-to-show", () => win.show());
  }
  win.webContents.on("render-process-gone", (_e, details) => {
    // A renderer crash must not leave a blank window; reload unless the
    // renderer is gone for a clean shutdown.
    if (!details.reason.includes("clean")) win.reload();
  });
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // No per-resize write: `before-quit` persists the size, and a synchronous
  // `writeFileSync` on every resize event ran on the process that owns the DB
  // and the IPC loop. A crash loses the last size, which is not worth the
  // main-thread stall.

  // External links leave the app; in-app navigation is denied (N-SEC-04).
  // The scheme is allowlisted because a page title or note body can reach this
  // path with attacker-influenced text, and `shell.openExternal` dispatches any
  // registered URI handler (`file:`, `smb:`, `steam:`, …) to the desktop.
  // `notes.open` in ipc/handlers.ts applies the same rule for `obsidian://`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith("http://localhost") : url.startsWith("selfos-app://");
    if (!allowed) event.preventDefault();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadURL("selfos-app://app/index.html");
  }

  return win;
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  // A verifier must never map or focus a window: that would move the user.
  if (isVerifier) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function buildTray(): Tray {
  const iconPath = join(__dirname, "../../resources/tray.png");
  const icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage
        .createFromBuffer(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64",
          ),
        )
        .resize({ width: 22, height: 22 });

  const t = new Tray(icon);
  t.setToolTip("SelfOS");

  const rebuild = () => {
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Show SelfOS", click: showWindow },
        { label: "Hide SelfOS", click: () => mainWindow?.hide() },
        { type: "separator" },
        {
          label: "Pause tracking",
          type: "checkbox",
          checked: services?.paused ?? false,
          click: (item) => {
            services?.setPaused(item.checked);
            rebuild();
          },
        },
        {
          label: "Log prayer…",
          submenu: PRAYER_IDS.map((id) => ({
            label: PRAYER_LABELS[id],
            click: () => {
              void services?.salah.log(id).catch((err: unknown) => {
                console.error("[tray] log prayer failed:", err);
              });
            },
          })),
        },
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
  };

  rebuildTray = rebuild;
  rebuild();
  t.on("click", showWindow);
  return t;
}

/**
 * F-SHELL-05: the XDG autostart entry STACK §2.5 specifies lives in
 * `./autostart` so the main process and the IPC layer share one writer.
 */

// A privileged scheme for serving book bytes to the reader. Registered before
// app readiness, and scoped to the library by the handler itself.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "selfos-book",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  // The renderer itself is served over this scheme. A `file://` origin cannot
  // fetch custom schemes at all (CORS), which broke loading pdf.js by URL.
  {
    scheme: "selfos-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/**
 * Serve a file from disk as a streamed Response.
 *
 * The whole file used to be read with `readFileSync` and returned as one
 * buffer. pdf.js asks for a byte range on every open, so a 100 MB book was
 * copied through the main process in full (F-READ-15, N-PERF-05) and the
 * `stream: true` privilege was a claim with nothing behind it. Ranges are
 * honoured now, and the body is a stream in both cases.
 */
function fileResponse(file: string, request?: Request): Response {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers = new Headers({
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
  });

  const range = request?.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const [, rawStart, rawEnd] = match;
    // `bytes=-500` is the last 500 bytes; `bytes=500-` is open-ended.
    const start = rawStart ? Number(rawStart) : Math.max(0, size - Number(rawEnd));
    const end = rawStart ? (rawEnd ? Number(rawEnd) : size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const last = Math.min(end, size - 1);
    headers.set("content-range", `bytes ${start}-${last}/${size}`);
    headers.set("content-length", String(last - start + 1));
    const body = Readable.toWeb(createReadStream(file, { start, end: last })) as ReadableStream;
    return new Response(body, { status: 206, headers });
  }

  headers.set("content-length", String(size));
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
}

function registerBookProtocol(): void {
  protocol.handle("selfos-book", async (request: Request) => {
    if (!services) return new Response("not ready", { status: 503 });
    // With a standard scheme the first segment is the host, so
    // selfos-book://book/7 exposes pathname "/7".
    const pathname = new URL(request.url).pathname.replace(/^\/+/, "");
    const id = Number(pathname.split("/").pop());
    if (!Number.isInteger(id) || id <= 0) return new Response("bad id", { status: 400 });
    const file = services.reading.store.resolveFile(id);
    // resolveFile refuses any path outside the library directory, which is the
    // path-traversal guard for this handler (STACK §6.5).
    if (!file) return new Response("not found", { status: 404 });
    return fileResponse(file, request);
  });
}

function registerAppProtocol(): void {
  protocol.handle("selfos-app", async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    const rel = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
    // Serve only from the built renderer directory (which includes pdfjs/, so
    // the worker shares this origin).
    // In a packaged build the pdf.js assets are extraResources, not inside
    // app.asar: a Worker cannot be loaded from an archive.
    const root =
      app.isPackaged && rel.startsWith("pdfjs/")
        ? join(process.resourcesPath, "pdfjs")
        : resolve(__dirname, "../renderer");
    const file = resolve(root, rel);
    // `startsWith(root)` accepts a sibling such as `../renderer-extra`; the
    // notes vault already uses resolve + relative for exactly this reason.
    if (file !== root && !isInside(root, file)) return new Response("forbidden", { status: 403 });
    if (!existsSync(file)) return new Response("not found", { status: 404 });
    return fileResponse(file, request);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    // The ready body is the only place that can fail before a window exists.
    // An unhandled rejection here left a process holding the single-instance
    // lock with no window, no tray and no message, so every later launch just
    // focused nothing and quit (F-SHELL-10).
    try {
      services = new Services(app.getPath("userData"));
      registerIpc(services);
      registerBookProtocol();
      registerAppProtocol();

      mainWindow = createWindow();
      tray = buildTray();
      // Push tracking state instead of leaving the renderer to poll for it. The
      // tray can pause tracking while the window is hidden, and F-SHELL-08 wants
      // the status strip to be current.
      services.onTrackingChange = (state) => {
        mainWindow?.webContents.send("selfos:event:collector-status", state);
        rebuildTray?.();
      };
      services.startTracking();
      services.startBackups();
      services.startReminders();
      services.startHistoryIngest();
      // Prime the salah time cache so the dashboard header shows the same Hijri
      // date the Salah module will, rather than falling back to Intl.
      void services.salah.times().catch(() => undefined);

      const stopThemeWatch = watchTheme((tokens) => {
        mainWindow?.webContents.send("selfos:event:theme-changed", tokens);
      });
      app.on("will-quit", stopThemeWatch);

      app.on("activate", showWindow);

      // G5/N-REL: a main-process exception must not leave a silent zombie.
      process.on("uncaughtException", (err) => {
        console.error("[selfos] uncaught exception:", err);
        dialog.showErrorBox("SelfOS hit an unexpected error", String(err?.stack ?? err));
      });
      process.on("unhandledRejection", (reason) => {
        console.error("[selfos] unhandled rejection:", reason);
      });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error("[selfos] startup failed:", message);
      dialog.showErrorBox("SelfOS could not start", message);
      app.exit(1);
    }
  });

  // Tray app: closing all windows must not quit (F-SHELL-04).
  app.on("window-all-closed", () => {
    /* intentionally empty */
  });

  app.on("before-quit", () => {
    quitting = true;
    saveWindowState(mainWindow);
  });

  app.on("will-quit", () => {
    services?.close();
    services = null;
    tray?.destroy();
    tray = null;
  });
}
