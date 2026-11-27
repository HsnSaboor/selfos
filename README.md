# SelfOS

A local-first personal operating system for the desktop: PDF reading, habits,
screen & watch time, salah tracking, Obsidian notes, goals, and a single daily
dashboard.

- **Product requirements:** [`PRD.md`](./PRD.md)
- **Architecture & decisions:** [`STACK.md`](./STACK.md)
- **Spike evidence:** [`spikes/RESULTS.md`](./spikes/RESULTS.md)

## Status

- **M0 (shell)** — complete and verified (32/32).
- **M1 (time tracking)** — complete and verified (16/16 + 25 unit tests).
- **M2 (habits)** — complete and verified (29/29 + 65 unit tests).
- **M3 (salah)** — complete and verified (29/29 + 86 unit tests).
- **M4 (reading)** — complete and verified (27/27).
- **M5 (notes)** — complete and verified (49/49): Obsidian vault indexing, FTS5
  search, preview, quick capture, idempotent highlight export (verified against a
  disposable vault; the real vault is not present on this machine).
- **M6 (goals)** — complete and verified (48/48): numeric, milestone, and quota
  goals, pace projection, nesting roll-up, close/reopen.
- **M7 (polish)** — implemented and verified (52/52): analytics, backups, JSON/CSV
  export, Ctrl+K command palette, accessibility pass. The PRD's 30-day daily-use
  trial is still open.
- **M8 (sites)** — complete and verified (39/39): browser-history ingest,
  per-site and per-page time, watch time, categories, provenance.

**461 unit tests**; eight end-to-end runs green and M1 skipped without a Hyprland
socket (a skipped run is not counted as green). Feature-complete for the shipped
subset; open: F-HABIT-11/13, F-SALAH-07, F-TIME-11/12/15, F-DASH-09, a separate
collector process, and the notes write audit.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron 45.2.1 | Only mature option with a bundled Chromium |
| UI | React 19 + TypeScript | Largest ecosystem for the reader and charts |
| Build | Vite via `electron-vite` | HMR for the renderer, bundled main/preload |
| Package manager | **Bun 1.4.2** | Faster installs, native TS execution |
| Task runner | **`just` (Rust)** | Project recipes, no JS task-runner layer |
| Lint + format | **Biome (Rust)** | One binary for both, ~100 ms on this repo |
| Tests | Vitest under Bun | Same runner for unit and DOM tests |
| Database | SQLite via `node:sqlite` | Built into Node 24, no native addon |
| Integration | Hyprland IPC · pdf.js | Verified by the spikes in `spikes/` |

## Requirements

- Linux + Hyprland (Wayland). macOS/Windows are out of scope for v1.
- Node 22+ (for tooling), Electron is installed as a dev dependency.

## Commands

```bash
just                   # list every recipe
just install           # bun install
just dev               # renderer HMR + main process
just build             # production bundle in out/
just check             # typecheck + lint + tests (the pre-commit gate)
just verify            # all nine end-to-end runs (M0–M8)
just where             # where the database lives
```

`just` is the primary entry point and calls the tool binaries directly; the
`package.json` scripts are a thin human-facing mirror. The raw equivalents still work:
`bun run dev`, `bunx biome check src tests`, `bunx vitest run`.

> This shell exports `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain
> Node. Every `just` recipe and npm script clears it with
> `env -u ELECTRON_RUN_AS_NODE`; keep that if you add commands.

## Quality gates

`just check` runs three gates and must pass before a commit:

1. `tsc --noEmit` — types across main, preload, renderer, and tests
2. `biome check src tests` — lint + format (Rust, one pass)
3. `just test` — 461 unit tests covering segment merging, aggregation,
   schedules, streak semantics, salah windows, anchor resolution, the notes
   index, goal pace math, backup retention, analytics, browser-history ingest,
   and site-time reconciliation

## Spikes

Reproduce any measurement behind a design decision:

```bash
just spike-sqlite        # node:sqlite vs live browser DB + WAL contention
just spike-probe         # open modes against the live history DB
just spike-memory        # Electron RSS/PSS
just spike-pdf           # pdf.js render throughput
just spike-codecs        # H.264/AAC/VP9 playback
just spike-intl          # Hijri calendar support
just spike-tray          # tray registration
just spike-anchors       # highlight anchor stability
just spike-hyprland 25   # Hyprland socket2 event stream
```

## Layout

```
src/
  main/        Electron main (Node 24): windows, tray, DB, IPC handlers
    db/        driver.ts is the ONLY node:sqlite import
    integrations/
    modules/   one folder per product area (time, habits, salah, reading,
               notes, goals, data) — modules never read each other's tables
    services/
  preload/     contextBridge surface (CJS, sandboxed)
  renderer/    React app
  shared/      typed IPC contract shared by all three contexts
spikes/        verification harnesses + results
```

## Packaging, update and uninstall

```bash
just dist        # AppImage + deb into release/ (needs `bun install` first)
just uninstall   # removes the autostart entry and ~/.config/SelfOS
```

There is no auto-updater: upgrade by installing the new package over the old
one (the database is forward-migrated, with a pre-migration copy beside it).
Electron majors are the migration trigger; the supported window is three majors.
