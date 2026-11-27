# SelfOS task runner — `just` (Rust). Run `just` to list recipes.
#
# Toolchain: bun (package manager + script runtime), electron-vite (build),
# biome (Rust linter/formatter), just (Rust task runner).
#
# NOTE: this shell exports ELECTRON_RUN_AS_NODE=1, which turns every Electron
# launch into plain Node. Every electron invocation clears it explicitly.
#
# Verification recipes also set SELFOS_VERIFY=1: that keeps every window
# unmapped and redirects userData to ~/.cache/SelfOS-verify, so a headless run
# cannot be matched by the workspace-5 window rule, steal focus, or touch the
# user's real database. It does NOT change the Wayland app_id: on this build the
# app_id is always `electron` and cannot be changed from inside the process.

default_dir := justfile_directory()

# List available recipes
default:
    @just --list

# ── development ───────────────────────────────────────────────────────────

# Install dependencies (bun)
install:
    bun install

# Run the app with renderer HMR
dev:
    env -u ELECTRON_RUN_AS_NODE bun run electron-vite dev

# Build main, preload, and renderer into out/
build:
    bun run electron-vite build

# Run the built app without the dev server
start: build
    env -u ELECTRON_RUN_AS_NODE bun run electron-vite preview

# ── quality gates ─────────────────────────────────────────────────────────

# Type-check everything (tsc)
typecheck:
    bunx tsc --noEmit

# Lint with biome (Rust)
lint:
    bunx biome check src tests

# Format with biome (Rust)
fmt:
    bunx biome format --write src tests

# Auto-fix lint issues
fix:
    bunx biome check --write src tests

# Unit tests (vitest under bun).
#
# `vitest.config.ts` pins the pool to one worker. This recipe adds a hard
# memory ceiling on top: the suite runs inside a cgroup capped at 1G with swap
# disabled, so a runaway test dies alone and can never contribute enough
# pressure for systemd-oomd to take out an entire session cgroup. That has
# happened twice (146 and 129 processes at once), so the ceiling is not
# theoretical.
test:
    systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 bunx vitest run

# Unit tests without the memory-capped scope, for environments with no
# systemd --user (containers, CI images).
test-plain:
    bunx vitest run

# Unit tests in watch mode.
#
# Capped for the same reason as `test`: a watch process runs for hours and is
# the longest-lived thing an agent session can start. `--scope` blocks, so the
# recipe stays attached to the terminal and Ctrl-C still stops it.
test-watch:
    systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 bunx vitest

# Everything that must pass before a commit
check: typecheck lint
    @if systemctl --user show-environment >/dev/null 2>&1; then just test; else just test-plain; fi
    @echo "all gates passed"

# ── end-to-end verification ───────────────────────────────────────────────

# M0: shell boots, IPC works, DB migrates
verify-shell: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-shell.cjs --no-sandbox

# M1: live Hyprland collector writes real focus time
verify-time: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-time.cjs --no-sandbox

# M2: habits through the real UI
verify-habits: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-habits.cjs --no-sandbox

# M3: salah against the live salah-ctl
verify-salah: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-salah.cjs --no-sandbox

# M4: import, render, highlight, and export a real PDF
verify-reading: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-reading.cjs --no-sandbox

# M5: Obsidian vault indexing, search, preview, capture, highlight export
verify-notes: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-notes.cjs --no-sandbox

# M6: goals of all three kinds, pace, nesting, close/reopen
verify-goals: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-goals.cjs --no-sandbox

# M7: analytics, backups, exports, command palette, accessibility
verify-polish: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-polish.cjs --no-sandbox

# M8: browser history ingest, site time, provenance, categories
verify-sites: build
    env -u ELECTRON_RUN_AS_NODE SELFOS_VERIFY=1 bunx electron spikes/verify-sites.cjs --no-sandbox

# All verification runs
verify: verify-shell verify-time verify-habits verify-salah verify-reading verify-notes verify-goals verify-polish verify-sites

# ── design spikes (evidence behind STACK.md) ──────────────────────────────

# node:sqlite against the live browser DB + WAL contention
spike-sqlite:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/sp1-sqlite.cjs --no-sandbox

# SQLite open modes against the live history DB
spike-probe:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/sp1-probe.cjs --no-sandbox

# Electron memory (RSS + PSS)
spike-memory:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/sp2-memory.cjs --no-sandbox

# pdf.js render throughput
spike-pdf:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/main.cjs --spike=SP-2 --no-sandbox

# H.264 / AAC / VP9 playback
spike-codecs:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/main.cjs --spike=SP-9 --no-sandbox

# Hijri calendar support
spike-intl:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/main.cjs --spike=SP-4 --no-sandbox

# Tray registration with StatusNotifierWatcher
spike-tray:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/main.cjs --spike=SP-8 --no-sandbox

# Highlight anchor stability across zoom/rotation
spike-anchors:
    env -u ELECTRON_RUN_AS_NODE bunx electron spikes/sp5-anchors.cjs --no-sandbox

# Hyprland socket2 event stream
spike-hyprland seconds="25":
    bun spikes/sp3-hyprland.cjs --seconds={{seconds}}

# ── maintenance ───────────────────────────────────────────────────────────

# Show app data location and size
where:
    @echo "db:      ~/.config/SelfOS/selfos.sqlite"
    @du -sh ~/.config/SelfOS 2>/dev/null || echo "not created yet"

# Wipe local app data (asks first)
reset-data:
    rm -f ~/.config/SelfOS/selfos.sqlite*
    @echo "local database removed"

# Remove build output and caches
clean:
    rm -rf out node_modules/.vite
    @echo "cleaned"
