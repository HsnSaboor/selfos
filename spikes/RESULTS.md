# Spike Results — Gating Set

**Date:** 2026-11-02 · **Electron:** 45.2.1 (Chromium 156.0.8078.75, Node 24.22.1, V8 15.6)
**Machine:** Omarchy, Hyprland 0.56.2 (Wayland), Intel UHD 620, 7.6 GB RAM

Harness: `spikes/main.cjs`, `spikes/sp1-sqlite.cjs`, `spikes/sp1-probe.cjs`, `spikes/sp2-memory.cjs`, `spikes/sp3-hyprland.cjs`.
Raw JSON in `spikes/out/`.

| Spike | Verdict | One-line result |
|---|---|---|
| SP-1 `node:sqlite` | **PASS (with one required change)** | Live DB only readable in `immutable` mode; WAL handles 3 concurrent writers cleanly |
| SP-2 memory | **PASS (tight)** | 242 MB PSS idle, +70 MB with a 40-page PDF open |
| SP-4 Intl Hijri | **PASS** | `islamic-umalqura` native, correct output |
| SP-8 tray | **PASS** | Tray registers with StatusNotifierWatcher |
| SP-9 codecs | **PASS** | H.264/AAC + VP8/VP9/Opus all play |
| SP-3 Hyprland IPC | **PASS** | 45 events, 10 focus transitions, reconnect verified |

---

## SP-1 — `node:sqlite` against the live history DB

| Test | Result |
|---|---|
| Module available in Electron 45 main | Yes (`node:sqlite`, Node 24.22.1) |
| `readOnly: true` open + query | **`database is locked`** |
| `readOnly` + `busy_timeout=5000` | Still locked, after 5 011 ms |
| `busy_timeout` + 5 retries | Still locked |
| Default (read-write) open | **`database is locked`** |
| `file:…?immutable=1` | **Works — 59 232 visits in 1.55 ms** |
| Copy then read | Works (59 232), 3.3 s, ~433 MB — unacceptable under C-4 |
| WAL: 3 processes × 400 transactions | **1 200/1 200 committed, 0 busy, `integrity_check: ok`** in 297 ms |
| `db.transaction()` helper | **Does not exist** in `node:sqlite` |

**Why plain read-only fails:** Helium keeps a `History-journal` (rollback journal, `journal_mode=delete`) open. A read-only connection may not roll back a hot journal, so SQLite refuses. `immutable=1` tells SQLite the file cannot change, which is a deliberate risk: any page written by Helium after we open may not be seen, and a mid-write read could return inconsistent data.

**Required design change:**

1. **Primary strategy is a snapshot copy**, not an immutable read. Use `VACUUM INTO` from a short-lived read-only-capable path, or `cp` of a quiesced file — then read the copy. This is safe and consistent.
2. The copy must be **bounded**: never copy 433 MB wholesale on a timer. Copy only on demand, delete immediately after ingest, and prefer `immutable=1` as a *fast path* when the journal is absent.
3. `immutable=1` is acceptable as a **best-effort fast path** when `History-journal` does not exist, with the copy as the fallback. This is a runtime decision based on `fs.existsSync` of the journal.
4. **No `db.transaction()`** — use explicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`.
5. BigInt is mandatory and verified lossy as predicted:

```
visit_time = 13438069468748681
exceedsMaxSafe = true
Number(visit_time) = 13438069468748680   ← off by 1
```

## SP-2 — memory

| State | RSS sum | PSS |
|---|---|---|
| Idle shell (6 processes) | 563 MB | **242 MB** |
| With 40-page PDF rendered | 645 MB | ~312 MB (+70) |
| Per-process | main 178 · zygote 2×60 · gpu 106 · utility 77 · renderer 83 | — |

PDF rendering: **19 ms median per page**, 1 083 ms for 40 pages, text layer selectable and containing the test marker.
GPU: `ANGLE (Intel, Mesa Intel UHD Graphics 620 (KBL GT2), OpenGL ES 3.2)`.

**Verdict: passes, but with a real constraint.** 242 MB PSS idle is far better than the 575 MB RSS-sum first suggested (that number included T3 Code's own Electron processes). Still, the machine has ~2 GB available and **`earlyoom` is configured with `--prefer "^(electron|chrome|helium|firefox)$"`** — meaning a memory spike gets SelfOS killed first. Mitigations: keep the reader's page cache small, run ingest in a worker, and treat the collector as a separate process so the UI can be closed to reclaim memory.

## SP-3 — Hyprland IPC

| Check | Result |
|---|---|
| Socket present / connectable | Yes |
| Events received in 25 s | **45** |
| Event types | `activewindow`, `activewindowv2`, `workspace`, `workspacev2`, `openwindow`, `windowtitle`, `windowtitlev2`, `activelayout`, `movewindow`, `movewindowv2` |
| Focus transitions captured | **10** |
| Segments built | 11, with class, title, workspace, duration |
| Reconnect after forced drop | Yes — 2 connects, 1 reconnect, events flowed afterward |
| Reconcile via `hyprctl -j activewindow` | Works |

**Methodology note (important):** an early run reported 0 events because the trigger commands were wrong, not because the socket was broken. Hyprland 0.56 replaced the string dispatcher with a Lua API (`hl.dsp.*`), so `hyprctl dispatch workspace 3` fails. Real events are produced by launching windows and switching focus. Anyone repeating this must use `hl.dispatch(hl.dsp.window.bring_to_top({class="..."}))` or launch a real window.

**Bonus finding for the product:** `windowtitle` events fire on title change, so a browser page change (e.g. a new YouTube video) is observable **without** re-focusing. That makes the window-title fallback (F-TIME-05) more precise than assumed.

## SP-4 — Hijri calendar

```
islamic-umalqura → Jumada I 22, 1448 AH
islamic-civil    → Jumada I 21, 1448 AH
islamic          → Jumada I 23, 1448 AH
formatToParts    → month=5, day=22, year=1448, era=AH
```

`islamic-umalqura` is available and differs from the other calendars by a day, which matters for Ramadan dates. Use `islamic-umalqura` explicitly; do not rely on a default.

## SP-8 — tray

- `Tray` created with a context menu; not destroyed.
- `org.kde.StatusNotifierWatcher` is present with a host (`StatusNotifierHost-2309-...`).
- Watcher item count went from 8 to **9** after creating the tray, confirming registration.
- SNI item names are generic (`:1.72/StatusNotifierItem`), so the item cannot be identified by name — verification is by count delta and by the tray being visible in the bar.

**Caveat:** visual confirmation in the Omarchy bar was not performed automatically; the count delta is the programmatic evidence.

## SP-9 — media codecs

| Codec | `canPlayType` | Actual playback |
|---|---|---|
| H.264 Baseline / High (`avc1`) | probably | **yes** — local MP4, 320×240, 3 s |
| AAC-LC (`mp4a.40.2`) | probably | **yes** (same file) |
| VP8 / VP9 | probably | **yes** — remote WebM, 1280×720 |
| Opus | probably | **yes** |
| MPEG-TS | no | — |
| QuickTime | no | — |
| MSE | — | available |

**Verdict: no codec problem.** The earlier `MEDIA_ERR_SRC_NOT_SUPPORTED` was a fixture-loading failure (`file://` from a data-URL page), not a codec gap. Hardware *acceleration* was not verified: the host's VA-API iHD driver is broken (`undefined symbol: GmmGetAIL`), which affects Chromium generally and is unrelated to SelfOS.

## SP-10 — frameless window

Window created with `frame: false`, `resizable: true`, drag region applied via CSS. No programmatic assertion of drag/resize is possible; visual confirmation is required. Not gating.

---

## Consequences for the documents

1. **STACK.md §5.3 must change**: history ingest is snapshot-first, not immutable-first.
2. **STACK.md §4.1** must note that `db.transaction()` does not exist.
3. **STACK.md §2.5/§15** should record the `earlyoom` preference, which makes memory a first-class constraint rather than a theoretical one.
4. **STACK.md §5.2** gains a fact: `windowtitle` events give page-level changes without focus changes.
5. **PRD F-TIME-13** (incremental, non-mutating ingest) is satisfiable, but "never copy" must become "never copy *on a timer*; copy only for a consistent snapshot".

---

## SP-5 — highlight anchor stability (the last gating spike)

Mechanism tested: store each text item's rect **normalized to the page viewport** (`nx, ny, nw, nh` in 0..1), then re-derive screen rects at any scale. This is exactly what R1 depends on.

### Zoom: stable

| Scale | nx | ny | nw | nh |
|---|---|---|---|---|
| 1.0 | 0.117647 | 0.768939 | 0.463510 | 0.013889 |
| 1.25 | 0.117647 | 0.768939 | 0.463510 | 0.013889 |
| 1.5 | 0.117647 | 0.768939 | 0.463510 | 0.013889 |
| 2.0 | 0.117647 | 0.768939 | 0.463510 | 0.013889 |
| 3.0 | 0.117647 | 0.768939 | 0.463510 | 0.013889 |

- **Max normalized drift across 1×–3×: 0.0**
- Round-trip (normalized → screen rect) error: **≤ 0.001 px** at every scale
- Text-search fallback finds the marker exactly once at every scale (unambiguous)
- 4 text items on the page, 4 distinct normalized rects — no collisions

**Verdict: zoom and DPR changes are safe.** This was the main thing R1 feared, and it holds.

### Rotation: **not** scale-invariant — a design requirement

| Test | Error |
|---|---|
| Rotation-0 anchor applied to a 90° page | **790 px — wrong** |
| Rotation-90 anchor applied to a 90° page | **0 px — correct** |
| Rotation-90 anchor applied back to a 0° page | **611 px — wrong** |

Normalized rects are relative to the **viewport**, and the viewport changes shape under rotation. So an anchor is only valid at the rotation it was captured at.

**Required schema change:** `highlight` must store `rotation` alongside `anchor_version`. On load, if the reader's rotation differs from the anchor's, re-anchor by text search (the fallback is reliable — verified 1 hit at every scale) rather than trusting the rects. This is now §6.3 and D-06.

### Consequence

R1 is **downgraded** from "high/high" to "medium/low": the primary mechanism is proven, and the one failure mode (rotation) has a deterministic, tested fallback.

---

## M0 — shell scaffold verification

Built with `electron-vite` (main → CJS, preload → CJS, renderer → Vite/React). Verified with `npm run verify:shell`, which boots the real `out/main/index.cjs`, asserts against the live window, exercises IPC from the renderer, and writes `spikes/out/m0-shell.png`.

**16/16 checks pass**, exit code 0:

| Check | Result |
|---|---|
| Window created and visible | pass |
| Renderer loaded from `file://` | pass |
| React mounted, 7 nav items, 5 KPIs | pass |
| Preload bridge present on `window.selfos` | pass |
| No IPC error banner | pass |
| `system.health` → schema v1, `integrity: ok` | pass |
| `system.theme` → gruvbox, accent `#7daea3` | pass |
| `dashboard.day` → `Jumada I 22, 1448 AH` | pass |
| Input validation rejects `{paused:"yes"}` | pass |
| earlyoom Electron preference detected | pass |
| Browser profiles: Default + Profile 2, both `snapshot` | pass |
| DB created at `~/.config/SelfOS/selfos.sqlite` (164 KB) | pass |
| `tsc --noEmit` clean | pass |

### Bugs found and fixed during scaffolding

1. **Health query read a non-existent `meta.at` column** — `meta` is key/value. Would have broken the health page on first run.
2. **Preload emitted as ESM** — incompatible with `sandbox: true`. Now CJS (`index.cjs`).
3. **Main process emitted as ESM** — `import { BrowserWindow } from "electron"` fails at runtime because Electron's module is CJS. Dev mode crashed; production had been silently working. Now CJS.
4. **Migrations were not copied** to `out/main/migrations`, so the first run had no schema. Added a `copy-migrations` build step.
5. **`userData` defaulted to `~/.config/Electron`**, shared with every other Electron app. Fixed with `app.setName("SelfOS")`.
6. **`systemctl show earlyoom -p ExecStart` returns the unexpanded `$EARLYOOM_ARGS`** template, so preference detection silently returned false. Now reads `/proc/<pid>/cmdline`.
7. **`app.exit()` was swallowed while a Tray held the event loop**, hanging the verifier. Now exits explicitly with a status code.

### Environment note

This shell exports `ELECTRON_RUN_AS_NODE=1`, which makes every Electron launch behave as plain Node. All npm scripts clear it with `env -u ELECTRON_RUN_AS_NODE`. Without that, `npm run dev` fails with `Cannot read properties of undefined (reading 'isPackaged')` — a confusing error that is not a code bug.

---

## M1 — time tracking

Collector built and verified against the live compositor: `npm run verify:time` → **16/16 pass, exit 0**, plus **25/25 unit tests**.

| Check | Result |
|---|---|
| Timeline returns segments | pass (4 segments) |
| Real focus transitions captured | pass — `helium`, `electron` |
| Window titles captured | pass (YouTube title) |
| Durations positive | pass (9 s total across the run) |
| Top apps ranked | pass — helium 8 s, electron 2 s |
| Day aggregate written | pass — screen 6 s, switches 2 |
| Collector socket connected | pass |
| Collector event counts | pass — `activewindow:3`, `openwindow:1`, `urgent:1` |
| Pause stops recording | pass — 0 segments started after pause |
| Resume clears pause | pass |

### Bugs found by the tests (not by inspection)

1. **Sub-second flickers stole time from the next app.** `mergeSegments` merged a 200 ms blip *forward*, giving it the following 5 s of a different app. It now absorbs the flicker *backward* into the segment that follows. Caught by the merge unit test.
2. **Double-counted screen time.** The 10 s flush wrote a snapshot row for the open segment, then the final row covered the same range again. Snapshot rows are now tagged `:snapshot` and deleted before the final row is written. Caught by `verify:time` showing screen time exceeding elapsed wall time.
3. **Dashboard stale for a full minute.** Aggregates rebuilt on a 60 s timer, so the first minute showed zero. Now rebuilds immediately on every commit.
4. **`bring_to_top` does not focus.** Hyprland 0.56 raises a window within its workspace without switching to it. The correct call is `hl.dispatch(hl.dsp.focus({window=hl.get_window("class:X")}))`. This affected only the test harness, but it is the kind of thing that makes a tracker look broken.
5. **Electron's window class is not stable.** The raw binary reports `electron`; `npm start` reports `selfos`. Added `SELFOS_APP_CLASSES` + `isSelfOSApp()` so SelfOS time is never conflated with T3 Code's.
6. **Sub-pixel timeline bars.** A 9 s segment is 0.01% of a 24 h axis and rendered invisibly. Minimum bar width added.

### Known limitation (needs a decision)

A focus segment is **flushed every 10 s as a snapshot and continues to grow**, so a single long stretch on one app produces one growing row rather than fixed-length rows. Pause/lock/socket-loss correctly close the segment, so gaps are not attributed — but the snapshot grows until the next focus change. This is correct for totals; it should be revisited when retention downsampling (F-TIME-15) is implemented.

---

## M2 — habits

All four habit kinds, versioned schedules, streaks, heatmaps, and backfill. **29/29 end-to-end checks pass**, plus **65/65 unit tests** (40 of them for habits).

| Check | Result |
|---|---|
| Create boolean / count / avoid / weekly | pass |
| Validation rejects empty name and missing schedule | pass |
| Toggle on, then off (idempotent) | pass |
| Increment to partial, then to target | pass (5 → done at 8) |
| Daily streak across a skipped day | pass — 6 days, skip neutral |
| Avoidance slip breaks the streak | pass |
| Weekly quota not yet met is still "due today" | pass |
| Schedule change preserves history | pass — 6 days before and after |
| Heatmap 84 cells with satisfied states | pass |
| UI renders 4 rows, 4 heatmaps, form, header | pass |
| Real DOM click completes a habit | pass |

### Bugs found

1. **Backfill was silently ignored.** A habit's first schedule version is effective from its creation date, and `scheduleFor` returned `null` for earlier dates, so every backfilled day was classified "neutral" and the streak read 1 instead of 6. `scheduleFor` now falls back to the earliest version, and `computeStreak` treats days before the *first recorded entry* as neutral rather than failed.
2. **Same-day schedule change destroyed history.** `habit_schedule` is unique on `(habit_id, effective_from)`, so changing the schedule on the creation day overwrote the original version — the streak dropped 6 → 2. The service now moves the existing version one day earlier before inserting the new one.
3. **Heatmaps painted 12 weeks of red** for a habit created today, contradicting the streak rule. Heatmap cells before the first tracked day are now neutral.
4. **"1 days"** — pluralisation added.

### Semantics worth knowing (now enforced by tests)

- Off-schedule days are **neutral**, even if the habit was completed. Streaks measure adherence to the schedule; the entry is still stored and displayed.
- A **skipped** day neither breaks nor extends a streak.
- The **current period does not break a streak until it has ended** — otherwise every weekly streak would read 0 on Monday morning.
- With **no entries at all**, `expected` is 0 and the completion rate is 0, not a divide-by-zero.

---

## Toolchain switch — Bun + Vite + Biome + just

| Tool | Version | Role |
|---|---|---|
| Bun | 1.4.2 | package manager (`bun.lock`), script runtime |
| Vite | 8.3.5 via electron-vite 6 | renderer HMR, main/preload bundling |
| TypeScript | 7.0.2 | types (strict, `noUncheckedIndexedAccess`) |
| Biome | 2.6.4 (Rust) | lint + format in one native binary |
| just | 1.59.0 (Rust) | task runner (`justfile`) |

### Verification after the switch

- `just check` (typecheck + lint + tests) — **passes**, 65/65 tests.
- `just verify-shell` — **16/16**, unchanged.
- `just verify-habits` — **29/29**, unchanged.
- `just dev` — Vite dev server starts and a `selfos` window opens.

### Notes

1. **Biome reformatted 17 files.** Its style differs from the hand-written
   formatting (110-column, double quotes, trailing commas). Behaviour is
   unchanged; the diff is whitespace and line wrapping.
2. **Biome surfaced real issues**, not just style: a dead `APP_CLASS_ALIASES`
   constant left over from the `--class` experiment, five `<button>` elements
   missing `type="button"`, an array-index React key in the timeline, and a
   dishonest `useMemo` dependency on the timeline's day start.
3. **A test-isolation bug was exposed**, not created: `verify-habits` asserted
   exactly 4 UI rows, so a second run against an existing database failed with
   8. It now compares against the actual habit list.
4. **`pacman`'s `biome` package has an invalid PGP signature** on this machine,
   so Biome is installed from npm via Bun instead.

---

## M3 — salah

Prayer logging, qada debt, and streaks, built on the **live** existing stack. **29/29 end-to-end**, **86/86 unit tests**.

### Integration contract (verified against `salah-ctl status`)

- Times come from the existing stack, including its **custom overrides** (`fajr 05:20` custom vs `04:58` astronomical). SelfOS never recomputes over a user override.
- `salah-ctl` was unavailable → nothing was written; SelfOS falls back to local `adhan` computation configured identically (Karachi, 18°/18°, Hanafi) and labels the day `source: "computed"`.
- **Fallback fidelity measured**: adhan matched the stack's `autoTime` values to within 1 minute on all five prayers (fajr 04:58 exact, dhuhr 11:48 vs 11:47, asr 15:35 exact, maghrib 17:13 exact, isha 18:35 vs 18:36).
- No writes to `salah.json`, no touches to `/tmp/salah_playing.json`, no audio, no timers (F-SALAH-09).

### Bugs found

1. **Fajr's window was wrong.** It closed at Dhuhr, so a Fajr performed at noon would have been recorded **on time**. Fajr now closes at sunrise, with a Dhuhr fallback when sunrise is unknown. Caught by the `windowEnd` unit test.
2. **Two Hijri calendars on one screen.** The dashboard header used `Intl` (Umm al-Qura → *22 Jumada I*) while the Salah module used `salah-ctl` (arithmetic → *23 Jumada al-Awwal*). The dashboard now reuses the salah stack's value and records `hijriSource`, so the two views cannot disagree.
3. **Streak counted an in-progress day as complete.** Two prayers logged with three still outstanding read as a full day. The rule is now "no misses", which correctly treats an unfinished today as in-progress.
4. A test I wrote contradicted that rule and was updated rather than the implementation — the same pattern as M2, recorded here so the intent is explicit.

### Semantics (enforced by tests)

- Window: a prayer is on time from its own time until the next prayer begins; **Isha runs to tomorrow's Fajr** and crosses midnight correctly.
- Logging before a prayer's time is recorded as **late** (an early make-up), not on time.
- A **missed** log creates qada debt; **clearing** that log removes it; **repay** reduces it and never goes negative.
- **Excused** prayers never create debt and never break the streak.
- Unlogged prayers past their window are shown as **missed** but are **not written to the database** — the DB stays a record of user actions only.

---

## M4 — reading

PDF library, reader, display overrides, highlights, notes, and markdown export.
**27/27 end-to-end**, **105/105 unit tests**.

| Check | Result |
|---|---|
| Import a PDF, dedupe by content hash | pass |
| Render a real page to canvas | pass — 1185×1533 |
| Text layer with selectable spans | pass — 4 spans |
| Page count discovered from the PDF | pass — 40 pages |
| Page navigation + position saved | pass — 2/40 |
| Highlight persisted with anchor | pass |
| Note attached to a highlight | pass |
| Overlay rendered on the page | pass |
| Highlight survives navigating away and back | pass |
| Markdown export incl. notes | pass |
| Display overrides persist per book | pass |
| Reading session feeds dashboard | pass |

### Bugs found (all real, all fixed)

1. **`net.fetch` cannot read `file:` URLs** on this Electron build — every
   protocol handler returned an error. Handlers now return `Response` objects
   built from bytes with explicit content types.
2. **A `file://` origin cannot fetch custom schemes at all** (CORS). This is
   why pdf.js failed to load by URL. The renderer is now served from its own
   `selfos-app://` scheme, so app and assets share an origin.
3. **Custom schemes need `corsEnabled`** for `fetch`/dynamic `import`, and with
   a *standard* scheme the first path segment becomes the **host** —
   `selfos-book://book/7` exposes `pathname === "/7"`, not `"/book/7"`.
4. **The text layer wiped out the canvas.** `layerRef` was attached to the
   scroll wrapper and cleared with `innerHTML = ""`, destroying the canvas and
   the highlight overlay on every page render. The text layer is now its own
   element.
5. **The annotation panel went stale** after a highlight was added from outside
   the component. It now polls while the reader is open (cheap: indexed local
   query, no re-render when unchanged).
6. A verifier bug, not a product bug: it highlighted page 2 while the reader was
   still showing page 1. The test now asserts the reader's actual page first.
7. **A slow first text-layer render made the verifier flaky** (2–4 s, and it
   had fixed 4 s sleeps). The reader was fine; the harness was not. The verifier
   now polls for a populated text layer and retries the open once. Separately,
   **the reading position was saved only after the full page render**, so a slow
   page could leave the stored position stale — it is now written as soon as the
   page is chosen, which is what the user actually did.

### Reader render deadlock (found in M8, fixed)

The reader intermittently showed a blank canvas with an empty text layer. Root
cause, found by bisection:

1. **pdf.js needs its worker, and a Worker cannot be constructed across
   origins.** Served from `selfos-asset://pdfjs`, `new Worker(...)` throws
   `SecurityError`, pdf.js silently falls back to a fake worker, and
   `page.render()` never resolves. pdf.js is now served from the app's own
   origin (`selfos-app://app/pdfjs/`), with its `wasm/`, `cmaps/`,
   `standard_fonts/`, and `iccs/` directories copied alongside — pdf.js 5 blocks
   on those assets.
2. **Two concurrent renders of the same page deadlock pdf.js** (measured 3/3
   timeouts, and it stays stalled for the life of the page). React StrictMode
   invokes every effect twice in development, which is exactly that shape. The
   reader now serializes renders through a promise chain, so the second run
   waits for the first.
3. **The text layer could be wiped by its own setup.** `getUtilTransform()`
   awaited a dynamic import *after* `innerHTML = ""`, so a slow import cleared
   the spans that had just been appended. The transform is resolved first.

After the fixes the reading verifier passes three consecutive runs.

### The `page.render()` "timeout" was a harness artifact, not a worker bug

A research probe (`require`-ing the built main bundle and rendering page 1)
reported `none: timeout` on every run. It looked like a third instance of the
worker deadlock above, but the two are unrelated:

| Probe flags | `page.render()` |
|---|---|
| `--no-sandbox` | `ok` 12/12 runs |
| `--no-sandbox --disable-gpu --disable-software-rasterizer` | `timeout` every run |

Two independent facts, both measured:

1. **`--disable-gpu --disable-software-rasterizer` stops `requestAnimationFrame`.**
   An rAF counter ticks **91** times in a 1.5 s sample with the default GPU path
   and **0** times with those flags. pdf.js drives its operator loop through rAF
   (`useRequestAnimationFrame` in `pdf.mjs`) and can also fall back to a
   microtask, which is why the minimal probe *sometimes* passed in earlier runs —
   the failure is configuration-dependent and racy, not a clean 50/50.
2. **The probe omitted the reader's `withRenderClock` substitution.** The reader
   replaces rAF with a `setTimeout` tick for the duration of each render, so the
   stall never reaches the product. Removing that substitution and re-running the
   GPU-disabled verifier reproduces the symptom at the product level: the canvas
   is built, then the run ends with **0 text spans** instead of 4.

The same run with the substitution in place passes **27/27**, and the fuller
GPU-disabled verifier run passes 26/27 steps — it stalls only on the final
`capturePage()`, which also needs a frame. So the reader is fine; the harness
was rendering with an unstable clock.

Nothing here changes the shipped fix. What changes is the record: `withRenderClock`
is load-bearing (not defensive), and the `spikes/verify-*.cjs` recipes are run
*without* GPU flags, which is why they have always been green.

### The CSP does not block pdf.js's WASM codecs (a false alarm, measured)

A probe that `require`d the built main bundle reported
`WebAssembly.instantiate(): … violates the following Content Security policy
directive because 'unsafe-eval' is not an allowed source of script` for a
minimal wasm module. The reading policy is `script-src 'self'`, and pdf.js 5
ships `jbig2.wasm`, `openjpeg.wasm` and `qcms_bg.wasm` (JBIG2, JPEG-2000 and ICC
codecs), so this looked like a defect: those codecs would fail on any PDF that
needed them.

It is not a defect, because **the codecs do not run in the page.** They run in
pdf.js's worker, and a worker's global scope does not inherit the document's CSP
meta tag. Measured in one process, compiling each real `.wasm` over
`selfos-app://app/pdfjs/wasm/`:

| Context | `jbig2` | `openjpeg` | `qcms_bg` |
|---|---|---|---|
| main frame | blocked (CSP violation) | blocked | blocked |
| module worker at the pdfjs origin | **compiled OK** (8 imports) | **compiled OK** (17) | **compiled OK** (5) |

`WebAssembly.compile` needs no imports, so a CSP refusal is the only failure
mode it can report — the "compiled OK, N imports" results cannot be a
linking error in disguise. The separate `jbig2_nowasm_fallback.js` /
`openjpeg_nowasm_fallback.js` assets are belt-and-braces for `useWasm: false`,
not a workaround for the policy.

Two consequences worth keeping:

1. **Do not "fix" this by adding `'wasm-unsafe-eval'` to `script-src`.** It would
   widen the policy for the whole page to enable something no code on the page
   does. The reader configures `wasmUrl` (Reader.tsx) precisely so the codecs
   load where they are allowed to.
2. **A main-frame WASM probe proves nothing about the reader.** The probe must
   run in a worker at the pdfjs origin, or it reports a failure the product
   cannot hit. Recorded here so the next person does not re-open it.

---

## M5 — notes (Obsidian integration)

Vault detection, FTS5 search, preview, quick capture, and idempotent highlight
export. **49/49 end-to-end**, all on a disposable vault under `/tmp` so the
verifier never touches the user's real notes.

| Check | Result |
|---|---|
| Vault selected from Obsidian config or a manual path | pass |
| Index skips `.obsidian`, `.trash`, `.git`, `node_modules` | pass — 3 of 4 files |
| Frontmatter + inline tags extracted | pass — `history seerah study` |
| Snippets skip headings, fences, images | pass |
| FTS5 body, tag, and quoted-phrase search | pass |
| SQL-injection-shaped query returns empty, not an error | pass |
| Read refuses path traversal | pass |
| Markdown preview in the real UI | pass — headings, quotes, lists |
| Search box filters the list through IPC | pass |
| Quick capture appends, never rewrites | pass |
| Daily note is idempotent | pass |
| Highlight export writes a real vault note | pass |
| Export is idempotent via a content marker | pass — skipped on re-run |
| Export refreshes when the highlight count changes | pass |
| Export appears in the search index | pass |
| Watcher picks up external create/delete | pass — 500 ms debounce |

### Bugs found (fixed)

1. **`node:sqlite` rows need a two-step cast.** `all()` returns
   `Record<string, SQLOutputValue>[]`, which does not overlap a typed row shape,
   so `as NoteRow[]` is a type error under TS 7. `Db.all<T>()` already handles
   this; the notes index used the raw statement. Fixed with `as unknown as`.
2. **Frontmatter rendered as body text** in the preview. The renderer now
   strips it; the index still parses it for tags.
3. **FTS snippets leaked markup** (`# Heading`, fence markers) into one-line
   previews. Added `cleanSnippet`, keeping the `<<`/`>>` match markers.
4. **Vault could not be disconnected**, so switching vaults meant editing the
   DB. Added `notes.clearVault` (clears the index, leaves files untouched).

---

## M6 — goals

Numeric, milestone, and quota goals with pace projection and nesting.
**48/48 end-to-end**, **41 unit tests** on the pace math and service rules.

| Check | Result |
|---|---|
| Create each goal kind | pass |
| Title / kind / date validation | pass — three negative cases |
| Readings are absolute values | pass |
| Pace fraction and projected date | pass — 25%, projected from 0.1/day |
| Off-pace warning | pass — flagged at 30 days behind |
| Warning clears when caught up | pass |
| Auto-complete at target | pass |
| Closed goals reject new readings | pass |
| Milestone progress drives the goal | pass — 1/2 = 50% |
| Completing all milestones completes the goal | pass |
| Un-ticking reopens it | pass |
| Overdue milestone flagged | pass |
| Nested roll-up | pass — mean of children |
| Abandoned child leaves the roll-up | pass |
| Close keeps the reason and the history | pass |
| Abandoning a parent abandons its active children | pass |
| UI: cards, rings, form, closed toggle | pass |
| UI: update a reading, tick a milestone | pass |

### Bugs found (fixed)

1. **Taking the maximum reading made corrections impossible.** A mistaken entry
   of 12 on a 5-book goal could never be lowered. Changed to newest-by-timestamp
   (tie-broken by id), which is also the honest meaning of "absolute value, not
   an increment"; out-of-order imports still order correctly.
2. **A completed child dropped out of the parent's roll-up**, so finishing a
   sub-goal made the parent's percentage *fall*. Completed children now count;
   abandoned ones do not.
3. **A zero-length progress ring painted a dot.** `stroke-dasharray: 0` with a
   round cap still draws the cap. The foreground arc is now omitted at 0%.
4. Two verifier bugs, both fixed: a reading asserted against a goal that was
   already at target, and a milestone click that *un*ticked an already-ticked box.

---

## M7 — polish

Analytics, backups, exports, the command palette, and an accessibility pass.
**51/51 end-to-end**.

| Check | Result |
|---|---|
| 7/30/90-day analytics with gap-filled days | pass — 30 columns |
| Averages over active days, not calendar days | pass |
| Streak detection over calendar days | pass |
| 24-hour profile splits segments at hour boundaries | pass |
| Top domains from ingested history | pass |
| Startup backup runs once per day | pass — `selfos-2026-11-02.sqlite` |
| Manual backup is a consistent copy of a live WAL DB | pass — `VACUUM INTO` |
| Restore refuses a name that is not in the listing | pass — path traversal denied |
| Restore keeps a pre-restore safety copy | pass |
| JSON export of every table | pass — 22 tables |
| CSV export with a header and date filtering | pass |
| CSV escapes commas and quotes | pass |
| Export paths are chosen in main, not the renderer | pass — confined to `exports/` |
| Ctrl+K opens and focuses the palette | pass |
| Subsequence filter + Enter runs the command | pass — navigates to Analytics |
| Escape closes without running | pass |
| No `<button>` without `type`, one `aria-current`, all icon buttons labelled | pass |
| Data page: backup from the real button | pass |

### Design notes

- **`VACUUM INTO` is the only correct online backup** through `node:sqlite`: it
  is consistent against concurrent writers and needs no exclusive lock, so the
  collector keeps running. It must be run as a prepared statement (`exec` does
  not bind parameters).
- **The analytics charts are single-series by construction.** The Omarchy
  (Gruvbox) accent set fails categorical validation — `#7daea3` is below the
  chroma floor and its normal-vision separation from `#d8a657` is ΔE 14.2
  against a 15 floor. Rather than invent hues outside the theme, screen time,
  hourly activity, and domains are each their own one-series chart: no legend
  needed, the title names the series.
- **Export paths moved into the main process.** The first implementation took a
  path from the renderer, which would let a compromised renderer overwrite any
  file. Exports now always land in `<userData>/exports/`.
- **Backups never block tracking.** A backup failure is logged, not fatal.

### Bugs found (fixed)

1. **Zero-value bars drew a solid 2px baseline** across the whole chart (a
   `min-height` on every column). Zero days now render no mark at all.
2. **The page repeated its own title** — the topbar `<h1>` plus an in-page
   `<h2>`. Replaced with a subtitle line.
3. **The peak label was clipped** at the top of the plot area; the plot now
   reserves room for it.
4. **`browser_visit` has no `dwell_ms`**; domain time comes from `duration_us`.

---

## Desktop integration — workspace 5

SelfOS is pinned to workspace 5 while it is under test:

```lua
-- ~/.config/hypr/hyprland.lua
o.window({ class = "^(selfos|electron)$" }, { workspace = "5 silent" })
```

Both classes are matched because Electron derives the Wayland app_id from the
product name when packaged (`selfos`) and from the executable when run from the
raw binary (`electron`). Verified on Hyprland 0.56.2: launching
`bunx electron out/main/index.cjs` places the window on workspace 5.

`pin = true` was tried first and removed: this build refuses to pin tiled
windows ("Window does not qualify to be pinned"), so the workspace rule is the
whole mechanism. If you want it to follow you across workspaces, float it first.

### Harness runs must never map a window

Every Electron window on this machine matches that rule, so a harness that maps
one gets its window placed on workspace 5 and **the activation then switches the
active workspace to 5**, pulling the user off whatever they were doing. Measured
with `hyprctl -j clients` while a scratch probe held its window open:

| Launch | `visible` | Electron client on ws 5 | active workspace moved |
|---|---|---|---|
| harness, detection off (pre-fix) | `true` | yes (`focusHistoryID 1`) | **yes** |
| harness, detection on (fixed) | `false` | none mapped | no |

`app.commandLine.appendSwitch("class", …)` cannot avoid this, and neither can
anything else that looks like it should: the Wayland app_id is a **no-op from
inside the process on Electron 45**. Five mechanisms were measured —
`appendSwitch("class")`, `app.setName()`, both together, the `--class` CLI flag,
and `--wayland-app-id` — and `hyprctl clients` reported `electron` for every one
(matched by a unique per-run window title, so no stale client could be counted).
A window cannot be made to stop matching the rule, so the only guard is to leave
it unmapped.

`src/main/index.ts` therefore treats a run as a verifier when `SELFOS_VERIFY=1`
**or** when `launch-mode.ts` sees that the main bundle was `require`d by another
script instead of being Electron's own entry point. The second check exists
because ad-hoc probes (e.g. `/tmp/probe-warm3.cjs`) never set the variable and
used to move the user's workspace on every run. Both paths keep the window
unmapped, and inference is skipped entirely when `app.isPackaged` is true.

**The same rule applies to the spikes, and one of them broke it.** The
`SELFOS_VERIFY` / `launch-mode` guard above protects anything that boots the
**app** bundle; the design spikes create their own `BrowserWindow` and are not
covered by it. Audited each one:

| Spike | Window | Verdict |
|---|---|---|
| `sp2-memory.cjs` | `show: true` for an idle-memory stub | **FIXED** — `show: false`. Nothing needed it visible: Electron starts the renderer/gpu/utility processes on `new BrowserWindow` regardless, so the measurement is unchanged (renderer 81 MB, gpu 111 MB, utility 77 MB still reported) |
| `main.cjs` SP-10 | `show: true`, deliberately | **KEPT** — the spike's whole subject is a visual drag/resize check (`RESULTS.md` SP-10: "visual confirmation is required; not gating"). A user who runs `just spike-*` for SP-10 asked to look at a window |
| `main.cjs` SP-2/SP-9 | `show: SPIKE === "SP-2"` | **KEPT, and it must be** — SP-2 renders a 40-page PDF and reports per-page milliseconds (`runSP2`). `requestAnimationFrame` stalls to zero ticks in an unfocused window on this compositor (measured; see "The `page.render()` \`timeout\` was a harness artifact"), so a hidden SP-2 window would hang the render it exists to time. Visibility is load-bearing here, unlike in `sp2-memory.cjs` |
| `main.cjs` SP-4 | `show: false` | fine |
| `sp5-anchors.cjs` | `show: false` | fine |

Verified after the fix: `sp2-memory.cjs` reports the same process breakdown and
the active workspace stays where it was. Note this is a **spike-harness** concern
only — no shipped code path maps a window it does not mean to.

---

## M8 — site and watch time from browser history

F-TIME-04/05/06/07/13/14/17. **39/39 end-to-end** against the live Helium
database (454 MB, 59 318 visits), **59 unit tests**.

| Check | Result |
|---|---|
| Reads the real `History` DB without touching it | pass — snapshot strategy, 4.8 s |
| Two profiles ingested separately | pass — `Default`, `Profile 2` |
| First run backfills 90 days | pass — 49 068 visits |
| Re-run inserts nothing (watermark) | pass — 0 new |
| Snapshot deleted after use | pass — no files left in `snapshots/` |
| Site time for today | pass — 20 domains |
| Provenance shown per site | pass — `history`, `window-title`, `mixed` |
| Categories from default rules | pass — Entertainment/Social/Work |
| Per-page drilldown | pass |
| Category edit persists | pass |
| Total fits in the elapsed day | pass — 8.5 h open in 13.6 h |
| Total is a union, not a row sum | pass — 8.5 h ≤ 15.4 h |

### Bugs found (all real, all fixed)

1. **The watermark advanced from each batch's last row**, so with more than one
   batch an earlier batch could lower it and every run re-read the whole
   history. Now the max over all rows actually read, including skipped ones.
2. **A fresh profile backfilled from the epoch**, replaying years of history
   5 000 rows at a time — 18 s per run and never catching up. It now starts at a
   90-day cutoff and drains up to ten pages per run.
3. **Per-domain time summed overlapping tabs.** Chromium's `visit_duration` is
   wall time the page stayed open *including background tabs*, so 215 visits
   summed to **16.2 h in a 13.5 h day**. Site time is now the union of a
   domain's intervals, and the day total is the union across all domains
   (8.5 h) — per-site rows still legitimately overlap, and the UI says so.
4. **Category shares reached 121%** because category seconds were a sum of
   per-domain unions. Categories are now computed as their own union over raw
   intervals, so no category can exceed browser-open time.
5. **Window titles end with the browser name** (`… - Helium`), which the suffix
   matcher saw instead of the site. The browser name is stripped first.

### Design notes

- **`visit_duration` cannot be trusted as "time on this page"** in isolation —
  only as an interval. Everything user-facing is built on unions.
- **Reload rows are skipped.** A reload restarts the dwell clock on the same
  URL, so its duration covers only the last fragment; counting it would double
  count. Its timestamp still advances the watermark.
- **A zero-byte `History-journal` does not block an immutable open** (Profile 2
  has one); only a non-empty journal forces the snapshot path.
- **Window-title attribution is conservative**: an unrecognised title produces
  no site row rather than an invented domain.
