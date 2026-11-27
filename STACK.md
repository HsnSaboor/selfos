# SelfOS — Stack & Architecture Decision Record

**Status:** Draft v0.2 · **Date:** 2026-11-02 · **Owner:** saboor
**Companion document:** [`PRD.md`](./PRD.md) — product requirements, user stories, and acceptance criteria. Every choice below is justified by a requirement ID from that document.

> This file is the *how*. If a requirement changes, the affected section here changes with it. The traceability matrix in §14 maps every functional requirement group to the section that implements it.

> **v0.2 change:** the desktop framework is **Electron 45**, not Electrobun. The reason is recorded in §2.1 so it is not re-litigated: the reader requires a pinned Chromium engine, and bundling Chromium removed the framework's main advantage. The rejected options and their measured trade-offs are kept in §2.7.

---

## 0. Summary of locked decisions

| # | Decision | Choice | PRD driver |
|---|---|---|---|
| 1 | Desktop framework | **Electron 45.x** (exact version pinned) | Whole product |
| 2 | Main-process runtime | **Node 24** (bundled with Electron 45) + TypeScript | F-TIME-01, N-PERF-04 |
| 3 | UI framework | **React 19 + TypeScript + Vite** | All UI requirements |
| 4 | Renderer | **Bundled Chromium 156** (Electron's own) | F-READ-03, F-READ-15 |
| 5 | Database | **SQLite via `node:sqlite`**, WAL | D-01…D-10 |
| 6 | Time collection | **Hyprland IPC `socket2`** | F-TIME-01…03 |
| 7 | Site collection | **Chromium history, snapshot-first read**, window-title fallback; time is an interval union, never a sum | F-TIME-04, F-TIME-05 |
| 8 | PDF engine | **pdf.js** from the app origin (worker needs same-origin), custom display layer | F-READ-03…09 |
| 9 | Notes | **Obsidian vault, read-only + explicit writes** | F-NOTES-01…10 |
| 10 | Salah | **Read the existing `salah-ctl` status**, log outcomes locally | F-SALAH-01…12 |
| 11 | Theming | **Omarchy `colors.toml` → CSS variables** | F-SET-08, N-UX-03 |
| 12 | Packaging | **electron-builder** (AppImage + deb), XDG autostart entry, tray | F-SHELL-03…05 |

**Decisions deliberately *not* taken:** no Tauri (no Chromium on Linux), no Electrobun (see §2.1), no server, no ORM, no state-sync layer, no cloud, no AI. Each rejection is recorded in §2.7 so the reasoning survives.

---

## 1. Constraints established from the actual machine

These are measured, not assumed. They constrain everything below. **`C-n` IDs are local to this document** and are distinct from the PRD's `C-n` constraint IDs; cite them as "STACK C-n".

| ID | Evidence | Command / source | Consequence |
|---|---|---|---|
| C-1 | Hyprland 0.56.2, Wayland; `.socket2.sock` present | `hyprctl version`; `ls /run/user/1000/hypr/<sig>/` | No X11 window APIs. Collector must use Hyprland IPC. |
| C-2 | Omarchy theme tokens at `~/.local/state/omarchy/current/theme/colors.toml` | read of the file: `mode`, `accent`, `background`, `foreground`, `muted`, ANSI palette | Theme adapter reads TOML, not a hand-maintained palette |
| C-3 | `gtk3 1:3.24.52`, `webkit2gtk-4.1 2.52.6`, `libayatana-appindicator3`, `librsvg-2.62` present | `pacman -Q`; `ldconfig -p` | Tray and GTK integration work on this machine |
| C-4 | 433 MB Helium history with a live rollback journal; ~2 GB RAM available; 25 GB disk free | `ls -la …/History`; `free -h`; `df -h`; SP-1 | The DB cannot be opened non-immutably. Snapshot-copy for consistency, bounded and never on a timer (§5.3). |
| C-5 | Helium `visits.visit_duration` populated with real values (e.g. 31 941 337 µs) | `sqlite3 'file:…?immutable=1' 'SELECT … visit_duration …'` | Site time is available without an extension |
| C-6 | Helium supports Chromium extensions | <https://helium.computer> | A future extension is viable; not needed for v1 |
| C-7 | Existing salah stack: Python CLI + daemon + Quickshell widget, **no prayer log** | read of `~/.local/bin/salah-ctl`, `salah-daemon` | Integrate for times/alarms; add the missing logging |
| C-8 | Obsidian installed; config references vault path `/home/saboor/saboor` which **does not currently exist** | `cat ~/.config/obsidian/obsidian.json`; `stat` | Vault path must be user-configurable and validated at runtime |
| C-9 | `node:sqlite` is **Stability 1.2 — release candidate** in Node 24/26 | <https://nodejs.org/api/sqlite.html> | Acceptable, but see §4.1 for the fallback and the isolation rule |
| C-10 | Electron 45 ships Chromium 156 / Node 24.22 / V8 15.6 | <https://releases.electronjs.org/release/v45.0.0> | Reader renders in the engine we chose; Node 24 provides `node:sqlite` |
| C-11 | Electron 45 removed Node shims (`events`, `timers`, `url`) and `Buffer` from **sandboxed preload scripts** | <https://www.electronjs.org/docs/latest/breaking-changes> | Preload must use `contextBridge` + Web APIs only; no Buffer in preload |
| C-12 | `setLoginItemSettings` has no Linux implementation | <https://github.com/electron/electron/issues/15198> | Autostart is an XDG `~/.config/autostart/*.desktop` file we write ourselves |
| C-13 | Wayland clients cannot position their own windows | Wayland protocol; Electron ozone behaviour | F-SHELL-07 persists size only; placement via Hyprland window rules |

---

## 2. Framework: Electron 45

### 2.1 Why Electron (and why not the alternatives)

The decision is driven by **one requirement**: the reader must render PDFs in a pinned Chromium engine (PRD F-READ-03/F-READ-15, decision #4). That requirement eliminates the main alternative and, once accepted, removes the reason to prefer a smaller framework.

| Requirement | Electron 45 | Tauri v2 | Electrobun 2.0.x |
|---|---|---|---|
| Chromium renderer on Linux | **Yes** (bundled) | **No** — `wry` on Linux is WebKitGTK only; no CEF backend feature | Yes, via optional bundled CEF |
| Maturity | v45.2.1; 3 majors supported; 8-week cadence | v2.12.5; mature | v2.0.x; weekly betas |
| Main-process SQLite | `node:sqlite` (RC) or `better-sqlite3` | `rusqlite` (Rust) | `bun:sqlite` (fastest) |
| Language surface | TypeScript only | Rust **+** TypeScript | TypeScript only |
| Install footprint | ~100–200 MB | ~10 MB | ~20 MB core + ~174 MB CEF |
| Ecosystem / troubleshooting | Very large | Large | Small |
| Risk of abandonment | Low | Low | Medium |

**The pivotal fact:** Electrobun's headline advantage is *not bundling Chromium*. We decided to bundle it anyway, so the size advantage largely disappears while its maturity disadvantage remains. That inverts the original recommendation.

**Tauri is rejected on rendering, not size.** `wry 0.57.1`'s Linux features are `webkit2gtk`, `javascriptcore-rs`, `soup3`, `x11`, `gdkx11` — there is no Chromium option. Tauri users report 40 fps and wasm/rendering problems on WebKitGTK (<https://github.com/orgs/tauri-apps/discussions/8524>). A canvas- and text-layer-heavy PDF reader is the worst possible workload for that engine.

### 2.2 Version pinning

- Pin the **exact** Electron version in `package.json` (`"electron": "45.2.1"`, no caret). Electron supports only the latest three majors; an 8-week cadence means a deliberate upgrade every ~6 months.
- Upgrade procedure: read the breaking-changes page for each intervening major, run the app's smoke checklist (§12.5), then bump.
- When packaging is added, pin `electron-builder` exactly; packaging behaviour changes between minors.

### 2.3 Process model

Three contexts, each with a narrow job:

| Process | Runs | Owns | Must not |
|---|---|---|---|
| **Main** | Node 24 | DB, collectors, IPC handlers, tray, windows, scheduler | Touch the DOM |
| **Preload** | Sandboxed | `contextBridge` API surface only | Use Node modules, `Buffer`, or `require` beyond `electron` (C-11) |
| **Renderer** | Chromium 156 | React UI | Touch the filesystem, `child_process`, or the DB |

Window security settings (non-negotiable):

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: path.join(__dirname, "preload.js"),
  },
});
```

- `sandbox: true` is the default since Electron 20 and **must stay on**. Preload therefore uses only `contextBridge` and Web APIs (C-11).
- IPC is a **typed, validated channel set**, not a generic `ipcRenderer.invoke(anything)` passthrough. Every handler validates with hand-written guards (N-SEC-04).
- `will-navigate` and `setWindowOpenHandler` deny all remote navigation in app windows; external links go to the system browser via `shell.openExternal`.

### 2.4 Renderer

- Chromium 156 from Electron itself — no separate CEF artifact, no renderer configuration, no build flag. This is the practical benefit of the switch: the renderer decision disappears from the build entirely.
- GPU acceleration is on by default; verify with `chrome://gpu` in the packaged build (Spike SP-2).
- Hardware video decode: verify for the local-media case (F-TIME-06); Electron's bundled Chromium may lack proprietary codecs depending on the build. **Spike SP-9** measures this.

### 2.5 Tray, lifecycle, and autostart

- **Tray** (`Tray` + `Menu`): Show/Hide · Pause tracking · Log prayer… · Quit. Requires `libayatana-appindicator3` (present, C-3) on Linux.
- **Close hides:** intercept `close` and `event.preventDefault(); win.hide()` unless a `quitting` flag is set (F-SHELL-04). `app.on('window-all-closed')` must **not** quit.
- **Autostart:** `setLoginItemSettings` is a no-op on Linux (C-12). Write `~/.config/autostart/selfos.desktop` ourselves, with `X-GNOME-Autostart-enabled=true` and `--hidden` so it starts in the tray (F-SHELL-05). Removal deletes the file; it is listed in the health page.
- **Single instance:** `app.requestSingleInstanceLock()`; a second launch focuses the existing window (F-SHELL-10). This is simpler and more reliable than the socket approach used in the previous draft.
- **Window state:** persist size and maximized flag; do **not** persist position on Wayland (C-13). Provide a Hyprland window rule snippet in settings for placement.

### 2.6 Sleep, lock, and idle

Electron's `powerMonitor` is the native signal, but its platform coverage is uneven:

| Signal | Availability | Use |
|---|---|---|
| `powerMonitor.on('suspend'/'resume')` | All platforms | Close the open segment on suspend; reconcile on resume |
| `powerMonitor.on('shutdown')` | Linux, macOS | Flush the open segment before exit |
| `powerMonitor.on('lock-screen'/'unlock-screen')` | **macOS, Windows only** | Not used on Linux |
| `powerMonitor.getSystemIdleState(threshold)` | All; `locked` only where supported | Primary idle signal on Linux |
| `loginctl show-session … -p LockedHint -p IdleHint` | Linux | **Fallback/authority on Wayland** (verified keys exist) |

Design: poll `loginctl` every 5 s as the Linux authority and use `powerMonitor` suspend/resume/shutdown as immediate events. DPMS-off comes from `hyprctl -j monitors` → `dpmsStatus`. When locked, idle, or DPMS-off, close the segment and record a gap (F-TIME-02).

### 2.7 Rejected alternatives (and why)

| Alternative | Rejected because |
|---|---|
| **Tauri v2** | No Chromium on Linux; WebKitGTK breaks the reader requirement and the PDF workload is the worst case for it. Also forces Rust for all collectors/DB code. |
| **Electrobun 2.0.x** | Young framework with weekly betas and a new build CLI; its main advantage (no bundled browser) was already given up by choosing CEF. Kept as the documented fallback (§2.8). |
| Electron + system WebKitGTK | Not a real option; Electron always bundles Chromium |
| Web app + local server | Loses tray, autostart, and native windows; contradicts "native desktop" |
| Electrobun UI / GPU JSX renderer | macOS-only; cannot ship on Linux (applied to the previous draft, noted for completeness) |

### 2.8 Documented fallback: Electrobun 2.0.x

If Electron proves unworkable (most likely on memory, risk S1), the migration target is Electrobun 2.0.x with bundled CEF, which was fully designed in v0.1 of this document. The portable surface is ~85% of the code: React UI, SQL schema, pure functions, pdf.js reader, and collector logic. The non-portable surface is exactly this section — window/tray creation, IPC transport, autostart, and packaging. **Do not build an abstraction over this layer in advance**; the switch is a one-time cost, and a speculative abstraction would cost more than it saves.

---

## 3. UI layer

### 3.1 Framework and build

- **React 19 + TypeScript**, bundled by **Vite** (`electron-vite` for the three-context build, or Vite + a small main-process esbuild step).
- Two development loops:
  - Renderer: Vite HMR — the window stays open and state is preserved.
  - Main/preload: rebuild and restart the app (no in-process reload for main).
- **Hand-written CSS** with `:root` custom properties (no Tailwind), with **CSS custom properties** for all colors (theme-driven, §8).

### 3.2 Libraries

| Concern | Library | Rationale |
|---|---|---|
| Data fetching from IPC | `@tanstack/react-query` *(target, not installed)* | Caching, invalidation, stale-while-revalidate; dashboard must not block on collectors (F-DASH-10) |
| Virtualized lists | `@tanstack/react-virtual` *(target, not installed)* | Library and annotation lists of thousands of rows (N-PERF-06) |
| Charts (as built) | hand-rolled SVG/CSS | No chart library installed; the target was `uPlot` |
| Rings, heatmaps, timelines | Hand-rolled SVG + `d3-scale` | Exact control over the 24 h band and calendar heatmaps; no heavyweight chart runtime |
| PDF | `pdfjs-dist` + `react-pdf-highlighter` | Text layer + highlight/annotation model already built on pdf.js (F-READ-07…09) |
| Markdown preview (target) | `react-markdown` + `remark-gfm` + `rehype-sanitize` | Not installed: a hand-rolled tokenizer ships, pending dependency approval |
| Icons (target) | `lucide-react` | Not installed; text/emoji only |
| Command palette (target) | `cmdk` | Not installed; hand-rolled palette ships |
| Dates (as built) | `shared/dates.ts` | Day bucketing and DST safety (D-04) |
| Validation (as built) | Hand-written guards (`isOneOf`, `requireId`, `requireRange`, `requireDateKey`, `dayCount`) | No schema library is load-bearing: every guard throws a plain `Error` whose message the renderer shows verbatim |
| TOML | Hand-rolled flat reader (`parseFlatToml`) | The theme files are flat `key = "value"`; no dependency is needed (and `Bun.TOML` is unavailable under Node) |
| Lint/format | **Biome 2.6 (Rust)** | One native binary for lint + format, ~100 ms on this repo; replaces ESLint + Prettier |
| Task runner | **`just` (Rust)** | Recipes in a `justfile`; keeps the project's commands out of a JS task-runner layer |
| Package manager | **Bun 1.4.2** | Faster installs and native TS execution; `bun.lock` is the lockfile |
| Tests | `vitest` (run under Bun) + *(target only; not installed)* | Components and pure logic without a browser |

**No global state library.** Server state is React Query; UI state is local + a small context.

### 3.3 Layout and navigation

- Persistent sidebar (module list), main content, status strip (F-SHELL-08).
- Route state is a typed discriminated union, not a router dependency; deep-linkable within the app (e.g. `reading/book/:id`).
- Minimum supported viewport 1280×720; the dashboard reflows to a single column below 1100 px.
- Custom titlebar (`titleBarStyle: 'hidden'` is macOS-only; on Linux use `frame: false` + `-webkit-app-region: drag` regions) with the window controls drawn in React. This is a known Wayland-fragile area — **Spike SP-10** validates it before committing.

### 3.4 Security boundary

- The renderer never receives filesystem or process APIs. `contextBridge` exposes a **closed list** of typed methods, each mapped to one validated main-process handler.
- PDF bytes are served through a **custom privileged protocol** (`selfos-book://book/<id>`) registered with `protocol.handle`, scoped to the library directory. The app shell and its pdf.js assets are served from a second privileged scheme, `selfos-app://app/…`, so the page and the worker share one origin. No `file://` access from the renderer.
- Navigation rules deny all remote navigation in app views; external links open in the system browser.
- CSP as a meta tag in `index.html`: `default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' selfos-book:; img-src 'self' data: selfos-book:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'`.

---

## 4. Data layer

### 4.1 Engine: `node:sqlite`

Verified API surface from the Node docs: `DatabaseSync` (the class name in Node 22/24, which Electron 45 ships; Node 26 introduces `Database` and keeps `DatabaseSync` as a deprecated alias), constructor options `readOnly` and `enableForeignKeyConstraints`, prepared statements with `setReadBigInts()` and `setReturnArrays()`.

**Honest caveat:** `node:sqlite` is **Stability 1.2 — release candidate** (C-9). It is not behind a flag, but its API can still change. Mitigation:

1. **All SQLite access goes through one module** (`src/main/db/driver.ts`) exposing the handful of calls we use. Nothing else imports `node:sqlite`.
2. That module is the **only** place a swap to `better-sqlite3` (prebuilt binaries, mature) would be needed. Estimate: half a day.
3. Spike SP-1 measures whether `node:sqlite` handles the 454 MB read-only history DB and WAL concurrency acceptably.

Connection policy:

```ts
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
`);
```

- **WAL** because the app process and the collector process both access the DB; WAL permits concurrent readers with one writer (N-REL-01).
- `busy_timeout` absorbs writer contention; all writes are short transactions (D-02).
- **No ORM.** Hand-written SQL with typed row interfaces; queries live beside the module that owns them.
- **No `db.transaction()` helper** (SP-1): use explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
- `DatabaseSync` is synchronous. In the main process, run heavy ingest in a **worker thread** so the UI IPC loop stays responsive (N-PERF-04).

### 4.2 Physical schema (v1)

Conventions: all instants are **UTC epoch milliseconds** (`*_at`); every day-bucketed table also stores a **`local_date`** `TEXT` (`YYYY-MM-DD`) computed in the user's timezone at write time (D-04). All ids are `INTEGER PRIMARY KEY`. All raw tables are append-only (D-02).

```sql
-- meta / migrations
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- meta.schema_version = '1'

-- ── Time ──────────────────────────────────────────────
CREATE TABLE focus_event (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,          -- UTC ms
  ended_at     INTEGER NOT NULL,
  local_date   TEXT    NOT NULL,
  app_class    TEXT    NOT NULL,          -- Hyprland 'class'
  app_title    TEXT,
  workspace_id TEXT,
  monitor_id   INTEGER,
  source       TEXT    NOT NULL,          -- 'hypr-ipc' | 'hyprctl-reconcile' | 'title-site-change'
  session_id   TEXT,                      -- login session
  created_at   INTEGER NOT NULL
);
CREATE INDEX focus_event_day  ON focus_event(local_date);
CREATE INDEX focus_event_time ON focus_event(started_at);

CREATE TABLE browser_profile (
  id            INTEGER PRIMARY KEY,
  browser       TEXT NOT NULL,            -- 'helium'
  profile_dir   TEXT NOT NULL UNIQUE,     -- 'Default', 'Profile 2'
  history_path  TEXT NOT NULL,
  watermark_us  TEXT NOT NULL DEFAULT '0', -- max visits.visit_time ingested (Chrome µs, 1601)
  last_ingest_at INTEGER
);

CREATE TABLE browser_visit (
  id             INTEGER PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES browser_profile(id),
  url            TEXT NOT NULL,
  title          TEXT,
  domain         TEXT NOT NULL,
  visit_time_us  TEXT NOT NULL,        -- Chromium µs since 1601 (both sources)
  visit_at       INTEGER NOT NULL,        -- UTC ms, converted
  local_date     TEXT NOT NULL,
  duration_us    INTEGER NOT NULL DEFAULT 0,
  transition     INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'history', -- 'history' | 'window-title'
  ingest_run_id  INTEGER,
  UNIQUE(profile_id, url, visit_time_us)  -- idempotent ingest (F-TIME-13)
);
CREATE INDEX browser_visit_day ON browser_visit(local_date);

CREATE TABLE domain_rule (
  domain        TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  is_distracting INTEGER NOT NULL DEFAULT 0,
  is_media      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE ingest_run (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES browser_profile(id),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_new     INTEGER NOT NULL DEFAULT 0,
  strategy     TEXT,
  error        TEXT
);

-- ── Reading ───────────────────────────────────────────
CREATE TABLE book (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  author     TEXT,
  file_path  TEXT NOT NULL,               -- managed library path
  source_path TEXT,                       -- original import location
  sha256     TEXT NOT NULL UNIQUE,
  page_count INTEGER NOT NULL,
  settings_json TEXT,                     -- per-book display overrides (§6.2)
  added_at   INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE reading_position (
  book_id       INTEGER PRIMARY KEY REFERENCES book(id),
  page          INTEGER NOT NULL,
  scroll_offset REAL NOT NULL DEFAULT 0,  -- 0..1 within page
  zoom          REAL NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE reading_session (
  id             INTEGER PRIMARY KEY,
  book_id        INTEGER NOT NULL REFERENCES book(id),
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER NOT NULL,
  local_date     TEXT NOT NULL,
  pages_turned   INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL
);
CREATE INDEX reading_session_day ON reading_session(local_date);

CREATE TABLE highlight (
  id            INTEGER PRIMARY KEY,
  book_id       INTEGER NOT NULL REFERENCES book(id),
  page          INTEGER NOT NULL,
  color         TEXT NOT NULL,
  text          TEXT NOT NULL,
  rects_json    TEXT NOT NULL,            -- normalized rects (0..1 of the viewport)
  rotation      INTEGER NOT NULL DEFAULT 0, -- rotation the anchor was captured at (SP-5)
  anchor_version INTEGER NOT NULL,        -- D-06 / C-5
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX highlight_book ON highlight(book_id, page);

CREATE TABLE highlight_note (
  highlight_id INTEGER PRIMARY KEY REFERENCES highlight(id),
  body         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ── Habits ────────────────────────────────────────────
CREATE TABLE habit (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- boolean|count|duration|avoid
  unit        TEXT,
  target      REAL,                       -- per-period target
  icon        TEXT,
  color       TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE habit_schedule (             -- versioned (D-08 / C-6)
  id             INTEGER PRIMARY KEY,
  habit_id       INTEGER NOT NULL REFERENCES habit(id),
  effective_from TEXT NOT NULL,           -- local_date
  kind           TEXT NOT NULL,           -- daily|weekdays|times_per_week|times_per_month
  weekdays       TEXT,                    -- '1,3,5' ISO
  times_per_period INTEGER,
  created_at     INTEGER NOT NULL,
  UNIQUE(habit_id, effective_from)
);

CREATE TABLE habit_entry (
  id          INTEGER PRIMARY KEY,
  habit_id    INTEGER NOT NULL REFERENCES habit(id),
  local_date  TEXT NOT NULL,
  value       REAL NOT NULL DEFAULT 0,    -- count/duration; 1 for boolean
  status      TEXT NOT NULL,              -- done|partial|skipped|slipped|clean
  note        TEXT,
  source      TEXT NOT NULL DEFAULT 'manual', -- manual|linked:reading|linked:salah
  created_at  INTEGER NOT NULL,
  UNIQUE(habit_id, local_date)
);

-- ── Salah ─────────────────────────────────────────────
CREATE TABLE prayer_log (
  id          INTEGER PRIMARY KEY,
  local_date  TEXT NOT NULL,
  prayer      TEXT NOT NULL,              -- fajr|dhuhr|asr|maghrib|isha
  status      TEXT NOT NULL,              -- on_time|late|missed|excused
  jamaah      INTEGER NOT NULL DEFAULT 0,
  masjid      TEXT,
  prayer_time TEXT NOT NULL,              -- 'HH:MM' computed at the time
  logged_at   INTEGER NOT NULL,
  UNIQUE(local_date, prayer)              -- idempotent (F-SALAH-04)
);

CREATE TABLE qada_event (
  id         INTEGER PRIMARY KEY,
  prayer     TEXT NOT NULL,
  delta      INTEGER NOT NULL,            -- +1 debt (missed), -1 repaid
  local_date TEXT NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE fasting_log (
  local_date TEXT PRIMARY KEY,
  fasted     INTEGER NOT NULL,
  tarawih    INTEGER NOT NULL DEFAULT 0,
  note       TEXT
);

-- ── Goals ─────────────────────────────────────────────
CREATE TABLE goal (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL,             -- numeric|milestone|quota
  target_value REAL,
  unit         TEXT,
  start_date   TEXT NOT NULL,
  target_date  TEXT,
  status       TEXT NOT NULL DEFAULT 'active', -- active|completed|abandoned
  parent_id    INTEGER REFERENCES goal(id), -- 0002
  close_reason TEXT,                          -- 0002
  source       TEXT,                      -- manual|reading.pages|time.focus|salah.all
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);

CREATE TABLE goal_progress (
  id       INTEGER PRIMARY KEY,
  goal_id  INTEGER NOT NULL REFERENCES goal(id),
  at       INTEGER NOT NULL,
  value    REAL NOT NULL,
  source   TEXT NOT NULL,
  note     TEXT
);

CREATE TABLE goal_milestone (
  id        INTEGER PRIMARY KEY,
  goal_id   INTEGER NOT NULL REFERENCES goal(id),
  title     TEXT NOT NULL,
  due_date  TEXT,
  done_at   INTEGER,
  sort      INTEGER NOT NULL DEFAULT 0
);

-- ── Cross-module links ────────────────────────────────
CREATE TABLE note_link (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,              -- book|habit|goal|prayer_day
  entity_id   INTEGER NOT NULL,
  note_path   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(entity_type, entity_id, note_path)
);

-- ── Derived caches (rebuildable, D-03) ────────────────
CREATE TABLE day_aggregate (
  local_date      TEXT PRIMARY KEY,
  screen_seconds  INTEGER NOT NULL DEFAULT 0,
  focused_seconds INTEGER NOT NULL DEFAULT 0,
  media_seconds   INTEGER NOT NULL DEFAULT 0,
  reading_seconds INTEGER NOT NULL DEFAULT 0,
  switches        INTEGER NOT NULL DEFAULT 0,
  first_activity  INTEGER,
  last_activity   INTEGER,
  focus_sessions  INTEGER NOT NULL DEFAULT 0,   -- 0003
  longest_focus_seconds INTEGER NOT NULL DEFAULT 0, -- 0003
  rebuilt_at      INTEGER NOT NULL
);
```

### 4.3 Migrations

- Numbered, forward-only SQL files under `src/main/db/migrations/NNNN_name.sql`.
- Applied inside a transaction; `PRAGMA user_version` tracks the current level; `meta.schema_version` mirrors it for export manifests.
- **Backup before migrating** (`VACUUM INTO`) — N-REL-03.
- No down-migrations. Rollback is restore-from-backup, documented on the health page.

### 4.4 Derived data

- Streaks, totals, and goal progress are computed by pure functions from raw rows; `day_aggregate` is the only cache and is rebuildable via a health-page action (D-03, F-SET-07).
- Aggregation runs incrementally: the collector recomputes the affected `local_date` rows after each ingest/close, so the dashboard never scans raw tables (N-PERF-06).
- `VACUUM INTO '<backup>'` for consistent hot backups (F-SET-04).
- Constants that decide the numbers: `SWITCH_NOISE_MS = 15_000` (segments shorter than this are screen time but not focused time), `FOCUS_SESSION_MIN_MS = 300_000` (a contiguous same-app run must reach five minutes to count as a focus session, F-TIME-08), and `MEDIA_CLASSES = /^(mpv|vlc|celluloid|haruna|smplayer)$/i` (an unlisted player counts as focused, never media).

### 4.5 Backup and export

| Action | Mechanism | Frequency |
|---|---|---|
| Automatic backup | `VACUUM INTO` into `backups/selfos-YYYY-MM-DD.sqlite` (weekly copy on Sundays) | on startup if today's is missing, then every 6 h |
| Retention | 14 daily + 8 weekly; **manual backups are never pruned** | on backup |
| Full export | JSON of every user table, to `<userData>/exports/selfos-YYYY-MM-DD.json` | manual (F-SET-03) |
| CSV export | One table, optional date range, header row, RFC-4180 quoting | manual |
| Restore | Copy aside the live DB, drop `-wal`/`-shm`, copy the backup in; restart required | manual |
| Import | Not implemented (F-SET-05 is SHOULD); restore covers the same need | — |

Export destinations are chosen in the main process, never by the renderer, so a
compromised renderer cannot overwrite arbitrary files.

---

## 5. Collectors

### 5.1 Process topology

```
systemd --user  (or Electron main for v1 — see below)
 ├── selfos-app          (Electron main) → DB reads/writes, UI, tray
 └── selfos-collector    (Node)          → focus_event, browser_visit, day_aggregate
```

**Why a separate collector process (target, not shipped):** the intent is that tracking survives closing the window (F-SHELL-04) and restarts independently of a UI crash (F-TIME-11, N-REL-04). The collector is a class inside the main process today, so a main-process crash stops tracking until relaunch; moving it to a `utilityProcess`/systemd unit is the remaining work. Both processes would open the DB with WAL and short write transactions.

**v1 simplification:** the collector may run as a `utilityProcess` (Electron's Node child) supervised by the main process, with the systemd unit as the supervisor for the whole app. This keeps one install artifact and one log stream; the collector module itself stays process-agnostic so it can be split into its own unit later.

Supervision: `Restart=always`, `RestartSec=2`, `After=graphical-session.target`. Installed explicitly by `ops/install.sh`, never silently (PRD §8).

### 5.2 Active-window collector (Hyprland IPC)

**Transport:** connect to `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock` with `net.createConnection({ path })`. Events arrive as `event>>data\n`.

Subscribed events (all verified live in SP-3 — 45 events, 10 focus transitions, reconnect confirmed):

| Event | Use |
|---|---|
| `activewindow>>CLASS,TITLE` | Open/close a focus segment |
| `activewindowv2>>ADDRESS` | Prime the focused-window gate; also the fallback when the title is empty |
| **`windowtitle>>ADDRESS` / `windowtitlev2>>ADDRESS,TITLE`** | **Page change within the same focused window** — fires on browser tab/title change without re-focusing (SP-3). A change of inferred *site* closes and reopens the segment; a same-site change retitles it |
| `workspace>>…` / `workspacev2>>…` | Attribute context; detect workspace switches |
| `openwindow`, `closewindow`, `focusedmon`, `movewindow`, `activelayout`, `monitoradded`, `monitorremoved` | **Received and counted only** (`eventCounts` in the health page); no behaviour depends on them today |

**Hyprland 0.56 dispatch change:** `hyprctl dispatch <name> <args>` no longer works — 0.56 replaced it with a Lua API. The collector does **not** dispatch, but any test harness or automation must use `hl.dispatch(hl.dsp.*)` (e.g. `hl.dispatch(hl.dsp.window.bring_to_top({class="helium"}))`). Real events come from launching windows or switching focus; a no-op dispatch produces none.

Algorithm:

1. On connect, reconcile with `hyprctl -j activewindow` (one-shot) and start a segment.
2. On each focus event, **close** the previous segment (`ended_at = now`) and **open** a new one.
3. Flush open segments every 10 s so a crash loses at most 10 s (N-REL-01).
4. Merge segments shorter than 1 s with the neighbor to avoid event-storm noise.
5. On socket error, reconnect with exponential backoff (0.5 s → 30 s), and insert an explicit **gap** rather than extending the last segment (F-TIME-11, D-02).

**Idle / lock detection** (F-TIME-02): see §2.6 — `loginctl` every 5 s is the Linux authority; `powerMonitor` provides immediate suspend/resume/shutdown.

**Pause:** an in-memory flag set through `system.pauseTracking` (tray or UI); the collector closes the open segment and writes no rows while paused. A restart does not preserve it.

### 5.3 Browser history ingest

**Source:** `~/.config/net.imput.helium/Default/History` and `…/Profile 2/History` (discovered, §1 C-4/C-5). The two profile names are defined once (`BROWSER_PROFILES` in `services/context.ts`) and consumed by both ingest and the health page; making the list user-editable is F-SET-01, not done here.

**Read strategy — snapshot-first (revised after SP-1, see `spikes/RESULTS.md`):**

SP-1 established that Helium keeps a rollback journal (`journal_mode=delete`) open, so **every** non-immutable open — read-only or not — fails with `database is locked` even with `busy_timeout`. The original "read-only, never copy" design does not work. The measured options are:

| Strategy | Result | Use |
|---|---|---|
| `readOnly: true` | `database is locked` (fails in 0.67 ms, and after 5 s of retries) | never |
| default open | `database is locked` | never |
| `file:…?immutable=1` | **works, 1.55 ms**, but ignores post-open writes | **not used**: it can read a torn B-tree if a writer starts after the check |
| copy then read | works, 3.3 s for 433 MB | **fallback**, on a bounded schedule |

Algorithm:

1. Check for `History-journal` next to the DB.
2. **Any existing file** → copy DB + sidecars to a bounded snapshot and open the copy read-write so SQLite recovers.
3. **Journal present (or a live writer possible)** → copy the DB **and its `-journal`/`-wal`/`-shm`** to `<userData>/snapshots/hist-<sha1>.sqlite`, open the copy read-write so SQLite recovers the hot journal, read it, then delete it. The copy is allowed **only** for this consistency purpose and is never retained. An immutable open is not used: it ignores a journal and can read a torn B-tree.
4. Copying is **never** on a short timer against a 433 MB file. It runs at most every four hours (≈6 times a day), in the worker thread, with a hard-coded 800 MB ceiling (`MAX_SNAPSHOT_BYTES`); an abort is reported on the Sites page, not the health page.
5. Read only rows above `watermark_us`:
   ```sql
   SELECT u.url, u.title, v.visit_time, v.visit_duration, v.transition
   FROM visits v JOIN urls u ON u.id = v.url
   WHERE v.visit_time > ?
   ORDER BY v.visit_time
   LIMIT 5000;
   ```
   The first run backfills at most `BACKFILL_DAYS = 90` days, and one run drains at most `MAX_PAGES_PER_RUN = 10` pages (50 000 rows). A page that returns fewer than 5 000 rows ends the drain. Reload visits are **kept** (Chromium gives the reload its own interval); the insert upserts `duration_us = MAX(existing, new)` so a visit first seen while still open is refreshed on a later pass.
6. Insert in batches of 500 inside **explicit** `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` — `node:sqlite` has **no `db.transaction()` helper** (SP-1). `UNIQUE(profile_id, url, visit_time_us)` makes re-runs idempotent (F-TIME-13).
7. Advance `watermark_us` only after the transaction commits (N-REL-01).
8. Run ingest in a **worker thread**, not on the main IPC loop (N-PERF-04).

WAL was verified under contention: 3 OS processes × 400 transactions → 1 200/1 200 committed, 0 busy errors, `integrity_check: ok` in 297 ms. Two-process access is safe.

**Timestamp conversion — the precision trap:**

```ts
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const chromeToMs = (us: bigint) => Number(us / 1000n) - CHROME_EPOCH_OFFSET_MS;
```

A real `visit_time` observed on this machine is `13_438_067_778_302_716`, which is **1.34 × 10¹⁶** — larger than JavaScript's `Number.MAX_SAFE_INTEGER` (9.007 × 10¹⁵). Read as a plain `number`, low-order digits are silently lost, so two visits in the same millisecond can collide and the unique key becomes unreliable. Therefore call `statement.setReadBigInts(true)` on the ingest statement so `visit_time` arrives as a `bigint`, and keep it a `bigint` into the insert. This gets a dedicated test.

**Media classification** (F-TIME-06): `MEDIA_RULES` marks `youtube.com/watch`, `/shorts/`, `netflix.com/watch`, `twitch.tv/*`, `vimeo.com/*`, etc. as media, and a `domain_rule.is_media` set by the user is honoured for both history and window-title rows. The title is stored for the per-title breakdown.

**Fallback when history is unavailable** (F-TIME-05): parse the focused window title. The parser:
1. strips a trailing browser suffix (` - Helium`);
2. tries the last ` - ` / ` | ` segment and then the whole title;
3. maps the candidate through `SUFFIX_SITES`, then falls back to the hostname with an extension denylist (`.md`, `.exe`, …);
4. maps the focused window's `app_class` (`helium`) to the browser and attributes **focused seconds** to that site.

Every row carries `source` (`history` vs `window-title`) so the UI can show provenance (D-05, F-TIME-05).

### 5.4 Salah bridge

- **Read:** invoke `~/.local/bin/salah-ctl status` (JSON) cached for 60 s, refreshed on demand and on demand. Validate with hand-written guards; on failure, fall back to local computation.
- **Fallback compute:** `adhan` npm package configured as **Karachi (18°/18°), Hanafi Asr** to match the existing config (`~/.config/omarchy/salah.json`). Same method, no drift.
- **Never** write `/tmp/salah_playing.json` and never start adhan audio (F-SALAH-09).
- **Optional config bridge:** read `salah.json`; write only if a round-trip diff is empty (i.e. every unknown field is preserved). Otherwise the settings page is read-only and says why (F-SALAH-10).
- **Logging** is SelfOS-owned (`prayer_log`), independent of the external stack.

### 5.5 Scheduler

- Reminders (habits, prayer logging prompts) run in the main process with a 30 s tick and fire **at most once per slot per day**, tracked in memory.
- Reminders/notifications (F-HABIT-11) are implemented: a 30 s scheduler checks each habit's `remind_at` (HH:MM), fires one Electron `Notification` per day, and suppresses it once the habit is complete.
- No wake-from-suspend timers: the existing `salah-daemon` already owns that; SelfOS must not create competing system timers (F-SALAH-09).

---

## 6. Reading module

### 6.1 Engine

- **pdf.js** (`pdfjs-dist`) renders pages to canvas with a separate text layer for selection.
- **react-pdf-highlighter** provides the highlight/annotation interaction model (text highlights, popovers, scroll-to-highlight) and is built on pdf.js. It is vendored/wrapped rather than used raw so we can add display overrides and our own persistence.
- The PDF worker runs off the UI thread (`pdfjs-dist/build/pdf.worker.mjs` bundled as an asset); pages render **on demand** with a bounded document cache (2 open PDFs, LRU-evicted) — F-READ-15, N-PERF-03/05.
- PDF scripting is disabled (`isEvalSupported: false`, passed to `getDocument`) — N-SEC-02.

### 6.2 Display overrides (the "custom styling" requirement)

Layered, in this order:

| Layer | Mechanism | Examples |
|---|---|---|
| Page raster | canvas `ctx.filter` | brightness, contrast |
| Whole-page CSS | CSS `filter` on the canvas | `invert(1) hue-rotate(180deg)` for dark, `sepia(0.35)` |
| Page surface | CSS background behind the canvas | paper / dark / sepia / black |
| Layout | pdf.js viewport | zoom, fit-width, fit-page, rotation, spread |
| Crop | viewport offset + clip | margin crop, header/footer trim |
| Typography (text layer only) | CSS on the text layer | selection color, search highlight |

Per-book overrides live in `book.settings_json` (validated by the hand-written `parseSettings`) with a global default. The override set is exactly the PRD F-READ-04 list.

> **Why not text reflow:** reflow destroys figures, tables, and equations and needs a multi-column heuristic. The PRD decision is display overrides on the original page; this section implements that.

### 6.3 Highlight anchoring (verified by SP-5)

Stored per highlight: `page`, `rects_json` (normalized to the **viewport**, 0..1), `text`, `rotation`, and `anchor_version`.

**Measured (SP-5, `spikes/RESULTS.md`):** normalized rects are invariant across zoom 1×–3× with **zero drift** and ≤ 0.001 px round-trip error. They are **not** invariant under rotation: a 0° anchor applied to a 90° page lands 790 px away. A rotation-tagged anchor re-derives exactly (0 px error).

Re-anchoring on load, in order:
1. **Rotation matches and rects resolve inside the page** → use directly (the verified fast path).
2. **Rotation differs** → do **not** trust the rects; go straight to text search on the current rotation.
3. **Text search** within the page's text layer for `text`; verified to find the marker exactly once at every scale. If exactly one hit, recompute rects.
4. **Fuzzy**: normalized whitespace + prefix/suffix context (stored in `rects_json` metadata) for hyphenation and ligature drift.
5. If none match, mark the highlight **orphaned** and show it in the annotations panel with a jump-to-page action — never silently drop it.

`anchor_version` lets a future pdf.js upgrade migrate all anchors in one pass. SP-5 downgrades PRD R1 from high/high to medium/low: the primary mechanism is proven and the single failure mode has a tested fallback.

### 6.4 Session tracking

- A reading session opens on first page view and ends on unmount or when the tab becomes hidden (30 s visibility heartbeat) or on leaving the reader.
- `active_seconds` counts only time with the reader focused and the window visible.
- Sessions feed `reading_session`, `day_aggregate.reading_seconds`, and linked habits/goals (F-READ-14, F-HABIT-13, F-GOAL-04).

### 6.5 Library storage and serving

- Managed library at `<userData>/library/<sha256>.pdf`, with metadata in `book`. The original path is recorded for traceability (F-READ-01).
- Serving: `protocol.handle('selfos-book', …)` reads from the library directory only, rejecting any path that resolves outside it (path traversal guard). This replaces `file://` access entirely.
- Deduplication by `sha256`.

---

## 7. Habits module

- Pure functions in `src/main/modules/habits/` (`src/shared/habits.ts` holds only `isComplete`):
  - `scheduleFor(versions, dateKey)` → the schedule version in effect (D-08).
  - `isDueOn(schedule, dateKey)` → boolean.
  - `computeStreak(input)` → `{ current, longest, unit }`, honoring skips (F-HABIT-06/07/08).
  - `completionRate(input, lookbackDays)` and `heatmapDays(input, days)`.
  - The Salah streak is computed over a 30-day slice (`recentDays(30)`), so `longest` is capped at 30; the heatmap reads 84 days separately.
  - Goal contributions and the progress read are capped at the latest 50 rows (F-GOAL-09).
- **Backfill** writes a normal `habit_entry` with `created_at` = now and `local_date` = the target day; no separate model (F-HABIT-10).
- **F-SALAH-07** weekly/monthly completion views are implemented (`salah.completion`, 7/30/90 grid).
- **Linked habits** (`link` = reading:pages / focus:hours / salah:prayers) are implemented: the column exists, no code writes or reads it. The paragraph that described aggregation-time resolution was removed with the component.
- Streaks are never stored; they are computed per render from a day-indexed query (D-03).

---

## 8. Theme adapter

- Read `~/.local/state/omarchy/current/theme/colors.toml` with the hand-rolled flat reader and `theme.name` for the label.
- Watch the theme directory (5 s poll over `theme.generation` plus the `colors.toml` mtime) and push a `theme-changed` IPC event; the renderer swaps CSS variables without a reload.
- Token mapping:

| Omarchy token | CSS variable | Use |
|---|---|---|
| `background` | `--bg` | app surface |
| `dark_background` / `darker_background` | `--bg-sunken` | sidebar, cards |
| `lighter_background` | `--bg-raised` | hover, inputs |
| `foreground` | `--fg` | primary text |
| `muted` | `--fg-muted` | secondary text |
| `selection` | `--selection` | text selection |
| `accent` | `--accent` | primary action, current state |
| `red` `orange` `yellow` `green` `cyan` `blue` `magenta` | `--c-*` | categories, habit colors, chart series |
| `mode` | `data-theme` | light/dark switch |

- **Contrast gate:** every text/background pair is checked against WCAG AA at build time for the bundled fallback theme, and at runtime a warning is logged (not shown) if a theme pair fails (N-UX-03).
- The reader offers its own paper/sepia/dark surfaces independent of the theme, because reading comfort may justify divergence (PRD OQ-6).

---

## 9. Notes module (Obsidian integration)

- **Vault discovery:** parse `~/.config/obsidian/obsidian.json` → `vaults[*].path`; the referenced path may not exist (C-8), so validate and fall back to a user-picked folder.
- **Indexing:** Node `fs.watch` recursive on `**/*.md` (ignores `.obsidian/`, `.trash/`), debounced 500 ms, with a 2 s mtime-poll fallback on Linux where recursive watch is unavailable; incremental re-index of changed files only (F-NOTES-06).
- **Index storage:** a separate SQLite file (`notes-index.sqlite`) with an FTS5 table `note_fts(path UNINDEXED, title, body, tags)` plus a `note` row for metadata (`mtime`, size, frontmatter). Keeping it out of the main DB means a vault re-index never bloats backups or contends with collector writes; it is fully rebuildable. Rebuild command on the health page.
- **Frontmatter/tags:** hand-rolled `splitFrontmatter` (`src/shared/frontmatter.ts`); also extract inline `#tags`.
- **Open in Obsidian:** `obsidian://open?vault=<basename>&file=<urlencoded relative path>`; vault name = folder basename (standard Obsidian behaviour). Optional `&heading=`.
- **Writes:** only two, both explicit and atomic (write temp → `rename`):
  1. Highlight export block into a configured folder (F-READ-10).
  2. Daily note stub / quick capture append (F-NOTES-05/07).
- **Never** rewrite, reformat, or delete existing notes (F-NOTES-09). Writes are atomic (temp → rename); the `note_audit` table records every vault write.

---

## 10. Salah module

- **Times:** from the existing `salah-ctl status` contract (F-SALAH-01); fallback `adhan` with Karachi 18/18 + Hanafi (F-SALAH-02).
- **Outcome model:** `on_time` (before the next prayer's start, and within a configurable window), `late` (after that window but same day), `missed`, `excused`.
- **Qada:** a missed prayer writes `qada_event(+1)`; marking a make-up writes `qada_event(-1)` and links the date. Debt per prayer = `max(0, SUM(delta))` (F-SALAH-05); the floor is what keeps an over-repayment from hiding a later missed prayer.
- **Hijri date:** `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')`. Spike SP-4 verifies V8 support (near-certain, but cheap to confirm); fallback is the existing Python algorithm ported to TypeScript.
- **Heatmaps and streaks:** computed from `prayer_log` (F-SALAH-07/11).
- **Audio:** none. The app never plays adhan while the external stack owns alarms (F-SALAH-09).

---

## 11. Goals and dashboard

- **Goal progress** is a pure function over the goal kind (`modules/goals/model.ts`):
  - `numeric` / `quota` → the `goal_progress` row with the greatest `at`,
    tie-broken by `id`. **Newest, not maximum**: readings are absolute values, so
    a mistaken entry must be correctable downward, and imported readings carry
    their own timestamp so out-of-order ingestion still orders correctly.
  - `milestones` → `done_at IS NOT NULL` count / total; the target defaults to
    the checklist length.
- **Pace projection:** `daysNeeded = (target - value) / (value / elapsed)`,
  `projected = today + daysNeeded`; with `value = 0` there is no projection and
  a dated goal is off-pace (F-GOAL-05). "Off pace" means the *projection* misses
  the target date, not that today's straight line is behind — a goal may start
  slow and catch up.
- **Roll-up (F-GOAL-08):** a parent's fraction is the unweighted mean of its
  children's fractions. Completed children still count; abandoned ones do not.
  Excluding completed children would make a parent's percentage *fall* when a
  child is finished.
- **Goal writes are additive.** Closing records `status`, `closed_at`, and
  `close_reason` (migration `0002_goals.sql` adds `parent_id` and
  `close_reason`); nothing is deleted, so history survives (F-GOAL-07).
- **Dashboard** reads `day_aggregate`, `prayer_log`, `habit_entry`, `browser_visit` and the goal tables — all indexed, all small. The 24 h timeline is built from a bucketed query over `focus_event` for one day, cached by React Query (F-DASH-02, N-PERF-02).

---

## 12. Build, test, and operations

### 12.1 Repository layout

```
selfos/
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── src/
│   ├── main/                # Electron main process (Node 24)
│   │   ├── index.ts         # app lifecycle, windows, tray, single-instance
│   │   ├── ipc/             # typed channel handlers + hand-written guard validation
│   │   ├── db/              # driver.ts (only node:sqlite import), migrations, queries
│   │   ├── modules/         # reading, habits, time, salah, notes, goals
│   │   ├── integrations/    # hyprland, browser-history, salah-bridge, obsidian, omarchy-theme
│   │   └── services/        # backup, export, scheduler, worker-thread pool
│   ├── collector/           # collector logic (process-agnostic; utilityProcess in v1)
│   ├── preload/             # contextBridge surface only
│   ├── shared/              # contracts: IPC types, hand-written contract types, pure functions
│   └── renderer/            # React app (Vite)
├── assets/pdfjs/            # worker, fonts, cmaps (bundled as extraResources)
├── ops/systemd/             # selfos.service
└── tests/                   # unit + integration fixtures
```

### 12.2 IPC contract

One shared contract module (`src/shared/api.ts`) defining channel names, params and results. `preload` exposes a closed, typed API:

```ts
contextBridge.exposeInMainWorld('selfos', {
  reading: { listBooks, openBook, savePosition, addHighlight, … },
  habits:  { listToday, toggle, setValue, skip, … },
  time:    { daySummary, timeline, topSites, … },
  salah:   { today, log, qada, … },
  notes:   { search, openInObsidian, exportHighlights, … },
  goals:   { list, progress, … },
  system:  { health, pauseTracking, theme, … },
});
```

Every handler validates its input with hand-written guards and returns a discriminated `{ ok: true, data } | { ok: false, error }` so the UI has no unhandled exceptions (N-UX-04).

### 12.3 Testing strategy

| Layer | Tool | What is tested |
|---|---|---|
| Pure functions | `vitest` | streaks, schedules, pace projection, title parsing, timestamp conversion |
| Queries | `vitest` + in-memory SQLite | migrations, idempotent ingest, aggregate rebuild |
| Integrations | `vitest` + recorded fixtures | Hyprland event stream replay, history DB fixture, salah status JSON |
| UI | logic-level only | DOM-level views are verified by the Electron verifiers, not unit tests |
| End-to-end | `spikes/verify-*.cjs` via `just verify-*` | launch, tray actions, open a PDF, log a prayer |
| Manual checklist | §12.5 | autostart, suspend/resume, theme switch, Wayland drag |

**Non-negotiable tests:** Chromium timestamp conversion with `bigint`; ingest idempotency (run twice → same row count); streak across a schedule change; highlight re-anchor after zoom change; collector gap on socket drop; protocol path-traversal rejection.

### 12.4 Development loops

- Renderer: `vite` HMR — window stays open.
- Main/preload: `electron-vite dev` rebuilds and restarts the app.
- Collector standalone: `node --experimental-strip-types src/collector/index.ts` with a test DB.

### 12.5 Release and smoke checklist

- `electron-builder` produces an **AppImage** (primary) and a **deb** (optional) for linux-x64.
- Smoke checklist before each release: launch → tray → close hides → reopen → open a 100+ MB PDF → highlight → restart → highlight intact → log prayer → dashboard totals → theme switch → suspend/resume → verify no double-counted time.
- Autostart `.desktop` file written/removed from settings, listed on the health page.
- Disk budget: Electron install + library. With 25 GB free this is fine, but the health page reports disk headroom.

---

## 13. Verification evidence (what was actually run)

| Probe | Command | Result |
|---|---|---|
| Hyprland version | `hyprctl version` | 0.56.2, Wayland, `.socket2.sock` present |
| Active window shape | `hyprctl activewindow -j` | `class: "helium"`, `title: "… - YouTube - Helium"`, `pid`, `workspace` |
| History readability | `sqlite3 'file:…/History?immutable=1' 'SELECT COUNT(*) FROM visits;'` | 59 220 visits; no lock error |
| History durations | `SELECT url, visit_time, visit_duration …` | Real durations (e.g. 31 941 337 µs) |
| History schema | `.schema visits` | `url`, `visit_time`, `visit_duration`, `transition`, indexes present |
| SQLite FTS5/JSON1 | `bun` probe (engine-equivalent, SQLite 3.53.2) | FTS5 and JSON1 both work — required for the notes index |
| TOML parsing | hand-rolled flat reader over `colors.toml` | All keys the adapter maps are present; quoted values and trailing comments are handled |
| Unix sockets | `Bun.connect` / `Bun.listen` probe (not available under Node) | Unix sockets work; production path is `net.createConnection({ path })` |
| Theme tokens | read `colors.toml` | `mode="dark"`, `accent`, `background`, ANSI palette |
| Linux runtime deps | `pacman -Q` / `ldconfig -p` | gtk3, webkit2gtk-4.1, libayatana-appindicator3, librsvg present |
| Existing salah stack | read of CLI/daemon/config | Times + alarms + Quickshell widget; **no prayer log** |
| Obsidian config | read `obsidian.json` | Vault path recorded but missing on disk → must validate |
| Resources | `free -h`, `df -h` | 1.6 GB RAM free, 25 GB disk free → no DB copying |
| Electron 45 stack | release notes | Chromium 156.0.8078.48, Node 24.22.0, V8 15.6; released 2026-10-21 |
| Electron support window | endoflife.date | 45 → 2027-04-27; only latest three majors supported |
| `node:sqlite` status | Node docs | Stability **1.2 — release candidate**; `readOnly`, `setReadBigInts` available |
| Preload sandbox limits | Electron 45 breaking changes | `events`/`timers`/`url` shims and `Buffer` removed from sandboxed preload |
| Tauri Linux renderer | `wry 0.57.1` features | `webkit2gtk` only; **no Chromium/CEF backend** |
| `powerMonitor` coverage | Electron docs | `lock-screen`/`unlock-screen` are macOS+Windows only |
| `setLoginItemSettings` | Electron issue #15198 | No Linux implementation → write XDG autostart file |
| Online backup of a live WAL DB | `VACUUM INTO ?` as a prepared statement | Works; `exec` cannot bind the filename. Used by `modules/data/backup.ts` |
| Analytics colour palette | `validate_palette.js` on the Omarchy accents | **Fails** categorical checks (chroma floor, ΔE 14.2 < 15) → charts are single-series |
| SelfOS workspace placement | Hyprland 0.56.2 window rule | `workspace = "5 silent"` on class `^(selfos|electron)$` works; `pin` refused for tiled windows |

---

## 14. Traceability matrix

| PRD requirement group | Implemented by | Key sections |
|---|---|---|
| F-SHELL-01…10 (shell, tray, lifecycle) | Electron windows/tray + single-instance lock + XDG autostart | §2.3, §2.5, §3.3 |
| F-READ-01…18 (reading) | pdf.js + react-pdf-highlighter + overrides + anchoring | §6 |
| F-HABIT-01…15 (habits) | Pure functions + versioned schedules | §7 |
| F-TIME-01…16 (screen/watch time) | Hyprland IPC + history ingest + rules; F-TIME-08 sessions and F-TIME-09 7×24 matrix shipped; F-TIME-11 crash supervision, F-TIME-12 and F-TIME-15 are open | §5.2, §5.3 |
| F-SALAH-01…12 (salah) | Existing-stack bridge + local logging | §5.4, §10 |
| F-NOTES-01…10 (notes) | Obsidian vault index + URI + limited writes | §9 |
| F-GOAL-01…09 (goals/progress) | Goal model + derived progress | §11 |
| F-DASH-01…10 (dashboard) | Aggregate tables + React Query; F-DASH-02 band + prayer markers shipped; F-DASH-09 day/week/month components open | §11 |
| F-SET-01…08 (settings/data) | Health page, backup/export, theme | §4.5, §8 |
| N-PERF-* | WAL, indexes, on-demand rendering, worker threads | §4.1, §6.1 |
| N-REL-* | WAL, transactions, watermarks, migrations | §4.1, §4.3, §5 |
| N-SEC-* | Sandboxed renderer, typed IPC, custom protocol, read-only external access | §2.3, §3.4, §5.3 |
| N-UX-* / N-A11Y-* | Theme adapter, component standards | §8 |
| N-I18N-01 | `Intl` for Hijri; Arabic shaping via system fonts | §10 |
| D-01…D-10 | Physical schema and invariants | §4.2, §4.3, §6.3 |

---

## 15. Stack risks and mitigations

Risk IDs are `S1…S12` (no dash). Spikes are `SP-1…SP-10` (§16).

| # | Risk | Mitigation |
|---|---|---|
| S1 | Electron memory pressure: **`earlyoom` is configured `--prefer "^(electron\|chrome\|helium\|firefox)$"`**, so a SelfOS spike is killed first | Measured 242 MB PSS idle / ~312 MB with a PDF (SP-2) — acceptable. Keep the reader page cache small, run ingest in a worker, keep the collector separately killable, and surface `earlyoom` kills on the health page |
| S2 | `node:sqlite` is an RC and may change | One driver module; swap to `better-sqlite3` costs ~half a day |
| S3 | Browser history DB cannot be opened while Helium runs | Verified: only `immutable=1` or a copy works. Snapshot-first strategy in §5.3, with a size guard and health-page reporting |
| S4 | Chromium timestamp precision | `setReadBigInts(true)` + `BigInt` conversion; dedicated test |
| S5 | Highlight anchors drift | Versioned anchors + text-search fallback + orphan state |
| S6 | External salah stack changes its JSON | `zod` validation; fallback computation; contract documented in PRD §8 |
| S7 | PDF worker/assets missing in packaged build | `extraResources` for worker/fonts/cmaps; packaged smoke test in every milestone |
| S8 | Vault path invalid (C-8) | Runtime validation + folder picker + graceful degradation |
| S9 | Electron's Chromium may lack proprietary codecs | Spike SP-9 measures H.264/AAC playback; local media is a first-class feature, so a non-proprietary build would be a real problem |
| S10 | Frameless custom titlebar on Wayland is fragile | Spike SP-10; fallback is a native frame with a styled header inside the window |
| S11 | Two processes writing SQLite | WAL + `busy_timeout` + short transactions; collector owns aggregates, app owns user actions |
| S12 | Scope (seven modules) | Shared shell/contracts first; milestones M0–M7 are independently shippable (PRD §10) |

---

## 16. Spikes to run before implementation commits

**Status:** the gating set has been run. Full results, evidence, and methodology notes: [`spikes/RESULTS.md`](./spikes/RESULTS.md).

| ID | Question | Status | Result |
|---|---|---|---|
| SP-1 | Does `node:sqlite` open the live Helium DB read-only, and handle WAL writes from two processes? | **PASS, design changed** | Non-immutable opens all fail (`database is locked`); `immutable=1` and copy work; WAL 1 200/1 200 commits across 3 processes; no `db.transaction()` |
| SP-2 | What is Electron's idle and reader memory on this machine? | **PASS (tight)** | 242 MB PSS idle, ~312 MB with a PDF; 19 ms/page; `earlyoom` prefers Electron |
| SP-3 | Does the Hyprland `socket2` stream work and survive a drop? | **PASS** | 45 events / 10 focus transitions / reconnect verified; `windowtitle` gives page changes without re-focus |
| SP-4 | Does `Intl` support `islamic-umalqura`? | **PASS** | Native; differs from other Islamic calendars by a day |
| SP-5 | Do stored highlight anchors survive zoom / rotation / re-render? | **PASS, schema changed** | Zero drift 1×–3×, ≤0.001 px round-trip; rotation is **not** invariant (790 px error) → `highlight.rotation` added |
| SP-6 | Packaged build includes the pdf.js worker/fonts and the custom protocol? | **open** | Requires `electron-builder` scaffold |
| SP-7 | `chokidar` recursive watch cost on the real vault | **open** | Blocked: the configured vault path does not exist (C-8) |
| SP-8 | Tray appears and registers under the StatusNotifier watcher? | **PASS** | Watcher item count 8 → 9; visual confirmation pending |
| SP-9 | Does Electron's Chromium decode H.264/AAC in this build? | **PASS** | H.264/AAC, VP8/VP9/Opus all play; earlier failure was fixture loading |
| SP-10 | Frameless window drag/resize on Hyprland | **partial** | Created and shown; drag is CSS-only, needs visual check |

**Gate: all gating spikes cleared** — SP-1, SP-2, SP-3, SP-4, SP-5, SP-8, SP-9. Remaining open items (SP-6 packaging, SP-7 vault watch, SP-10 visual drag check) are verification tasks inside M0/M4, not architecture gates.

---

## 17. References

Product requirements and acceptance criteria: [`PRD.md`](./PRD.md).

Electron:

- Releases and versioning — <https://releases.electronjs.org/release/v45.0.0>
- Support windows (latest three majors) — <https://endoflife.date/electron>
- Breaking changes (45.0 preload sandbox) — <https://www.electronjs.org/docs/latest/breaking-changes>
- `powerMonitor` — <https://www.electronjs.org/docs/latest/api/power-monitor>
- Linux autostart gap — <https://github.com/electron/electron/issues/15198>

Alternatives evaluated:

- `wry` features (no Chromium backend on Linux) — <https://docs.rs/crate/wry/latest/features>
- Tauri WebKitGTK stability discussion — <https://github.com/orgs/tauri-apps/discussions/8524>
- Tauri releases — <https://github.com/tauri-apps/tauri/releases>
- Electrobun docs (kept for the fallback path) — <https://framework.blackboard.sh/electrobun/guides/what-is-electrobun>

Data and platform:

- `node:sqlite` (RC status, `readOnly`, `setReadBigInts`) — <https://nodejs.org/api/sqlite.html>
- ActivityWatch watchers (Wayland limitation) — <https://docs.activitywatch.net/en/latest/watchers.html>
- Hyprland IPC reference — <https://wiki.hyprland.org/0.45.0/IPC>

Reading and notes:

- react-pdf-highlighter — <https://github.com/agentcooper/react-pdf-highlighter>
- pdf.js layers — <https://www.react-pdf-kit.dev/blog/understanding-pdfjs-layers-and-how-to-use-them-in-reactjs>

Local systems integrated:

- `~/.local/bin/salah-ctl`, `~/.local/bin/salah-daemon`, `~/.config/systemd/user/salah-daemon.service`, `~/.config/omarchy/salah.json`
- `~/.config/omarchy/plugins/saboor.salah/` (Quickshell bar widget)
- `~/.local/state/omarchy/current/theme/colors.toml`
- `~/.config/net.imput.helium/Default/History`
- `~/.config/obsidian/obsidian.json`
