/**
 * Hyprland socket2 event stream client.
 *
 * SP-3 verified this stream: 45 events / 10 focus transitions in 25 s, and
 * reconnection works. Two details that matter:
 *  - `windowtitle` fires on page change without re-focus, so the current
 *    segment's title is updated in place (F-TIME-05 precision).
 *  - Hyprland 0.56 replaced string dispatchers with a Lua API; this client only
 *    *listens*, so it is unaffected — but test harnesses must use hl.dsp.*.
 */
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { parseActiveWindow, parseActiveWindowV2, parseEventLine, splitLines } from "./events";

export interface HyprlandClientOptions {
  signature?: string;
  runtimeDir?: string;
  /** Full socket path, for tests and non-standard layouts. */
  socketPath?: string;
  onFocus: (appClass: string, appTitle: string) => void;
  onTitle: (title: string) => void;
  onWorkspace: (workspaceId: string) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onEvent?: (name: string) => void;
}

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 30_000;

export class HyprlandClient {
  #opts: HyprlandClientOptions;
  #socket: Socket | null = null;
  #buffer = "";
  #backoff = BACKOFF_MIN;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  readonly socketPath: string;

  constructor(opts: HyprlandClientOptions) {
    this.#opts = opts;
    const sig = opts.signature ?? process.env.HYPRLAND_INSTANCE_SIGNATURE ?? "";
    const runtime =
      opts.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
    this.socketPath = opts.socketPath ?? join(runtime, "hypr", sig, ".socket2.sock");
  }

  /** Prime the focused-window gate after a (re)connect. */
  setFocusedAddress(address: string | null): void {
    this.#focusedAddress = address;
  }

  get connected(): boolean {
    return this.#socket !== null && !this.#socket.destroyed;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.destroy();
    this.#socket = null;
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = createConnection({ path: this.socketPath });
    this.#socket = socket;
    socket.setEncoding("utf8");

    socket.on("connect", () => {
      this.#backoff = BACKOFF_MIN;
      this.#buffer = "";
      this.#opts.onConnected();
    });

    socket.on("data", (chunk: string) => {
      const { lines, rest } = splitLines(this.#buffer, chunk);
      this.#buffer = rest;
      for (const line of lines) this.#handle(line);
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT / ECONNREFUSED both mean Hyprland is not reachable right now.
      this.#opts.onDisconnected(err.code ?? err.message);
    });

    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
      // A title event after a reconnect belongs to a window whose address is
      // unknown; drop the stale gate rather than discarding the focused
      // window's own tab changes until the next focus event.
      this.#focusedAddress = null;
      if (this.#stopped) return;
      this.#opts.onDisconnected("closed");
      const delay = this.#backoff;
      this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX);
      this.#timer = setTimeout(() => this.#connect(), delay);
    });
  }

  /** Address of the focused window, from `activewindowv2`. */
  #focusedAddress: string | null = null;

  #handle(line: string): void {
    const ev = parseEventLine(line);
    if (!ev) return;
    this.#opts.onEvent?.(ev.name);

    switch (ev.name) {
      case "activewindow": {
        const { appClass, appTitle } = parseActiveWindow(ev.data);
        this.#opts.onFocus(appClass, appTitle);
        break;
      }
      case "activewindowv2": {
        // `activewindowv2>>ADDRESS` — remember which window is focused so title
        // events from *other* windows can be ignored.
        this.#focusedAddress = parseActiveWindowV2(ev.data).address;
        break;
      }
      case "windowtitle": {
        // v1 carries only an address, so it cannot be attributed; ignoring it
        // avoids treating "0x55…" as a window title. v2 follows immediately.
        break;
      }
      case "windowtitlev2": {
        // `windowtitlev2>>ADDRESS,TITLE` — the title may contain commas.
        // Hyprland emits this for every window whose title changes, not just
        // the focused one, so a background tab would otherwise retitle the
        // focused segment.
        const comma = ev.data.indexOf(",");
        const address = comma >= 0 ? ev.data.slice(0, comma) : "";
        const title = comma >= 0 ? ev.data.slice(comma + 1) : ev.data;
        if (this.#focusedAddress && address && address !== this.#focusedAddress) break;
        this.#opts.onTitle(title);
        break;
      }
      case "workspace":
      case "workspacev2": {
        const id = ev.data.split(",")[0] ?? "";
        this.#opts.onWorkspace(id);
        break;
      }
      default:
        break;
    }
  }
}
