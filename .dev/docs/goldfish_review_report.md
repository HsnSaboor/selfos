# Goldfish review loop — wave 1

Target: `src/main/db/*`, `src/main/ipc/handlers.ts`, `src/main/services/context.ts`,
`src/main/index.ts`.
Reviewer: fresh-context general-purpose auditor. All findings verified by the
Elephant (reproduced against real code/data) before any fix was applied.

| # | Severity | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | BLOCKER | `backup.restore` copies over a live WAL DB; restore silently undone, safety copy unreadable | CONFIRMED (repro: `disk I/O error`, data reverts to old) | FIXED — staged restore applied before the DB opens |
| 2 | MAJOR | `Db.transaction` decrements depth twice when COMMIT throws, breaking every later transaction | CONFIRMED (repro: depth −1, `near "-": syntax error`) | FIXED — single decrement in `finally` |
| 3 | MAJOR | Notes vault containment is a raw prefix check; sibling `…/Notes-private` escapes | CONFIRMED (repro: read `TOP SECRET` outside vault) | FIXED — `resolve` + `relative` guard, `safeFolder` for folder args |
| 4 | MAJOR | Dashboard habits KPI uses logged entries as the denominator | CONFIRMED by reading; 1/2 for five habits | FIXED — denominator from scheduled habits |
| 5 | MAJOR | `system.health` polled every 5 s runs `integrity_check` + a subprocess | CONFIRMED — measured 1–2 s per check on 41 MB DB | FIXED — cached; on-demand `system.checkIntegrity` |
| 6 | MAJOR | `habits.heatmap` days unvalidated | CONFIRMED (unbounded allocation) | FIXED — clamped to 1..366 in handler and pure function |
| 7 | MAJOR | Ending a reading session never rebuilds `day_aggregate` | CONFIRMED by reading | FIXED — rebuild the session's own date |
| 8 | MAJOR | Qada ledger double-counts a repeated `missed` and never reverses a correction | CONFIRMED (repro: debt 2, then stuck at 2) | FIXED — transition-based ledger |
| 9 | MAJOR | History snapshot copies the DB but not its journal | CONFIRMED as written; **fix rejected** — copying the journal forces a replay, which fails on a read-only handle (`attempt to write a readonly database`) | Recorded as accepted risk with rationale in code |
| 10 | NIT | `DaySummary.bestStreak` hardcoded to 0 | CONFIRMED | FIXED — computed from active habits |

## Found while verifying wave 1

**The reader was broken whenever the window was visible.** Earlier verifiers
opened a real window, which the workspace-5 rule moved; after isolating
verifiers the tests went green, which hid the bug. Re-testing with a mapped,
unfocused window showed 4/5 failures.

Root cause: `requestAnimationFrame` **stalls** on this compositor — to zero ticks
in an unfocused window, and also under software rendering. pdf.js schedules its
operator loop through rAF, so `page.render()` waits forever: the canvas is left
blank and the text layer never appears. Verified by inspecting the render task:
`useRAF: true`, `opIdx: 0` of 21 operations, `graphicsReady: true`.

The failure is racy and configuration-dependent rather than a clean
once-and-stop — see "The `page.render()` timeout was a harness artifact" in
`spikes/RESULTS.md` for the measurements, including the GPU-flag case that this
note originally missed.

Fix: `withRenderClock()` substitutes a timer for rAF for the duration of the
render call and restores it afterwards. Confirmed load-bearing by A/B: with the
substitution removed, a GPU-disabled verifier run ends with 0 text spans; with
it, the reader flow passes 27/27.

**Verifier isolation (user request).** Verification runs now set
`SELFOS_VERIFY=1`, and windows are never mapped, shown, maximized, or focused.
Confirmed: no window appears on any workspace.

An earlier version of this note claimed the variable also gave the process a
distinct Wayland app_id (`selfos-verify`) so the workspace-5 rule could not
match. That is wrong: the app_id cannot be changed from inside an Electron
process on this build (five mechanisms measured, all still report `electron`),
so the switch was removed. Not mapping the window is the entire mechanism, and a
`require`d main bundle is now inferred as a verifier too — see `launch-mode.ts`
and the "Harness runs must never map a window" section in `spikes/RESULTS.md`.

## Round state

- Rounds run: 1
- Blocker/Major open: 0 (one accepted risk, #9)
- Unit tests: 289 → 309
- Gates: `just check` green; all nine verifiers green

---

# Wave 2 — domain modules

Target: `modules/habits/*`, `modules/reading/*`, `modules/notes/*`.
Reviewer: fresh-context auditor. Every finding reproduced before fixing.

| # | Severity | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | BLOCKER | Changing schedule *kind* discards all history (20-week streak → 0) | CONFIRMED (repro) | FIXED — per-period version evaluation |
| 2 | MAJOR | Period schedules ignore `firstTracked`; a perfect new habit reads 33% | CONFIRMED (repro: 0.333) | FIXED — periods before the habit existed are neutral |
| 3 | MAJOR | A quota change reinterprets every past period (2 failed weeks → satisfied) | CONFIRMED (repro: successes 3) | FIXED — `requiredPerPeriod` looked up per period |
| 4 | MAJOR | Export marker keys on row *count*; swapped/edited highlights never re-export | CONFIRMED by reading | FIXED — marker hashes row content |
| 5 | MAJOR | Two books with the same title share one export note | CONFIRMED by reading | FIXED — filename includes the book id |
| 6 | MAJOR | A hand-typed vault is forgotten on restart | CONFIRMED by reading | FIXED — falls back to the saved path when it exists |
| 7 | MAJOR | An unreadable path in the vault watcher throws out of a timer (main-process crash) | CONFIRMED by reading | FIXED — per-file try/catch, `isFile()` guard, `setVault` restores on failure |
| 8 | NIT | Decrementing a count habit to 0 records `partial 0` | CONFIRMED | FIXED — clears the entry |

All eight fixed; none accepted. Streak fixes verified against the four failing
scenarios (now 20/20, 100/100, 100%, and no retroactive credit), and those are
permanent tests.

---

# Wave 3 — time and site accounting

Target: `modules/time/*`, `integrations/browser-history/*`, `integrations/hyprland/*`.
Reviewer: fresh-context auditor. Every finding reproduced before fixing.

| # | Severity | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | BLOCKER | `hourlyProfile` spins forever at a DST fall-back | CONFIRMED (repro under `TZ=America/New_York`: no progress at the repeated hour) | FIXED — falls back to a full hour from `start` |
| 2 | MAJOR | Provisional rows attribute site time, so a site row stays at one flush interval | CONFIRMED by reading | FIXED — attribute only the final row; `DO UPDATE SET duration_us = MAX(...)` |
| 3 | MAJOR | A title change retitles the whole open segment, attributing 30 min to the last site seen | CONFIRMED by reading | FIXED — segment closes when the inferred site changes |
| 4 | MAJOR | Title events are not scoped to the focused window | CONFIRMED (address parsed then discarded) | FIXED — `activewindowv2` address gates `windowtitlev2`; v1 ignored |
| 5 | MAJOR | `topDomains` sums overlapping tabs (2 h for 1 h of tabs) | CONFIRMED by reading | FIXED — unions per domain |
| 6 | MAJOR | Media classification ignores URL path; a YouTube feed counts as watch time | CONFIRMED by reading | FIXED — `isMediaUrl` for history rows |
| 7 | MAJOR | Segments are never split at midnight | CONFIRMED by reading | FIXED — `splitAtMidnight` |
| 8 | NIT | Automatic pauses report `paused: false` | CONFIRMED by reading | FIXED — status includes `pauseReason` |
| 9 | NIT | `uncategorizedDomains` ignores parent-domain rules | CONFIRMED | FIXED — uses the same lookup as the site table |
| 10 | NIT | Hostname fallback invents domains from file names | CONFIRMED (`README.md` → `readme.md`) | FIXED — requires a path/space boundary and rejects file extensions |

All ten fixed. Two tests encoded the old summing behaviour and were corrected
to assert the union; a new test pins the "feed page is not watch time" rule.

---

# Wave 4 — the renderer and the IPC boundary

Target: `src/renderer/**`, `src/preload/index.ts`, `src/shared/api.ts` (~4,200
lines) — the one surface the earlier waves never reached.

Reviewers (fresh-context Goldfish, EGM personas): `design_critic`,
`codebase_details`, `zoom_out`. Every finding below was reproduced by the
Elephant before any fix; severities are the Elephant's after verification, not
the reviewer's as filed.

`codebase_details` failed twice (API quota) and is recorded as **not run** for
round 1.

## Round 1 findings

| # | Severity | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 1 | BLOCKER | Preload `invoke` is a generic `ipcRenderer.invoke` passthrough — the renderer can reach any registered channel, not the closed list STACK §2.3/§3.4 requires | CONFIRMED (name is a compile-time type only) | FIXED — runtime `isApiChannel` guard + `API_CHANNELS` closed list, compiler-checked against `Api` |
| 2 | BLOCKER | `window.prompt` for the abandon reason — Electron throws `prompt() is not supported`, so "Abandon" did nothing (F-GOAL-07 MUST) | CONFIRMED by running it in the app | FIXED — inline reason form |
| 3 | BLOCKER | Reader document cache unbounded and never destroyed; pages never `cleanup()`d (F-READ-15 MUST, STACK §6.1) | CONFIRMED (no eviction, no `destroy`) | FIXED — LRU bound of 2 documents with `destroy()`, plus `page.cleanup()` after each raster |
| 4 | BLOCKER | `setWindowOpenHandler` forwards any URI to `shell.openExternal`, while `notes.open` allowlists | CONFIRMED | FIXED — `isSafeExternalUrl` (http/https/obsidian), unit-tested |
| 5 | MAJOR | Every brightness/contrast tick re-rasterized the page, because `settings` was a raster dependency (STACK §6.2 separates CSS filters from the raster) | CONFIRMED | FIXED — deps narrowed to `zoomMode`/`zoom` |
| 6 | MAJOR | Failed writes were swallowed in Salah, Habits and Reader; a rejected write looked like a no-op | CONFIRMED | FIXED — `Result` checked, error surfaced |
| 7 | MAJOR | One habit toggle re-fetched every habit's heatmap over IPC (N+1) | CONFIRMED | FIXED — `habits.heatmaps` batch channel |
| 8 | MAJOR | Dashboard polled 4 channels every 5 s in every module, and while hidden in the tray | CONFIRMED (no `visibilitychange` anywhere) | FIXED — gated on route + `document.hidden` |
| 9 | MAJOR | `habits.archive` (F-HABIT-12 MUST) had no UI control | CONFIRMED | FIXED — archive/restore controls + archived section |
| 10 | MAJOR | "Rebuild derived data" and the on-demand integrity check (F-SET-07 MUST) were unreachable | CONFIRMED | FIXED — Maintenance panel on the Data page |
| 11 | MAJOR | Four duration formatters, two clock formatters, four `todayKey` copies (DST-sensitive, D-04) | CONFIRMED | FIXED — `shared/dates.ts`, `shared/format.ts`; `aggregate.ts` re-exports |
| 12 | MAJOR | Two markdown exporters for the same block, already drifted (different header line) | CONFIRMED | FIXED — one `shared/highlights.ts` builder |
| 13 | NIT | Reader palette hardcoded Gruvbox rgba with a "pink" key that is not a palette token (`magenta`) | CONFIRMED | FIXED — `var(--c-*)` + `color-mix` |
| 14 | NIT | `<select>` nested inside `<button>` in the site row (invalid HTML) | CONFIRMED | FIXED — siblings; row is a 2-column grid |
| 15 | NIT | `selfos-asset://` scheme registered and served with no consumer | CONFIRMED | FIXED — removed |
| 16 | NIT | `tracking-tick` event declared with no sender and no subscriber | CONFIRMED | FIXED — removed; `collector-status` now has a real sender and subscriber |
| 17 | NIT | `ModuleId` dead; Ctrl+1…7 unimplemented (F-SHELL-06 SHOULD) | CONFIRMED | DECLINED — additive navigation feature, not a defect; recorded |

## Contested / corrected

- **"The schedule feature is unreachable" (zoom-out #1)** — partially wrong.
  `NewHabitInput.schedule` is set at creation, so F-HABIT-06 is reachable when a
  habit is made; only *changing* it later is missing. Graded MAJOR, not BLOCKER.
- **"zod validation"** — STACK §2.3 says every handler validates with zod; no
  zod is installed and 73 handlers use hand-written `typeof` checks. Not fixed
  here (it is a dependency + 73-handler change, and out of this wave's scope);
  recorded as a STACK-vs-reality drift for a dedicated wave.

## Fixed after round 1 (second pass, before round 2 reviewers ran)

The three biggest open gaps were closed rather than deferred:

| Gap | Outcome |
|---|---|
| Anchor re-resolution never wired (F-READ-07 MUST) | FIXED — the reader now resolves each highlight against the live text layer (`resolveAnchor`), so a rotation change or moved text re-anchors by text search; an unresolvable highlight is marked "not located" in the panel instead of vanishing |
| `scrollOffset` write-only (F-READ-05 MUST) | FIXED — carried on `BookView`, saved on a debounced scroll listener, restored on open |
| Prayer heatmap absent (F-SALAH-07 MUST) | FIXED — 12-week completion grid fed by the existing `salah.history` channel |
| LRU eviction could destroy the open document (defect in my own round-1 fix) | FIXED — eviction skips the open book and refreshes recency on use |

---

# Wave 4 — round 2

Reviewers: `design_critic`, `codebase_details`, `zoom_out` (all three ran; the
`codebase_details` retry succeeded after two quota failures). No Blockers. Every
finding verified against the code before it was accepted.

## Defects in the round-1 fixes (caught by round 2)

These matter more than new findings: they were regressions I introduced.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | MAJOR | The "Archived" section I added was unreachable — `habits.list` never returns archived rows, so the restore UI was dead code | FIXED — `includeArchived` param through contract → handler → renderer |
| 2 | MAJOR | `scrollOffset` saved the *previous* page's position and restored before the canvas had height | FIXED — save is owned by the debounced scroll listener; restore waits for `doc` and a sized canvas |
| 3 | MAJOR | The prayer heatmap I added was not a calendar: `recentDays` omitted empty days and had no `ORDER BY` | FIXED — gap-filled, oldest-first, exactly `days` dates |
| 4 | MAJOR | LRU eviction could destroy the open document | FIXED (found in round 2 prep) — eviction skips the open book |

## Round 2 findings

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 5 | MAJOR | Recategorising a site wiped its `distracting`/`media` flags, silently breaking watch time and the distraction report | FIXED — omitted flags preserve the stored value |
| 6 | MAJOR | Escape closed the palette *and* exited the reader (two unqualified window listeners) | FIXED — palette stops immediate propagation |
| 7 | MAJOR | Reading sessions counted tray/hidden wall-clock time as reading; a session could also leak open | FIXED — renderer reports visible seconds; heartbeat + shutdown close; stale session closed on restart |
| 8 | MAJOR | Dashboard errors were sticky, lossy (one shared string) and blind to poll failures | FIXED — one `refreshDashboard`, failures named per operation, cleared on success |
| 9 | MAJOR | Reader polled `reading.highlights` every 2 s, ungated, duplicating three mutation refetches | FIXED — one `refreshHighlights`, 15 s, skipped while hidden |
| 10 | NIT | `salah.repayQada` failure swallowed; any Salah error replaced the whole module | FIXED — result checked, error rendered inline |
| 11 | NIT | `notes.read` had no ordering guard (search did) | FIXED — sequence guard |
| 12 | NIT | `ModuleId` was dead and disagreed with the renderer's list (7 vs 10) | FIXED — `MODULE_IDS` is the source of truth; nav derives from it |
| 13 | NIT | `isSelfOSApp` was dead despite RESULTS.md claiming it shipped | FIXED — the collector now normalises the class |
| 14 | NIT | `pickBook` bypassed the closed list and the `Result` contract | FIXED — `reading.pickBook` in the Api map |
| 15 | NIT | Reading/Data each had a local `fmtWhen` with different semantics | FIXED — Reading uses `formatClock`; relative/absolute stay distinct by name |
| 16 | NIT | `pink` highlight colour had no migration | FIXED — `colorValue` maps `pink` → `magenta` (no stored rows use it) |
| 17 | NIT | Dead `platform`/`version` bridge fields; orphaned `--selection` token | DECLINED — harmless surface; removing them is churn without a defect |

## Round 2.5 — defects found in my own round-2 work

Found by inspecting the code after the round-2 fixes landed (two were also on
round 2's list as items I had not yet reached):

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 18 | MAJOR | The habit heatmap chunked cells in fixed groups of 7 from index 0, but `heatmapDays` returns a window ending *today* — so every row was a weekday out by the window's offset | FIXED — first column padded to the real weekday |
| 19 | NIT | `describeSchedule` existed twice (main and renderer) with different empty-weekday results (`—` vs `?`) | FIXED — `shared/schedule.ts`, both sides import it |

## Round 2.6 — the delayed `codebase_details` report

That reviewer's first two attempts died on the API quota; the retry landed after
round 2 was closed. It confirmed the earlier fixes and found four more real
defects, two of them in work I had just done:

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 20 | MAJOR | `page.cleanup()` ran only on the success path, so every render cancelled mid-flight leaked a page's operator list and decoded images — the exact accumulation F-READ-15 bounds | FIXED — `finally` block releases the page on every path |
| 21 | MAJOR | `API_CHANNELS` used `satisfies readonly ApiName[]`, which proves the listed names are valid but *not* that all names are listed; a missing channel would fail only at runtime | FIXED — `Exclude<ApiName, listed>` assertion; verified it rejects a removed channel |
| 22 | MAJOR | Timeline used a fixed 24 h day, so DST days compressed bars and dropped the last hour of a fall-back day | FIXED — axis uses the real local day length |
| 23 | MAJOR | `localDate` was frozen at the last Dashboard poll, so a habit logged at 00:05 on another screen was written to yesterday | FIXED — `today` advances on its own timer, independent of the poll |
| 24 | NIT | Fit-width/fit-page never recomputed on window resize | FIXED — `ResizeObserver` on the reader column |
| 25 | NIT | Notes showed "Loading…" forever when `notes.status` failed | FIXED — error rendered instead |
| 26 | NIT | 999/1000 pages counted as finished | FIXED — only `percent >= 1` is finished |
| 27 | NIT | Site page list could show domain A's pages under domain B's header | FIXED — sequence guard |
| 28 | NIT | A reader closed during load could orphan a session | FIXED — mount flag closes the just-started session |
| 29 | NIT | Salah recomputed `logged` that main already sends | FIXED — uses `day.logged` |
| 30 | NIT | Goals "N completed" implied a total it cannot see when closed rows are hidden | FIXED — label says "completed shown" |

---

# Wave 4 — round 3

Reviewers: `design_critic` (reported), `codebase_details` and `zoom_out` (running
when this entry was written). No Blocker. Several findings were against a
pre-fix snapshot and were already resolved (`today`-based `localDate`, the Notes
loading dead-end, `API_CHANNELS` exhaustiveness); those are noted as stale.

## Defect in my round-2 fix

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 31 | MAJOR | The Escape fix did not work: `stopImmediatePropagation` cannot stop a listener registered *earlier on the same target*, so the reader still closed the book first | FIXED — the palette listens in the **capture** phase. Proven: a new end-to-end step passes with capture and fails with bubble (`reader=false`) |

## Round 3 findings

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 32 | MAJOR | The raster effect wrote `scrollOffset: 0` on every resize/zoom, wiping the offset the scroll listener had saved (a resize fires no scroll event) | FIXED — `savePosition` fields are optional and preserve the stored value |
| 33 | MAJOR | `refreshDashboard` cleared *all* errors on success, erasing unrelated failures (theme, palette commands) | FIXED — only its own failures are written |
| 34 | MAJOR | Salah polled two IPC calls every 60 s with no visibility gate | FIXED — skipped while hidden |
| 35 | NIT | `bridge.on` did not validate the event name, so only half the closed list was enforced | FIXED — `EVENT_NAMES` + `isEventName`, with an exhaustiveness assertion |
| 36 | NIT | Anchor rotation was the literal `0` on both sides, making the rotation fallback inert | FIXED — the page's real rotation is stored and passed to the resolver |
| 37 | NIT | `formatDuration` rendered 3599 s as `60m` in one branch and `1h 00m` in another | FIXED — rounds to minutes first |
| 38 | NIT | A failed clipboard write still reported "copied" | FIXED — the failure is surfaced |
| 39 | NIT | Secondary fetch failures rendered as empty sections with no message | FIXED — reported alongside the primary error |
| 40 | NIT | Clearing the Notes query could let a late `notes.list` overwrite newer search hits | FIXED — shares the sequence guard |
| 41 | NIT | `backup.restore` declares `safetyCopy` but always returns `""` (the copy is made at apply time) | RECORDED — the field is deferred by design; changing the contract is a separate decision |

## Round 3 — zoom-out report

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 42 | MAJOR | The renderer imported `main/modules/reading/anchors.ts` — the only renderer→main source import, making the renderer depend on the main tree (N-MAINT-02) | FIXED — moved to `src/shared/anchors.ts`; both processes import it |
| 43 | MAJOR | `notes.open` re-implemented the URI allowlist as a prefix test while the doc claimed it shared `isSafeExternalUrl` | FIXED — one allowlist |
| 44 | NIT | `ModuleName` collapsed to `string` (the `capitalize()` map was cast `as readonly string[]`), so my round-2 "fix" was inert — every `active === "…"` went unchecked | FIXED — `MODULE_LABELS satisfies Record<ModuleId, string>`; verified a typo now fails the build |
| 45 | NIT | `saveNote` still duplicated `refreshHighlights`, skipping the no-change guard | FIXED — uses the helper |
| 46 | NIT | Clipboard failure said "the markdown is shown below" but nothing rendered it | FIXED — a read-only export box appears with the markdown |
| 47 | NIT | Two functions named `fmtWhen` with different semantics (relative vs absolute) | FIXED — `formatRelative` / `formatDateTime` in `shared/format.ts` |
| 48 | NIT | Three copies of the `ScheduleKind` union | FIXED — the contract's union is the only declaration |
| 49 | NIT | Dead `formatWeekdays` re-export, dead `channelFor`, never-produced `Result.code` | FIXED — removed |
| 50 | NIT | Local `SalahHistoryDay` duplicated the contract's inline result type | FIXED — derived via `Api["salah.history"]["result"][number]` |
| 51 | NIT | `stripFrontmatter` (renderer) duplicated `splitFrontmatter` (main) | FIXED — `shared/frontmatter.ts` |
| 52 | NIT | `anchorVersion: 1` literal duplicated `ANCHOR_VERSION`; `findByContext` unreachable (no prefix/suffix is ever stored) | RECORDED — the fuzzy tier is a deliberate reserve; populating context is a feature, not a defect |
| 53 | NIT | "Time" and "Analytics" are two sidebar entries rendering one screen | RECORDED — PRD F-TIME-09 calls Analytics a surface within Time; merging the nav is a product decision |

## Round 3 — codebase-details report (third Majors round)

Three Majors, **all three defects in my own fixes**. This report was the most
useful of the loop.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 54 | MAJOR | The scroll-offset restore never ran. It waited on `doc`, but an unsized `<canvas>` reports the HTML default **150**, not 0 (measured), so the guard passed and `scrollTop` was assigned while the container still held a 150 px canvas — clamping to 0. F-READ-05 was still dead. | FIXED — restore waits on a `rasterDone` counter, once per open |
| 55 | MAJOR | A page turn inherited the previous page's scroll and persisted it to the new page: nothing reset `scrollTop`, and the 500 ms save read `pageRef.current` at *fire* time | FIXED — `goTo` resets the container and cancels the pending save; the save captures its own page at scroll time |
| 56 | MAJOR | The IPC error banner could never be cleared: my round-3 fix removed the blanket clear without adding a per-source one | FIXED — errors keyed by source; each operation clears only its own |
| 57 | NIT | `reading_position.zoom` written but never read | RECORDED — the reader derives scale from settings; the column is inert but harmless |
| 58 | NIT | `savePosition` validated only `page`; the optional numerics reached SQLite unvalidated | FIXED — `Number.isFinite` guards |
| 59 | NIT | A resume kept the old `pauseReason`, so the strip showed "paused (idle)" while running | FIXED — cleared on resume |
| 60 | NIT | A superseded render still rebuilt the text layer | FIXED — re-checks cancellation after the async transform |
| 61 | NIT | `weekdayIndex` re-derived `isoWeekday` | FIXED — shared |

## Round 3 verification — scroll restore proven, not assumed

The reviewer's finding was that my restore never ran. After the fix I drove the
real UI and measured `scrollTop`:

| Setup | `scrollTop` after open | Verdict |
|---|---|---|
| fit-page, page shorter than the viewport | 0 | container cannot scroll — nothing to restore |
| `zoom: 2.2` (page overflows, `scrollHeight` 1750 > 700) | **240** | saved offset restored exactly |

So the restore works where scrolling exists; the earlier version could not have,
because it assigned before any raster and clamped to 0.

---

# Wave 4 — round 4 (convergence test)

`zoom_out` reported: **no Blocker, 1 Major, 11 Nits**. The Major was another
regression in my own error-keying fix.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 62 | MAJOR | Per-source error keys were only wired for the dashboard: `command` and `theme` were write-only, so any command failure produced a banner nothing could clear — and a failed pause-tracking was silent | FIXED — every command and the theme push clear their own key on success; the pause failure is surfaced |
| 63 | NIT | Timeline bars used the real day length but the axis labels still divided by 24 (half-fixed DST bug) | FIXED — both use `dayLengthMs` |
| 64 | NIT | `habits.heatmaps` failure swallowed while every other secondary fetch reports | FIXED |
| 65 | NIT | `fmtAge` duplicated relative time beside `formatRelative` | FIXED — `formatRelative` gained sub-day tiers; Notes uses it |
| 66 | NIT | Empty completion ring painted a dot (Habits); Goals guarded it | FIXED — conditional arc |
| 67 | NIT | `Kpi` unexported; Analytics re-implemented the tile four times | FIXED — `components/Kpi.tsx` |
| 68 | NIT | `dataset.text` "written and never read" | **REVERTED** — the reviewer grepped `src/` only; `spikes/verify-reading.cjs:84` counts `span[data-text]`, so removing it made the verifier report 0 text spans. Restored with a comment saying why it exists. The lesson is recorded rather than the fix. |
| 69 | NIT | Duplicate `.form-error` rule | FIXED |
| 70 | NIT | Importing a book fetched `reading.list` twice | FIXED — `load()` returns its rows |
| 71 | NIT | `toScreen`/`rectsMatch`/`confidence` unused outside tests | RECORDED — proven pure helpers, kept as tested API |
| 72 | NIT | `.nav-item` re-opened under the wrong section banner | RECORDED — cosmetic CSS organisation |

## Still open (recorded, not fixed)

`layout` / `cropMargins` / `hideHeaders` (F-READ-04) are typed and persisted but
have no control and no rendering path — a layout feature, not a defect in
existing behaviour. The `@tanstack/react-query` / `cmdk` / `date-fns` decisions
in STACK §3.2 remain unadopted, and zod validation is still hand-rolled. The
status strip (F-SHELL-08) and a Settings module (F-SHELL-02) are absent as
screens; `collector-status` now pushes, which is the data half of the strip.

---

# Wave 4 — round 4b (`design_critic`)

`design_critic` reported: **no Blocker, 3 Majors, 5 Nits**.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 73 | MAJOR | Text-layer spans were laid out at a fixed 12 px with no horizontal stretch, so DOM selection rects and re-anchored `TextItem` rects described different boxes; `resolveAnchor` kept them because they stayed inside `[0,1]` | FIXED — span height comes from `Math.hypot(tx[2], tx[3])`, width is stretched to `item.width` after layout. Verified against the raster (below) |
| 74 | MAJOR | `scroll_offset` stored `scrollTop` in CSS pixels while STACK §5.2 declares 0..1 | FIXED — stored as a fraction of the scrollable range (`shared/scroll.ts`, unit-tested); handler rejects out-of-range values; legacy pixel rows reset to the page top on read |
| 75 | MAJOR | The preload bridge returned the raw `invoke` promise, so a transport rejection reached `Promise.all` loaders and skipped `setBusy(false)` / `setError` | FIXED — the bridge converts a rejection to `{ ok: false, error }`; `CommandPalette` no longer leaves floating promises |
| 76 | NIT | `salah.history` failure was silently dropped | FIXED |
| 77 | NIT | Analytics never cleared its error on a successful load | FIXED — one failure message computed per load, then committed |
| 78 | NIT | Notes never cleared its error | FIXED — every successful load/search/open clears it |
| 79 | NIT | Timeline axis hardcoded 24 h | CONTESTED — already fixed in round 4 (#63); both bars and axis use `dayLengthMs`. The reviewer read a stale copy |
| 80 | NIT | `sites.categorize` had no in-flight or sequence guard | FIXED — writes are serialized on a promise chain, so an out-of-order `sites.day` read cannot win |
| 81 | NIT | `requireId` always said "habitId" | FIXED — the field name is passed at each call site |
| 82 | NIT | Negative `daysRemaining` rendered "-3 days left" | FIXED — reads "3 days overdue" |

## Found while verifying round 4 (not in any reviewer report)

The reviewer's Major about text-layer geometry was directionally right but
understated it. Measuring the rendered page against the canvas ink found two
defects nobody reported, both invisible to the verifiers:

| # | Severity | Defect | Evidence | Outcome |
|---|---|---|---|---|
| 83 | MAJOR | Every text span was mirrored to the opposite end of the page | Probe at zoom 1.5: heading ink occupied rows 112–144.8, its span was positioned at top 1014 | FIXED — `tx[5]` is already top-down (the viewport transform carries the flip, `d = -1` at rotation 0); the old code subtracted it from `viewport.height`. Spans now land at 109.2–145.2 |
| 84 | MAJOR | Every span had height 0, so `getClientRects()` returned rects the selection handler filters out (`r.height > 0`) — selecting text produced no highlight bar at all | Probe: `h: 0` for all four spans; caused by `.reader-page { line-height: 0 }` inheriting into `.text-layer span` | FIXED — `line-height: 1` on the span. Probe after the fix: rect `h: 20.2`, selection bar renders with all five swatches |

Selection → highlight was then driven end to end: selecting the marker line and
clicking "highlight" painted an overlay rect at `(0.1176, 0.2039)`, matching the
selected span's own box `(0.1177, 0.2062)` within 0.003.

## Round 4 verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (69 files) |
| `vitest run` | 333 passed / 14 files |
| `electron-vite build` | ok |
| Nine verifiers | 305 checks, 0 failed |
| Scroll fraction round trip (real reader, zoom 2.2 → 1.4) | stored `0.4002`; raster 1750 → 1116 px; restored to `0.4008` |
| Text spans vs canvas ink | heading 109.2–145.2 vs ink 112–144.8; body 184.8–201.3 vs ink 186.1–200.4 |
| Legacy pixel row | `scroll_offset 240` reads back as `0` on page 4 (test fails without the fix) |

## Contested

`zoom_out`'s round-4 "timeline axis divides by 24" was already fixed; the
reviewer read the pre-fix file. Recorded rather than re-fixed.

## Still open (recorded, not fixed)

`layout` / `cropMargins` / `hideHeaders` (F-READ-04) are typed and persisted but
have no control and no rendering path. `reading_session.ended_at` is stamped at
start so the column is never NULL; nothing reads the duration from it
(`day_aggregate` uses `active_seconds`), and the alternative — a nullable
`ended_at` — is a schema change, which needs approval. The
`@tanstack/react-query` / `cmdk` / `date-fns` decisions in STACK §3.2 remain
unadopted, and zod validation is still hand-rolled. The status strip
(F-SHELL-08) and a Settings module (F-SHELL-02) are absent as screens.

## Same defect class, swept after round 4b

Fixing #77/#78 exposed two more loaders with the identical shape — set the error
on failure, never clear it on success. Both were fixed in the same pass:

| # | Severity | File | Outcome |
|---|---|---|---|
| 85 | NIT | `components/Data.tsx:19` — `load` never cleared `error` | FIXED — one message per load, committed once |
| 86 | NIT | `components/Sites.tsx:77` — same, plus a `prev ??` guard that kept the first failure forever | FIXED — same shape as Analytics |

Also added `transportFailure` to `shared/api.ts` so the preload's rejection
conversion is unit-testable, with three tests (Error, non-Error, empty message).

## Found while adding coverage (no reviewer reported these)

`shared/format.ts` had no tests at all, despite being the single source for
every duration, date and relative-time string in the app. Writing them found:

| # | Severity | Defect | Evidence | Outcome |
|---|---|---|---|---|
| 87 | NIT | `formatDuration(42)` returned `"1m"` while its own docstring says `42s` — the round-to-minutes-first fix for 3599 s also rounded every sub-minute value up | test: `expected '1m' to be '42s'` | FIXED — sub-minute values stay in seconds; the 3599 s case is still pinned |
| 88 | NIT | `formatRelative` rendered `-1 days ago` for a future timestamp (clock skew, future file mtime) | test: output contained `-` | FIXED — a future timestamp reads `just now` |

`tests/format.test.ts` (9 cases) now pins the duration, date, clock and
relative-time contracts, including both cases above.

## Round 4, remaining `codebase_details` Majors

The round-4 `codebase_details` report had Majors beyond the ones above. Two of
its Nits duplicate #81/#82 and are not re-listed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 89 | MAJOR | Reading time counted a visible-but-unfocused window, contradicting the component's own docstring ("visible **and focused**") | FIXED — `counting()` requires `document.hasFocus()`, plus `blur`/`focus` listeners (a visibility change does not fire on an OS-level blur). Verifier unchanged |
| 90 | MAJOR | A scroll in the last 500 ms before the reader closed was dropped, because cleanup cleared the debounce timer without flushing | FIXED — cleanup flushes a pending write, and `goTo` cancels the pending offset (it resets the container to the top, so flushing it would save the old page's position) |
| 91 | MAJOR | `reading.reportVisible` accepted `NaN`/`Infinity`, which made `Math.min(wall, NaN)` NaN and stored a nonsense `active_seconds` | FIXED — handler requires a finite, non-negative number; `endSession` validates its optional value too |
| 92 | NIT | `reading_session.ended_at` is stamped at start, so the column never means "ended" | RECORDED — nothing reads a duration from it (`day_aggregate` uses `active_seconds`); the fix is a nullable column, i.e. a schema change, which needs approval |

## Round 4 totals

Across the two round-4 reports (round 4 `zoom_out` and round 4b
`design_critic`), plus the `codebase_details` Majors above: 6 Majors and 18
Nits. Every one was resolved — 22 fixed, 1 contested (timeline axis, already
fixed in round 4), 1 recorded for approval (`reading_session.ended_at`, a schema
change), 0 escalated. Probing while verifying found **4 further defects** no
reviewer reported (#83, #84, #87, #88) — two of them made text selection in the
reader non-functional.

---

# Wave 4 — round 5

## `zoom_out` — no Blocker, 1 Major, 5 Nits

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 96 | MAJOR | The notes preview had no inline grammar: `**bold**`, `_em_`, `` `code` ``, `~~strike~~` and links rendered literally, so the preview disagreed with Obsidian for the same file. STACK §3.2 prescribes `react-markdown` + `remark-gfm` + `rehype-sanitize` | PARTIAL — inline grammar implemented in `shared/inline-markdown.ts` (tokenizer, never HTML) with `isSafeHref` refusing `javascript:`/`data:`/`file:`. The prescribed library is a **new dependency**, which needs approval; recorded below |
| 97 | NIT | `Result` was re-declared structurally as `{ ok: boolean; error?: string }` in Habits, Goals and Data — `ok: true` still permitted an `error`, forcing a `?? "request failed"` at every call site | FIXED — Habits/Goals take `Result<unknown>`; Data uses `ActionResult`, whose message exists only on the success branch |
| 98 | NIT | The reader's 15 s highlight poll duplicated `refreshHighlights` (same fetch, same `JSON.stringify` comparison) | FIXED — one helper, guarded by `mountedRef`. The poll is **not** dead: the verification harness inserts highlights out-of-band through IPC, so the reviewer's "writer that does not exist" premise was wrong and the poll was kept |
| 99 | NIT | Two byte formatters; the dashboard's was KB-only, so a 41 MB database rendered as `41984 KB` | FIXED — one `formatBytes` in `shared/format.ts`, used by both, with tests |
| 100 | NIT | All three palette commands shared the `"command"` error key, so a successful backup cleared a still-relevant daily-note failure | FIXED — keyed `command:<id>` |
| 101 | NIT | The dashboard carries a developer-diagnostics panel (earlyoom preference, socket state, event counts, browser profiles) that duplicates the health page | RECORDED — a scope/consolidation question, not a defect. Moving it is a product decision about what the front screen is for; F-SHELL-08's status strip is the intended home for the live half |

### Verification of the markdown work

Driven in the real app against a scratch vault:

| Check | Result |
|---|---|
| `**bold**`, `_italic_`, `` `code` ``, `~~gone~~` | rendered as `strong`/`em`/`code`/`s` elements; `literalMarkup: false` |
| `[safe](https://example.com)` | one `<a href="https://example.com">` |
| `[bad](javascript:alert(1))` | **no anchor emitted**; rendered as text |
| `2 * 3 stays literal` | unchanged |

`tests/inline-markdown.test.ts` (9 cases) pins the tokenizer, including that an
asterisk inside an inline code span does not start emphasis.

## Needs approval (not applied)

1. **`react-markdown` + `remark-gfm` + `rehype-sanitize`** (STACK §3.2). The
   inline tokenizer closes the fidelity gap for the constructs Obsidian notes
   actually use, but GFM tables, task lists and nested lists still render as
   literal text. Adopting the prescribed stack would delete ~90 lines of local
   parsing. This is a new dependency, so it was not added.
2. **`reading_session.ended_at` nullable.** The column is `NOT NULL` and is
   stamped at start, so it never means "ended". Nothing reads a duration from
   it (`day_aggregate` uses `active_seconds`), so this is dormant, but the
   correct fix is a schema change.

## Bridge invariant verified in the running app

| Call | Result |
|---|---|
| `reading.savePosition` with `scrollOffset: 5` | `{ ok: false, error: "scrollOffset must be between 0 and 1" }` |
| `system.nope` (outside the closed list) | `{ ok: false, error: "unknown channel: system.nope" }` |
| `reading.reportVisible` with `seconds: NaN` | `{ ok: false, error: "seconds must be a finite, non-negative number" }` |
| Unhandled rejections in the renderer | none |
| Dashboard after the three failures | no error banner, 5 KPIs, 10 nav items |

## Coverage added while waiting (self-directed)

Four `shared/` modules had no direct tests despite being pure and used by both
processes. `tests/shared-pure.test.ts` (13 cases) now pins:

- `localDateKey` — zero padding, and that it follows the **local** day (a late
  evening local time is already tomorrow in UTC; the key must not follow UTC or
  every table is bucketed wrong).
- `frontmatter` — an unterminated `---` block is *not* frontmatter (otherwise a
  note opening with a horizontal rule loses its body), and a mid-document `---`
  does not start one.
- `buildHighlightsMarkdown` — one heading per page (not per highlight), the
  singular "1 highlight", and newline collapsing inside a blockquote.
- `schedule` — ISO weekday numbering (Monday = 1, Sunday = 7) and every
  `ScheduleKind`.

### Preview links, verified

The preview's links were rendered as bare `<a href>`, which is inert here: the
main process blocks `will-navigate` outside the app origin, so a click did
nothing. `target="_blank"` routes through the existing `setWindowOpenHandler`
guard, which re-checks the scheme, hands the URL to the OS, and always denies
creating a window — no new IPC channel needed.

| Check | Result |
|---|---|
| `[good](https://example.com/page)` clicked | `shell.openExternal` received exactly that URL |
| App URL after the click | unchanged |
| `[evil](javascript:alert(1))` | **not an anchor** — rendered as text |
| `[rel](./other.md)` | anchor with no navigation (no page to show from a preview) |

`isExternalHref` is unit-tested alongside `isSafeHref`.

### Focus-aware session accounting, verified both ways

The harness window is unmapped by design, so it never has focus. Forcing
`webContents.focus()` gives the measurable case:

| Window state | `document.hasFocus()` | Recorded `activeSeconds` |
|---|---|---|
| Unmapped (normal verify run) | `false` | 0 |
| `webContents.focus()` + 5 s | `true` | **5** |

So the fix counts real reading time when the window is focused, and stops
counting when it is not — it does not silently count nothing.

Note on the verifier: `session-closes` asserts only `activeSeconds >= 0`, which
is true for every possible value. The check is vacuous and always was; the
measurement above is the real evidence.

### F-DASH-03 was not met (found by self-review, not by any reviewer)

The KPI row showed five tiles: Screen time, Watch time, Reading, Habits,
Prayers. PRD F-DASH-03 requires seven measures — **focused time** and **current
best streak** were missing — and requires **each KPI to be clickable to its
module**, which none of them was.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 102 | MAJOR | KPI row omitted focused time and best streak, and no tile was clickable (F-DASH-03 MUST) | FIXED — seven tiles; `Kpi` takes `onClick` and renders a real `<button>` when given one, with hover/focus styling. `day.focusedSeconds` and `day.bestStreak` already existed in the payload and were unused |
| 103 | NIT | `spikes/verify-shell.cjs` pinned `kpis === 5`, so the verifier *encoded* the incomplete row and passed | FIXED — asserts the seven labels by name and that every tile is a `<button>` |

The new checks fail against the old row and pass now:
`7 kpis: Focused, Screen time, Watch time, Reading, Habits, Prayers, Best streak`,
`7/7 are buttons`. Shell verifier: 17/17.

KPI navigation driven in the app, one tile per target:

| Tile clicked | Active nav item | Expected |
|---|---|---|
| Reading | Reading | Reading |
| Habits | Habits | Habits |
| Prayers | Salah | Salah |
| Best streak | Habits | Habits |
| Focused | Analytics | Analytics |

All five land on the intended module.

### Dashboard MUSTs that are not implemented (recorded, not fixed)

Checking the renderer against PRD §5.8 the same way that found F-DASH-03
surfaced gaps that are **missing features**, not defects in existing
behaviour. They are not in the reviewers' lens (each reviews the code that
exists) and fixing them is product work, not a review fix:

| ID | Requirement | State |
|---|---|---|
| F-DASH-01 | Today header with **day number** | header shows the Hijri date; no day number. First/last activity is shown in the Today panel |
| F-DASH-02 | Prayer times overlaid as timeline markers | timeline has app segments only; no prayer markers |
| F-DASH-04 | Next prayer countdown + today's prayer checklist with one-tap logging | **absent from the dashboard**; the Salah screen has the checklist |
| F-DASH-05 | Today's habits with one-tap completion | **absent from the dashboard**; the Habits screen has it |
| F-DASH-06 | Currently reading card with progress and resume | **absent from the dashboard** |
| F-DASH-09 | Week and month views with period selectors | absent; Analytics has 7/30/90-day ranges instead |

F-DASH-03 was fixed because the data already existed and the row was one
component; these need new screens and are outside a review loop. Recording them
rather than leaving them implied.

---

# Wave 4 — round 5 (continued)

## `design_critic` — 1 **Blocker**, 3 Majors, 3 Nits

### The Blocker: history ingest ran on the main thread

`design_critic` is the first reviewer to find a Blocker in the loop. It is real,
and STACK says so twice:

- STACK §4.1: "`DatabaseSync` is synchronous. In the main process, run heavy
  ingest in a **worker thread** so the UI IPC loop stays responsive (N-PERF-04)."
- STACK §5.3 step 8: "Run ingest in a **worker thread**, not on the main IPC
  loop."

`grep -rn "worker_threads\|utilityProcess\|new Worker" src/` returned nothing,
and `sites.ingest` called `svc.ingestNow()` inline, which did `copyFileSync` of
a history file up to `MAX_SNAPSHOT_BYTES = 800 MB` plus `DatabaseSync` reads.
Every other IPC call — the dashboard poll, `reading.savePosition`, the reader
heartbeat — queued behind it.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 104 | 🔴 BLOCKER | History ingest ran synchronously on the main process (STACK §4.1/§5.3 step 8, F-SHELL-09, N-PERF-04) | FIXED — `ingest-worker.ts` runs `ingestAll` on a `worker_threads` worker with its own WAL connection; electron-vite emits it as a second main entry; `sites.ingest` and the hourly timer both await it. The worker is created once, rebuilt after a crash, and overlapping runs are still skipped |
| 105 | MAJOR | `notes.selectVault` walked and reindexed a renderer-supplied path synchronously, with no existence/directory check, so a typo or `/` was accepted and persisted | FIXED (validation) — see below |
| 106 | MAJOR | `salah.history` took an unclamped `days`; `recentDays` allocates one entry per day, so `1e9` or `Infinity` is an allocation/hang on the main process | FIXED — finite check + 1..366 clamp, same rule and ceiling as `habits.heatmap` |
| 107 | MAJOR | `habits.log`, `salah.log` and `salah.repayQada` forwarded enum/numeric payloads to SQLite unvalidated; an unknown habit status is classified as not-done by `daySatisfies` with no default branch, silently corrupting streaks, and a `NaN` qada delta renders as `NaN` debt | FIXED — statuses checked against their closed unions, counts/values against finite numbers |
| 108 | NIT | `habits.heatmaps` re-reads rows `list()` just loaded — the comment claimed the opposite | FIXED — `list()` returns the rows it already has |
| 109 | NIT | Goals captured `todayKey()` at mount, so a window left open across midnight created goals dated yesterday — the exact bug the App's 30 s rollover exists to prevent | FIXED — `GoalsView` takes the App's `today` |
| 110 | NIT | `DaySummary.hijriSource` crosses the boundary and is never consumed; an empty `hijri` renders blank instead of `—` | FIXED — the header falls back to `—`, and shows the source when it is not the salah stack's |

### The worker, verified

| Check | Result |
|---|---|
| `sites.ingest` result | both profiles, `strategy: "immutable"`, no error |
| Trivial `system.health` call issued 120 ms into ingest | returned in **1 ms** |
| `sites.lastIngest` after the run | updated with the worker's rows |
| Worker bundle removed | `[ingest] worker failed: Cannot find module .../ingest-worker.cjs` and ingest returns no data — so the worker is load-bearing, not decorative |
| `verify-sites` | 39/39 |

### `notes.selectVault` — what was fixed and what was not

Validation is fixed: the path must exist and be a directory, otherwise the
handler throws a named error instead of persisting it. The reindex is still
synchronous on the main process. Moving it to a worker is the same change as
#104 and is **not** done here: it needs an incremental-index protocol rather
than one request/response, so it is recorded rather than half-built.

### Boundary validation, measured

Every new guard exercised through the real bridge:

| Call | Result |
|---|---|
| `salah.history {days: 1e9}` | 366 entries in **3 ms** (was an unbounded allocation) |
| `salah.history {days: 100000}` / `{400}` | 366 |
| `salah.history {days: 30}` | 30 |
| `salah.history {days: 0}` / `{-5}` | 1 (clamped to the minimum) |
| `salah.log {prayer: "nope"}` | `prayer must be one of: fajr, dhuhr, asr, maghrib, isha` |
| `salah.log {status: "invented"}` | `status must be one of: on_time, late, missed, excused` |
| `salah.repayQada {count: NaN}` | `count must be a finite number` |
| `habits.log {status: "bogus"}` | `status must be one of: done, partial, skipped, slipped, clean` |
| `habits.log {value: NaN}` | `value must be a finite number` |
| `notes.selectVault {path: "/definitely/not/here"}` | `vault path is not a directory: …` |
| `notes.selectVault {path: "/etc/hostname"}` (a file) | `vault path is not a directory: …` |
| `reading.savePosition {scrollOffset: 9}` | `scrollOffset must be between 0 and 1` |

`ENTRY_STATUSES`, `PRAYER_IDS` and `PRAYER_STATUSES` live beside their unions in
`shared/api.ts` with `satisfies`, so adding a member to one and not the other
fails the build — the validator cannot drift from the type.

## Round 5 totals

| Reviewer | Blocker | Major | Nit |
|---|---|---|---|
| `zoom_out` | 0 | 1 | 5 |
| `codebase_details` | 0 | 3 | 4 |
| `design_critic` | **1** | 3 | 3 |

All 20 findings resolved: 18 fixed, 1 fixed-in-part (`notes.selectVault`
validates now, reindex still on the main thread — recorded), 1 recorded for
approval (`react-markdown`, a new dependency).

## Round 5 verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (74 files) |
| `vitest run` | 372 passed / 17 files |
| `electron-vite build` | ok, emits `out/main/ingest-worker.cjs` |
| Nine verifiers | 306 checks, 0 failed |
| Ingest worker | main thread answered in 1 ms during ingest; worker removal makes ingest fail loudly |

---

# Found while running round 6 (tooling defect)

Running the suite repeatedly filled `/tmp` and broke unrelated tooling. The
cause was in the tests, not the product: every `mkdtempSync` call leaked a
directory, and there were 24 of them across five files. `/tmp/selfos-*` held
**811 directories** when it was measured.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 111 | NIT | Test temp dirs were never removed; repeated runs accumulated hundreds until `/tmp` filled | FIXED — `tests/helpers/temp.ts` registers each directory and removes it in `afterEach`. Verified: a full run now leaves **0** `selfos-*` directories |

This also explains two spurious "disk quota" failures earlier in the session,
which were environment damage from the suite rather than code failures.

## Defects in my own worker change (self-review, before round 6 closed)

Writing the worker was not enough; three defects in the new code had to be
found and fixed, and only the probes caught them:

| # | Severity | Defect | Evidence | Outcome |
|---|---|---|---|---|
| 112 | MAJOR | A worker that never answered left `#ingestBusy` true forever, so ingest would never run again — a silent permanent stop | code review: the promise had no timeout | FIXED — a 5-minute timeout terminates the worker, drops the reference (so the next run rebuilds it) and resolves as "no data" |
| 113 | MAJOR | The worker holds its own DB connection but was never terminated on shutdown, so it could keep the file open past `db.close()` | `close()` had no worker handling | FIXED — `close()` terminates the worker before closing the database |
| 114 | MAJOR | `sites.ingest` arriving during the startup run returned stale `#lastIngest` (empty) instead of the real result | probe: `call1` returned `len: 0`, `call2` returned `len: 2` | FIXED — a second caller joins the run in flight. Probe after: `call1` returns `len: 2` in 35 ms |

| 115 | NIT | The saved-vault restore checked `existsSync` but not that the path is still a *directory*, so a vault replaced by a file would be indexed and watched | FIXED — `isDirectory` guard, matching the `selectVault` validation |

| 116 | NIT | `reading.addHighlight` validated the anchor and text but passed `page` and `color` straight into SQLite; the colour list was a renderer-local literal with no main-process counterpart | FIXED — `page` must be a positive integer and `color` must be in `HIGHLIGHT_COLORS`, which now lives in `shared/api.ts` and is imported by both the reader's swatches and the handler |

| 117 | NIT | `Goals.tsx` built its own `d MMM` date inline with `toLocaleDateString`, a fourth date variant outside `shared/format.ts` and outside its tests | FIXED — `formatDayMonth` in `shared/format.ts`, unit-tested |

| 118 | NIT | `PRAYER_COUNT = 5` lived in main while the renderer retyped `5` in four places (score, two heatmap thresholds, dashboard KPI) plus one in main — no compiler link between them | FIXED — `PRAYER_COUNT` is `PRAYER_IDS.length` in `shared/api.ts`; main re-exports it and every site imports it. `grep` for a literal `/5` or `=== 5` in `src/` now returns nothing |

---

# Wave 4 — round 6 (in progress)

## Found by probing the IPC boundary before the reviewers reported

Every one of these was reproduced through the **real bridge in a real process**
(a verifier or an ad-hoc probe with `SELFOS_VERIFY=1`, window never mapped), not
read off the source.

### `localDate` was never validated anywhere in main

`local_date` is the key every table is bucketed by (STACK D-04), and it is the
only column most range queries filter on. Nothing in the IPC layer checked it,
so a malformed value was not refused by SQLite — it was **stored**, and the row
then fell outside every `= ?` and `BETWEEN` the app issues.

Measured before the fix:

| Call | Result |
|---|---|
| `habits.log {localDate: "junk"}` | stored `local_date = "junk"` |
| `habits.log {localDate: ""}` | stored `local_date = ""` |
| `habits.log {localDate: "2026-11-03T00:00:00Z"}` | stored verbatim |
| `salah.log {localDate: "junk"}` | stored; the day then reported **0 logged** |
| `dashboard.day {localDate: "2026-13-45"}` | returned a day summary rather than an error |

`time.rebuild` is the worst of them: it writes a `day_aggregate` **row** under
the junk key and reports `{rebuilt: "junk"}` as success.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 119 | MAJOR | No handler validated `localDate`; malformed dates were persisted and became invisible to every screen, streak, heatmap and aggregate, with no error shown | FIXED — `isDateKey` in `shared/dates.ts` (shape **and** calendar round trip, so `2026-13-45` and `2026-02-30` are refused), applied at all 14 date-taking handlers |

`isDateKey` is in `shared/dates.ts`, beside `localDateKey`, because the same key
is produced in the renderer, the preload and main — one implementation, as the
module's own header requires. It is unit-tested over a year of dates plus the
impossible-date cases.

| # | Severity | Defect in the fix itself | Outcome |
|---|---|---|---|
| 120 | NIT | The first version of `dateKeyOrToday` treated `""` as "field absent" and substituted today. An empty string is a value the caller **sent**, so the guard was itself a silent substitution — the same defect one layer up. Caught by asserting the empty string is refused, not defaulted | FIXED — only `undefined`/`null` mean "default to today" |

Verified after the fix, 44 malformed date/call pairs through the real bridge:
`date-validation` **44 refused, 0 accepted**, while a valid date and an omitted
date still pass. `verify-shell` is now **19/19** and the verifier asserts this
permanently.

### `reading.saveSettings` persisted an unvalidated object

The handler passed the renderer's object straight into `JSON.stringify` and then
into the `book.settings_json` column, and the render path read it back on every
open. Measured:

| Sent | Stored |
|---|---|
| `{pageBackground: "evil", layout: "nope", zoom: -5}` | verbatim |
| `{brightness: NaN}` | `"brightness": null` — JSON cannot represent `NaN`, and `pageFilter` interpolates the result into a CSS filter string |

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 121 | MAJOR | `reading.saveSettings` took the settings object whole: an unknown enum member or a non-finite number was stored and re-read by the render path for the life of the book | FIXED — `validateBookSettings` rebuilds the object field by field against `PAGE_BACKGROUNDS` / `ZOOM_MODES` / `READER_LAYOUTS` and `READER_SETTING_RANGE`, all `satisfies`-bound to `BookSettingsView` so a new member fails the build if the list is not updated |

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 122 | MAJOR | `parseSettings` merged a stored blob with the defaults via `{...DEFAULT_SETTINGS, ...parsed}`, trusting whatever was on disk. A row written before #121 existed is still there and is read on every open, so the writer-side fix alone leaves the reader exposed | FIXED — each field is checked against the same lists and bounds and falls back to its **default**, so one bad field no longer discards the book's other settings |

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 123 | MAJOR | `BookSettings` in `modules/reading/library.ts` was a second, member-for-member declaration of the shared `BookSettingsView` contract. Adding a setting to one left the other — and `DEFAULT_SETTINGS` — silently behind, which is how the unvalidated object above stayed invisible | FIXED — `type BookSettings = BookSettingsView`; one declaration, checked by the compiler wherever either name is used |

Verified through the real bridge with a real book: 8 of 9 malformed settings
objects refused with a named message, the valid object accepted, and the row on
disk afterwards contains **only** contract fields — the "extra key" case is
dropped by the rebuild rather than persisted.

### Gates after these changes

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (75 files) |
| `vitest run` | **384 passed** / 17 files |
| `electron-vite build` | ok, emits `out/main/ingest-worker.cjs` |
| `verify-shell` | **19/19**, including the new `date-validation` step |
| `/tmp/selfos-*` after a full run | 0 (the #111 leak stays fixed) |

## Round 6 — range validation and the inert flicker fix

Two more defects found by probing, and one Major from the `zoom_out` reviewer.

### `analytics.*` refused a non-finite range with the wrong message

`analytics.range {days: NaN}` did not hang or clamp — it threw `Invalid time
value` from inside `Date`, a message naming neither the channel nor the field.
`habits.heatmap` refused the same input properly, so the two channels disagreed.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 124 | NIT | `analytics.range` and `analytics.domains` passed `days` straight to a date walk; `NaN` produced `Invalid time value` from `Date` rather than a named rejection. The 1..366 clamp was copy-pasted at four sites | FIXED — one `dayCount(value, fallback)` helper, used by `analytics.range`, `analytics.domains`, `habits.heatmap`, `habits.heatmaps` and `salah.history`. Four clamps become one definition |

### `sites.uncategorized` with a negative limit returned the wrong rows

`uncategorizedDomains` ends in `.slice(0, limit)`, and `slice(0, -1)` counts
**from the end** instead of truncating. Probed with three uncategorized domains:

| `limit` | rows returned |
|---|---|
| `-1` | `a.com, b.com` — every domain *except the last* |
| `0` / `NaN` | none |
| `1e9` | all |

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 125 | NIT | A negative `limit` reached `Array.prototype.slice`, whose negative index counts from the end, so the caller silently got "all but the last N" | FIXED — `limit` validated as a number in 1..1000 |

### MAJOR (`zoom_out`) — the documented flicker fix never ran

`mergeSegments` (`integrations/hyprland/events.ts:67`) implements the exact
behaviour `spikes/RESULTS.md:225` records as a fix: a sub-second blip is absorbed
**backward** into the following segment, so a 200 ms flicker does not claim the
next several seconds of a different app. It is exported, and unit-tested.

Nothing on the ingest path called it. `grep -rn mergeSegments src/` returned the
definition only; the collector's `#commit` (`modules/time/collector.ts:267`) went
straight from `splitAtMidnight` to `#writeRow`. The result is the worst shape of
dead code: a green test asserting correct behaviour for a function the product
never runs, under a comment claiming the timeline no longer fills with the
fragments it exists to remove.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 126 | MAJOR | `mergeSegments` was never called: the flicker fix documented in `RESULTS.md` and asserted by `tests/hyprland-events.test.ts` had no effect on the running app | FIXED — `SegmentMerger` puts the same rule on the ingest path, streaming one segment at a time |

**Why a new class rather than calling `mergeSegments` in `#commit`.** The batch
form takes the whole segment list at once, but the collector writes each segment
as it closes so a crash loses at most one flush interval (N-REL-01). Buffering a
day's segments to merge them at the end would trade this correctness bug for a
data-loss window — the wrong direction. `SegmentMerger` applies the identical
rule incrementally, holding at most one segment back.

A gap (disconnect, idle, pause, shutdown) must release the held segment, or the
tail would wait for a successor that may never come; `#commitGap()` does that at
all four sites.

| Check | Result |
|---|---|
| `tests/hyprland-events.test.ts` | 23 passed (8 new: the backward-absorb case, same-app merge, real-switch retention, title-change, the blip chain, no-loss-on-flush, zero-length, and **equivalence with `mergeSegments` over a whole stream**) |
| The equivalence test | pins the streaming and batch forms together, so the collector can use one while the tests keep testing the other |
| `verify-time` | 16/16 after the change |

### Gates after these changes

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (75 files) |
| `vitest run` | **392 passed** / 17 files |
| `electron-vite build` | ok |
| `verify-shell` | **22/22**, including `date-validation` (44 refused), `date-validation-empty-string-refused`, `range-validation`, `range-clamped-not-refused` |
| `verify-time` | 16/16 |

### A defect in my own verifier, caught by running it

The new `executeJavaScript` block embedded a JS comment containing backticks
inside a template literal, which terminated the literal and made the verifier a
syntax error — it died before the first step. `node --check` does not catch this
(it is a runtime template-literal construct, not a parse error in the host file),
so it was only visible by running the verifier. Fixed, and the run above is the
proof.

### The driver boundary was bypassed, and its `immutable` option had no caller

`driver.ts:1-11` states it is "the ONLY module allowed to import `node:sqlite`",
and STACK §4.1 sells that isolation as the mitigation for `node:sqlite` being
Stability 1.2 — a swap to `better-sqlite3` "touches one file". As shipped it
touched three: the driver, `integrations/browser-history/ingest.ts:286`, and
`modules/notes/index.ts:23`. The `OpenOptions.immutable` flag existed for exactly
the history case ("Set true when reading a foreign DB that must not be modified
(browser history)") and no caller ever passed it.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 127 | MAJOR | Two modules imported `node:sqlite` directly, contradicting the driver's stated isolation rule; `OpenOptions.immutable` was dead configurability | FIXED — ingest opens through `Db.open(path, {readonly: true, immutable: strategy !== "snapshot"})`, and the notes FTS index goes through `Db.open` + `get`/`all`/`run` |
| 128 | NIT | The ingest bigint read needed `statement.setReadBigInts(true)`, which is why it reached for a raw `DatabaseSync` in the first place | FIXED — `Db.allBigInt<T>(sql, ...params)` keeps the `node:sqlite` types inside the driver, which is the whole point of the boundary |

One subtlety the change had to get right: `immutable` is the fast path **only**.
A snapshot is a private copy, so it is opened read-only but *not* immutable —
SQLite must be free to read its journal, which an immutable open ignores by
definition. The condition is `strategy !== "snapshot"`, and `verify-sites` (which
exercises both strategies) stays 39/39.

Confirmed after the change: `grep -rn 'from "node:sqlite"' src/` returns
`driver.ts` **only**, so the header's claim is now true rather than aspirational.

### Dead exports, verified one by one

Each was checked with a grep for a *use* (not a declaration) across `src/`,
`tests/` and `spikes/`.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 129 | NIT | `DEFAULT_STATE` (`integrations/hyprland/idle.ts`) and `Db.prepareBigInt` (`db/driver.ts`) were exported and never imported | DELETED — both were pure dead surface; `prepareBigInt`'s only role is now `allBigInt`, which the ingest path actually calls |
| 130 | NIT | `Services.integrityAt()` and `Services.startedAt` had no reader | RECORDED — `integrityAt` is the timestamp half of a pair whose other half (`checkIntegrity`) is used; `startedAt` is the uptime anchor. Both are one-line accessors on a singleton, so deleting them is churn, not simplification. Left in place, noted here as known-unused |
| 131 | MAJOR | `Services.restoredFrom` was assigned from `applyPendingRestore` and never read, so a staged restore applied silently on launch with no user-visible trace | FIXED — surfaced through `system.health` as `restoredFrom`, and the Data page states which safety copy was kept |

### The remaining `zoom_out` Nits — recorded, not all applied

The reviewer's list is accurate; these are the ones deliberately left, with the
reason, because "fix everything" must not mean "delete working code the PRD
still needs":

| Finding | Decision |
|---|---|
| `addDays`/`daysBetween`/`weekStart`/`monthStart`/`previousDay` duplicated across `goals/model.ts`, `habits/schedule.ts`, `shared/dates.ts` | **PROPOSE FIX, not applied this round** — real duplication, but consolidating five date helpers across three modules touches every streak, pace and heatmap path. It is a refactor with its own risk, not a defect fix, and belongs in its own change with the tests as the gate |
| `analytics.ts` imports `addDays` from `goals/model` | Same change as above; the import disappears with it |
| `formatHijri`, `minutesOf` copy-pasted in `salah/compute.ts` | **PROPOSE FIX, not applied** — same reason: two identical pure functions, one shared home, but the move touches the salah time path that `verify-salah` (29/29) covers |
| `MEDIA_DOMAINS` duplicates `MEDIA_RULES` | RECORDED — a genuine drift risk; the fix is one `some()` call, queued with the date-helper consolidation |
| `mergeSegments` test-only | FIXED this round (#126) |
| Contract fields with no reader (`DaySummary.switches`, `SalahDayView.onTime`, `GoalPaceView.perDay`, …) | RECORDED — these are computed and tested; removing them is a contract change needing approval, not a review fix |
| `habits.heatmap`, `notes.uri`, `sites.uncategorized` reachable only from verifiers | RECORDED — `sites.uncategorized` is the sole implementation of PRD F-TIME-07's bulk-categorise; the other two are verifier-only but harmless and are covered by `verify-habits`/`verify-notes` |

### The silent restore

`Services.restoredFrom` was assigned from `applyPendingRestore()` at
construction and never read. A staged restore is applied on the *next* launch, so
by the time any screen renders the database has already been replaced — and
nothing said so. The first sign was missing history, with no way to tell what
happened or where the previous contents had gone.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 131 | MAJOR | A staged restore applied silently on launch: the safety copy's path was computed and discarded, so the user had no indication their database had been replaced or that a copy of the old one still existed | FIXED — `HealthReport.restoredFrom` carries the path, and the Data page opens with a notice naming the safety copy |

Verified through the real bridge: `system.health` now returns the field
(`hasField: true`, `restoredFrom: null` on a launch with nothing staged), and the
existing restore tests pin that the returned path is the file actually written.

## Round 6 totals

| Reviewer | Blocker | Major | Nit |
|---|---|---|---|
| `zoom_out` | 0 | 4 | 8 |
| `codebase_details` | — | — | — |
| `design_critic` | — | — | — |

The two other reviewers did not report: the session they were running in was
terminated while they were mid-audit, so per the EGM rule they are recorded as
**not run**, not as reviewers with zero findings. Round 6 is therefore **not
clean**, and the loop continues.

Findings resolved this round: 13 applied (4 MAJOR, 9 NIT), 8 recorded with a
reason. The recorded ones are dominated by one class — genuine duplication
(`addDays`/`weekStart`/`formatHijri`/`minutesOf`/`MEDIA_DOMAINS`) whose fix is a
multi-module move touching the streak, pace, heatmap and salah time paths. That
is a refactor with its own blast radius, not a defect repair, and folding it into
this round would make the diff unreviewable. It is queued as its own change.

### Gates after round 6

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (75 files) |
| `vitest run` | **393 passed** / 17 files |
| `electron-vite build` | ok, emits `out/main/ingest-worker.cjs` |
| `verify-shell` | 22/22 |
| `verify-time` | 16/16 |
| `verify-sites` | 39/39 |
| `verify-notes` | 49/49 |
| `verify-polish` | 52/52 |
| `grep 'from "node:sqlite"' src/` | `driver.ts` only — the isolation claim is now true |

## Round 6 — resumed after the session was terminated

The session running round 6 was killed mid-audit, so the three reviewers were
recorded as **not run** and the round was not clean. Two loose threads were left
open at that point; both are now closed, and one produced a real fix.

### The workspace-switch complaint (user-reported) — fixed, and now proven

The user reported that running a `/tmp` probe which `require`d the built main
bundle **switched their active workspace to 5**, interrupting work on another
workspace. The mechanism was already understood (`launch-mode.ts`), but the fix
had only been argued, never measured against the exact reported shape.

Re-measured with a probe that is the same shape as the offending command
(`require`s `out/main/index.cjs`, no `SELFOS_VERIFY`), reading `hyprctl` before
and after:

| Check | Result |
|---|---|
| Active workspace before → after | 1 → **1** (unchanged) |
| Windows created / mapped | 1 / **0** |
| Electron clients on any workspace | **0** |

The counterfactual (mapping a window to confirm it *would* move) was
deliberately **not** run: reproducing the harm the user asked to stop is not a
verification, it is the defect. The mechanism is pinned instead by
`tests/launch-mode.test.ts:66-73`, which asserts this exact `require`-the-bundle
shape is inferred as a harness, plus the pre-fix/post-fix measurement already in
`spikes/RESULTS.md`.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 132 | NIT | `spikes/sp2-memory.cjs` created its window with `show: true` for a pure measurement stub, so running the memory spike activated the window and the workspace-5 rule moved the user | FIXED — `show: false`; Electron starts the renderer/gpu/utility processes regardless, so the measured breakdown is unchanged (renderer 81 MB, gpu 111 MB, utility 77 MB) and the active workspace stays put |

The other visible-window spikes were audited and **kept**: SP-10's subject *is* a
visual drag check (`RESULTS.md` SP-10), and SP-2/SP-9 in `main.cjs` share a code
path. Recorded in `spikes/RESULTS.md` under "The same rule applies to the
spikes".

### The reader's WASM codecs and the CSP — measured, not a defect

An investigation was open on whether `script-src 'self'` blocks pdf.js 5's
`jbig2.wasm` / `openjpeg.wasm` / `qcms_bg.wasm`. A main-frame probe reported a
CSP violation, which looked like data loss on any PDF needing those codecs.

It is a false alarm: **pdf.js runs its codecs in its worker, and a worker does
not inherit the document's CSP meta tag.** Compiled each real `.wasm` over
`selfos-app://app/pdfjs/wasm/` in both contexts, in one process:

| Context | `jbig2` | `openjpeg` | `qcms_bg` |
|---|---|---|---|
| main frame | blocked | blocked | blocked |
| module worker at the pdfjs origin | **compiled OK** (8 imports) | **compiled OK** (17) | **compiled OK** (5) |

`WebAssembly.compile` takes no imports, so these results cannot be a linking
error in disguise. No code change; recorded in `spikes/RESULTS.md` under "The
CSP does not block pdf.js's WASM codecs", including the instruction **not** to
"fix" it by adding `'wasm-unsafe-eval'` to the policy.

### Round 6 re-run

The three stalled reviewers (`codebase_details`, `design_critic`, `zoom_out`)
were re-spawned with fresh context against the same targets. All three reported.
`design_critic` needed two resumptions before it emitted its text (the first two
runs returned usage counters only); the report below is the third attempt, which
stated its coverage explicitly.

Two Majors were found **independently by `design_critic` and
`codebase_details`** — the strongest signal in this loop, since neither saw the
other's work. Both were reproduced through the real bridge before any fix.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 133 | MAJOR | `habits.create` and `habits.changeSchedule` validated only that `kind`/`schedule.kind` were *strings*. `daySatisfies` switches on `habit.kind` with no `default`, so an unknown member stored in a `TEXT NOT NULL` column with no CHECK made the habit **permanently unsatisfiable** — streak and 30-day completion read 0 forever, no error shown, no UI way to repair. Verbatim the rationale already written into the `habits.log` guard one handler over | FIXED — `HABIT_KINDS`/`SCHEDULE_KINDS` added as `satisfies`-bound runtime mirrors beside `ENTRY_STATUSES`; one `requireSchedule` helper shared by both handlers, which also validates `weekdays` (integers 1..7) and `timesPerPeriod` (positive integer) that reached `#insertSchedule` unchecked |
| 134 | MAJOR | `reading.addHighlight` validated `page`/`color` (#116) but persisted an **unvalidated `anchor`**. The reader calls `resolveAnchor` on every render, which runs `anchor.rects.every(...)` and `normalizeText(anchor.text)`. A string `rects` throws `TypeError`; a missing `text` throws inside `findByText`; `main.tsx` mounts **no error boundary**, so the React root unmounts and re-opening the book re-crashes — with the delete control inside the panel that can no longer render | FIXED — `requireAnchor` validates shape, finite rects, text and rotation at the boundary. Probed: `{rects:"nope"}` and a missing `text` were both accepted and stored before, refused after |

**Reproduction (through the real bridge, before the fix).**

| Probe | Before | After |
|---|---|---|
| `habits.create {kind:"bogus", schedule:{kind:"bogus"}}` | `{ok:true}` — stored `kind:"bogus"` | refused: `kind must be one of: boolean, count, duration, avoid` |
| `habits.create` with `weekdays:[0,9]` | accepted | refused: `schedule.weekdays must be integers 1..7` |
| `reading.addHighlight` anchor `rects:"nope"` | `{ok:true}` — persisted | refused: `anchor.rects must be an array` |
| `reading.addHighlight` anchor with no `text` | `{ok:true}` — persisted | refused: `anchor.text must be a string` |
| Rows left behind by the malformed calls | 2 highlights stored | **0** |

The exact crash conditions were pinned separately, since "Major" overstates a
shape that degrades quietly:

| Anchor | `resolveAnchor` result |
|---|---|
| `rects` as string, rotation matches | **throws** `anchor.rects.every is not a function` |
| missing `text`, rotation differs | **throws** on `normalizeText(undefined)` |
| `rects` string, rotation differs | silently yields `{x:null,…}` rects — corrupt, not a crash |

Both guards were checked against **valid** input so the fix is not a wall:
`{kind:"boolean", schedule:{kind:"daily"}}`, `weekdays:[1,2,3,4,5]`,
`times_per_week` with `timesPerPeriod:3`, a well-formed anchor, and a valid
`backup.create {kind:"manual"}` all still succeed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 135 | NIT (`codebase_details`) | `backup.create` passed `kind` through unchecked; `backupName` falls through to the daily branch for anything not exactly `weekly`/`manual`, and the view echoed the unknown string back as a `BackupKind` | FIXED — `BACKUP_KINDS` runtime mirror; refused by name |
| 136 | NIT (`codebase_details`) | `goals.create` skipped `requireDateKey` on `startDate`; `validateGoalInput` shape-checks with a regex, so `2026-13-45` was stored and `daysBetween` parsed it to `NaN`, rendering every pace figure for that goal as `NaN`. `goals.addMilestone`'s `dueDate` *was* routed through `requireDateKey`, so the two date fields disagreed | FIXED — `startDate` validated at the boundary |
| 137 | NIT (`codebase_details`) | `BackupKind` was declared twice — `modules/data/backup.ts:16` and inline in `BackupFileView` (`shared/api.ts`) — the same duplicate-contract class as #123 | FIXED — one declaration in `shared/api.ts`, re-exported by the module |

Permanent coverage: `verify-shell` gained an `enum-validation` step (6 malformed
values refused, each with a named message, plus a valid schedule accepted) and
`verify-reading` gained `anchor-validation` (4 malformed anchors refused). Both
encode the pre-fix behaviour, so they fail against the old code.

**`zoom_out` (no Blocker, 1 Major, 13 Nits).** The Major was dead configurability
with a false comment, the `mergeSegments` shape again:

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 138 | MAJOR (`zoom_out`) | `CollectorOptions` is a configuration surface with **no configurer**: the only construction site passes `{sessionId}` and five of six options are never set by anything in `src/`, `tests/` or `spikes/`. Worse, the `/** Injected for tests. */` comment on `now` is false — no test constructs `TimeCollector` at all | RECORDED, not applied — see below |

Its Nits split into two groups. Those confirmed and left as one-line recordings
(the same shape as the already-recorded #71/#52/#130, none load-bearing):
`previousPeriod` (test-only), `habits.clear`/`goals.removeMilestone` (channels
with no caller at all — not even a verifier), `refreshTheme`, `libraryDir`,
`BookStore.archive` (and the `archived_at IS NULL` filter it makes inert),
`OpenOptions.busyTimeoutMs`, `BookStore.import`'s `meta` parameter,
`SiteGuess.basis` (documents a consumer that does not exist),
`localDateKey`'s re-export, the `folder` parameter on three notes channels, and
`Db.exec`'s docstring ("never for data") contradicting a live caller
(`notes/index.ts:184` runs a `DELETE` through it).

Those naming **real renderer duplication** join the deferred consolidation
cluster rather than being fixed here: the completion ring is implemented twice
(`Goals.tsx` already has a `Ring`; `Habits.tsx` re-derives it with the same
`r="15.5"` and magic `97.4`), the labelled bar row appears four times across
three files, and `Salah.tsx:21`'s `fmtCountdown` is a fifth duration formatter —
`formatDuration(3660)` renders `1h 01m` while `fmtCountdown(3660)` renders
`1h 1m`. That last one is measurable drift of exactly the kind rounds 1 and 4
consolidated; it is queued with the date-helper work, not folded in.

### Two corrections to this report's own record

`zoom_out` checked two earlier rows and found both imprecise. Both are corrected
rather than defended:

1. **#126's "FIXED" was misleading.** `mergeSegments` is *still* production-dead:
   `grep -rn mergeSegments src/` returns the definition plus two comments. The
   fix added a **second** implementation, `SegmentMerger`, on the ingest path;
   the batch form now has zero callers and is kept alive only as the equivalence
   oracle in `tests/hyprland-events.test.ts:211-224`. That is a legitimate design
   (the streaming form is required so a crash loses at most one flush interval),
   and the equivalence test is the strongest part of the change — but the row
   read as a call-site fix when it is "made permanently test-only". Recorded
   correctly here.
2. **The `MEDIA_DOMAINS`/`MEDIA_RULES` row is stale.** `grep -rn MEDIA_DOMAINS
   src/` returns nothing; `sites.ts:332` now reads `MEDIA_RULES` and the code
   comment there documents the change. The finding is resolved.

STACK drift is broader than recorded: §3.1 claims **Tailwind CSS v4** while
`package.json` has no Tailwind and the renderer is a hand-written `styles.css`,
and `zod` is asserted as the validation mechanism in four sections against 73
hand-written guards. Same class as the recorded §3.2 item, one section up.

### Gates after the resumed work

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (76 files) |
| `vitest run` | **400 passed** / 18 files |
| `electron-vite build` | ok, emits `out/main/ingest-worker.cjs` |
| `verify-shell` | **24/24** (was 22 — adds `enum-validation`, `enum-validation-valid-passes`) |
| `verify-time` | 16/16 |
| `verify-habits` | 29/29 |
| `verify-salah` | 29/29 |
| `verify-reading` | **28/28** (was 27 — adds `anchor-validation`) |
| `verify-notes` | 49/49 |
| `verify-goals` | 48/48 |
| `verify-polish` | 52/52 |
| `verify-sites` | 39/39 |
| Nine verifiers, total | **314 checks, 0 failed** |
| Active workspace across the full verifier run | unchanged (1 → 1) |
| `grep -rn 'from "node:sqlite"' src/` | `driver.ts` only |

### Round 6 totals

| Reviewer | Blocker | Major | Nit |
|---|---|---|---|
| `design_critic` | 0 | 2 | — |
| `codebase_details` | 0 | 2 (same two, independently) | 4 |
| `zoom_out` | 0 | 1 | 13 |

No Blocker from any reviewer. Findings resolved this round: 5 applied (2 MAJOR
found twice, 1 NIT, plus 2 more NITs), the rest recorded with a reason. The
recorded set is still dominated by the duplication cluster and by dead
configurability/accessors of the already-known `#71/#52/#130` shape.

**Round 6 is clean** by the loop's definition: no reviewer raised a Blocker or
Major that is not either fixed or settled, and all three reviewers reported.
Convergence needs two consecutive clean rounds, so the loop is not finished —
round 7 remains.

The one Major deliberately **not** applied is `#138`: removing dead
`CollectorOptions` means either inlining five constants or having a test
construct `TimeCollector`, and the latter is the real fix (the false
`/** Injected for tests. */` comment should become true rather than the option
being deleted). That is a test-infrastructure change, not a boundary fix, and it
belongs with the same consolidation change the duplication cluster is queued in.


---

# Round 7 — the missing error boundary, and an OOM I caused

Target unchanged from wave 4 (`src/renderer/**`, `src/preload/index.ts`,
`src/shared/api.ts`). Reviewers: `design_critic`, `codebase_details`, `zoom_out`,
fresh contexts. `codebase_details` had not reported when the round was resolved;
it is recorded as **not run** below, which makes the round **not clean**.

## The OOM was mine, not the app's

Before the findings: `systemd-oomd` killed **146 processes** in this session's
cgroup (`t3code-claude-4a706e60.scope`) at 16:46:15, mid-review.

Cause: `bunx vitest run` was executed four times in quick succession while
verifying, and the project had **no vitest config**, so vitest used its defaults
— the `forks` pool, one full Node process per test file, up to `nproc` (8)
concurrently, each holding its own Vite transform cache. On a 7.6 GB machine
already at 4.7 GB used with 5 GB of swap, that is enough to trip oomd.

| # | Severity | Defect | Outcome |
|---|---|---|---|
| 139 | MAJOR (tooling) | No `vitest.config.ts`. Default `forks` pool spawned up to 8 isolated Node processes; a full suite run OOM-killed 146 processes in the session cgroup | FIXED — `vitest.config.ts` pins `pool: "forks"`, `maxWorkers: 2`, `minWorkers: 1`. Peak node RSS measured **438 MB** (was tripping oomd). Config parsed-ness proved by setting `maxWorkers` to an invalid value and observing vitest's config error, then restoring |

This is the same class as the workspace-5 rule: a tooling default that damages
the user's machine while a reviewer is working. It is recorded here so the next
agent does not rediscover it by taking the machine down.

## Blocker — there is no error boundary anywhere in the renderer

`design_critic` filed this, and it is a **partial re-open of round 6's #134**.
Round 6 fixed the *write* side (`requireAnchor` at the IPC boundary); the *read*
side was never fixed, and this reviewer found that.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 140 | BLOCKER | No `ErrorBoundary`, `componentDidCatch`, `getDerivedStateFromError`, `onerror` or `unhandledrejection` anywhere in `src/` — verified: the grep returns zero matches. React 19 unmounts the entire root when a render throws, so a throw in any module blanked the window and took the sidebar — the only route back — with it. `ReadingService.highlights()` read anchors with a blind `JSON.parse(r.rects_json) as HighlightAnchor` (`service.ts:211`), and `rects_json` is a plain TEXT column with no CHECK, so a row written before round 6's guard — or by a restore of an old backup — reached `resolveAnchor`, which runs `anchor.rects.every(...)` (`anchors.ts:218`) and `normalizeText(anchor.text)` (`anchors.ts:98`) during render | FIXED — both halves below |

**Reproduced.** Not argued. Three failure modes pinned as pure functions against
the real `resolveAnchor`:

| Stored anchor | Result |
|---|---|
| `rects` as a string, rotation matches | **throws** `TypeError: anchor.rects.every is not a function` |
| missing `text`, rotation differs | **throws** (falls through to `findByText`) |
| `rects` as a string, rotation differs | does not throw; yields corrupt rects |

Then the reachability question, which is what makes it a Blocker rather than a
theory: a row written **directly into the DB** and read back through the real
`ReadingService.highlights()` reaches the render path and throws. The row does
not have to come from the guarded writer — `rects_json` has no CHECK, and
`applyPendingRestore` will restore an old backup verbatim.

The user's live database was checked read-only (copied to `/tmp` first): **106
highlights, 0 malformed**. So the crash is reachable but not currently live on
this machine.

**The fix, both halves:**

1. `src/renderer/src/components/ErrorBoundary.tsx` — one boundary around the
   module area in `App.tsx`, keyed by the active module so switching modules
   remounts it and clears the error. A throw now leaves the sidebar usable and
   names the screen that failed. This is the half that makes every *other*
   finding in this report recoverable rather than fatal.
2. `ReadingService.parseAnchor()` — validates the stored blob on read and
   degrades an unusable one to the "orphaned" anchor the reader already renders
   (`rects: []`, correct `page`/`text`), so the highlight is listed, not lost,
   and the screen does not crash.

`parseAnchor` does **not** replace `requireAnchor`; the write-side guard still
refuses malformed input. This is defence at the read side, where data can arrive
from a path the guard never saw.

Tests: `tests/reading-anchors.test.ts` gained 4 cases (malformed → no throw,
unparseable JSON → orphan, row and text preserved, valid anchor still resolves
`exact`). `tests/error-boundary.test.ts` covers the boundary's state machine.
React's server renderer does not support error boundaries, so the DOM-level
"throws → fallback" path is **not** covered by a test — recording that gap
rather than implying coverage. Covering it needs a DOM environment (jsdom),
which is a new dependency and needs approval.

## `zoom_out` — no Blocker, 1 Major-worthy cluster, nits

Every claim was reproduced with searches. Two measurement errors of mine were
caught by re-measuring: my first channel counts were `41`/`47`; the correct
figures are `67` renderer channels against `75` in the contract, which matches
the reviewer exactly. The reviewer was right and I was wrong.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 141 | MAJOR | `READER_SETTING_RANGE`'s comment (`api.ts:304-308`) says the bounds are "chosen to match what the controls can produce… the sliders run 0.25..3", but both sliders are `min={0.6} max={1.6}` (`Reader.tsx:924-925, 934-935`). No zoom control exists in the reader at all. The stated justification is false; the `zoom` max of `8` and `cropMargins` max of `0.4` have no producer. The `zoom` *min* of `0.25` **is** real (`Reader.tsx:476` clamps with `Math.max(0.25, scale)`) | FIXED — comment corrected to state the truth: the bounds are a validator's contract, not a mirror of the controls |
| 142 | NIT | Habit `icon`/`color` cross the contract on both `HabitView` and `NewHabitInput`, are validated and persisted, but no renderer reads or sends them (F-HABIT-01, MUST) | RECORDED — joins the unreachable-feature list, same shape as F-READ-04 below |
| 143 | NIT | 8 of 75 channels have no renderer caller: `goals.get`, `goals.update`, `goals.removeMilestone`, `habits.changeSchedule`, `habits.clear`, `habits.heatmap`, `notes.uri`, `sites.uncategorized`. `habits.clear` and `goals.removeMilestone` have no caller **anywhere** except the handler | RECORDED — same as `#949`/`#950`; `sites.uncategorized` remains the sole implementation of F-TIME-07's bulk-categorise |

Already-recorded ground, re-raised at the same scope and **not** re-opened:
F-READ-04's `layout`/`cropMargins`/`hideHeaders` (this report `:332`, `:393`),
`HealthReport.lastBackupAt` and the absent F-SHELL-08 status strip (`:336`,
`:399`), `fmtCountdown`'s divergence (round 6's queued duplication — though the
`45 → "0m"` case is sharper than what was written down), the bridge's
`platform`/`version` (`#71`-shaped), `savePosition.zoom` (`#57`), and the 47
no-reader contract fields (`#949`).

## `design_critic`'s remaining items — both already recorded

| Item | State |
|---|---|
| F-DASH-02/04/05/06 dashboard MUSTs not implemented | **Already recorded**, this report `:579-600`. Verified independently: `App.tsx` invokes only 8 channels, none of them `salah.*`, `habits.list` or `reading.list` |
| 8 channels with no caller | Duplicate of `#143` above |

## Gates after round 7

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` | **408 passed** (was 400; +8 across two files) |
| Peak node RSS during suite | **438 MB** (bounded pool; previously OOM-killed the cgroup) |

## Round state

- Rounds run: 7
- Blockers found: 1 (`#140`) — **fixed**
- `codebase_details`: **not run** — stopped mid-audit by the user, returning no
  report. Per the loop's rule a reviewer with no report is recorded as not run,
  never as a reviewer with zero findings.
- Round 7 is therefore **not clean**, and does not count toward convergence

## #139 follow-up — the first fix was not enough, and the real mechanism

The `#139` fix (a vitest config bounding the pool) was applied and reported.
`systemd-oomd` killed a session cgroup **again at 16:55** (129 processes, a
different scope from the 16:46 kill). So `#139` was necessary but not
sufficient, and the mechanism as written there was wrong. Corrected:

**What actually happens.** `ManagedOOMMemoryPressure=kill` is set on
`app.slice` (`/usr/lib/systemd/user/app.slice.d/10-oomd.conf`), and every
t3code agent session — including this one — lives under `app.slice`. Omarchy's
drop-in sets `DefaultMemoryPressureLimit=50%` held for
`DefaultMemoryPressureDurationSec=20s` (`/etc/systemd/oomd.conf.d/10-omarchy.conf`).
When that trips, oomd kills **all processes in the largest eligible cgroup**, not
the one that caused the pressure. That is why the counts are 146 and 129 at
once: an entire session, not a test run.

`memory.max` is `max` (unlimited) on both this session's cgroup and
`user@1000.service` — so nothing bounded a test run except vitest's own pool
size, and the *aggregate* of repeated runs against a machine whose baseline is
already ~4.9 GB used of 7.6 GB with ~5 GB of swap used.

Measured, so the numbers are not guesses:

| Config | Peak RSS, full suite | Result |
|---|---|---|
| default (no config) | unbounded, 8 forks | OOM-killed a session cgroup |
| `maxWorkers: 2` | ~343 MB | 408 pass |
| `maxWorkers: 1` | **282 MB** | 408 pass — **chosen** |
| `threads` pool, 2 | ~334 MB | 408 pass — no better |
| `isolate: false`, no parallelism | ~371 MB | **4 FAIL** — rejected |

`isolate: false` is rejected on correctness, not memory: test files share
process state and 4 tests fail. Recorded in the config comment so it is not
re-tried as an "optimisation".

**The fix is now two layers:**

1. `vitest.config.ts` — `pool: "forks"`, `maxWorkers: 1`, `minWorkers: 1`. The
   measured floor, ~282 MB.
2. `just test` — runs the suite inside `systemd-run --user --scope
   -p MemoryMax=1G -p MemorySwapMax=0`. This is the layer that actually makes
   the failure impossible: a runaway test now dies **inside its own scope**
   instead of contributing pressure that oomd resolves by killing a session.
   `just test-plain` remains for environments without `systemd --user`.

Enforcement verified rather than assumed: a process allocating 1.5 G inside a
512 M scope was killed with exit 137, the kernel OOM killer was confined to
`captest*.scope`, and the unit reported `512M memory peak` — the session
survived. `just test` passes the full 408 inside the 1 G cap.

The general lesson, recorded because it cost the user two session kills: on this
machine a memory-hungry command run under an agent session does not fail alone.
It raises system pressure until oomd picks a cgroup, and the cgroup it picks is
whichever session happens to be largest. Long-running or repeated commands
belong in a memory-capped scope from the start.

## #140 follow-up — what the boundary does and does not cover

Verified while round 8 ran, so the limits are on the record rather than implied
by "a boundary was added":

- **Covered:** every module screen. `ErrorBoundary` wraps the module area
  (`App.tsx:347-487`), keyed by the active module.
- **Not covered:** the sidebar (`App.tsx:294-317`), the top bar
  (`App.tsx:320-338`), and `CommandPalette` (`App.tsx:490`), which all render as
  siblings **outside** the boundary. Their render paths are nullable-guarded
  (`health ? …`, `day?.hijri`, `results[index] ? …`), so a throw there is not
  presently reachable — but it would not be caught if one were introduced.
- **Structurally not covered:** a throw in `App`'s own render body. The boundary
  is created *inside* `App`, so it cannot catch `App`. `main.tsx:9-13` is the
  only place a root-level boundary could live, and it has none.

The last point was the honest limit of `#140`: the fix made a *module* failure
recoverable, which is where the reproduced crash lived, but a failure in the
shell itself still blanked the window.

**Closed.** `main.tsx` now wraps `<App />` in a second, outer `ErrorBoundary`
with its own fallback (a plain centred panel, the message, and a Reload button —
there is no sidebar to point at at that level). `ErrorBoundary` gained an
optional `fallback` prop so the same component serves both positions; the module
position keeps its default in-shell fallback.

`#140` is therefore fixed at both levels: a module throw leaves the shell
usable, and a shell throw leaves a readable message and a way back.

## OOM timeline, corrected — and the 17:25/17:42 kills are not attributable to me

Two more session kills occurred after the fix (17:25 — 133 processes;
17:42 — 120 processes). Recording them honestly rather than claiming the fix
stopped everything:

| Time | Killed | Scope | Attribution |
|---|---|---|---|
| 16:46 | 146 procs | `4a706e60` | **Mine** — four back-to-back full-suite runs |
| 16:55 | 129 procs | `df40f300` | **Mine** — same pattern, before the fix |
| 17:00 | — | — | fix applied (`vitest.config.ts` + capped `just test`) |
| 17:25 | 133 procs | `ed87efdf` | **Not mine** — another agent session |
| 17:42 | 120 procs | `095e7e78` | **Not mine** — another agent session |

What is established: my session's cgroup peak is **930 MB**, well under the
2025 MB a concurrent sibling session reached, and my scope is not among the
killed. The killed scopes are gone, so their peaks cannot be read.

What is **not** established: what those two sessions were running. Multiple
agent sessions run concurrently on this machine, and oomd kills the largest
eligible cgroup, which need not be the one causing the pressure. I am not
claiming my work did not contribute to system pressure — only that the killed
cgroups are not mine and my own footprint is bounded. Stating this as
"fixed, no further kills" would overstate what the evidence supports.

**Additional mitigation applied (session-scoped).** `memory.high` on this
session's cgroup is set to 2G. Unlike `memory.max` (a hard cap that risks
killing the session), `memory.high` is a soft limit: the kernel reclaims
proactively instead of letting the cgroup drive system-wide pressure. Uploading a
session's own ceiling makes it a smaller contributor to the pressure oomd
reacts to. This does **not** survive a new session — making it stick would mean
a systemd drop-in, and `/usr/lib/systemd/user/app.slice.d/10-oomd.conf`
explicitly warns against moving these settings up to `user@.service` because it
puts the compositor back in oomd's candidate pool. Left as a per-session action
rather than a machine config change.

## Round 8 (in progress) — found while verifying the contract-integrity vector

`design_critic` returned no report on its first attempt (usage counters only) and
was resumed; the round is not clean until it files.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 144 | NIT (test coverage) | `isEventName` / `EVENT_NAMES` in `src/shared/api.ts` had **zero** coverage anywhere — `grep -rn 'isEventName\|EVENT_NAMES' tests/ spikes/` returned nothing — while the symmetric `isApiChannel`/`API_CHANNELS` pair had a full suite (`tests/api-channels.test.ts`). `bridge.on` is the path that carries the `theme-changed` and `collector-status` pushes, and it was the unguarded half | FIXED — 5 cases added: accepts every declared event, refuses non-events/non-strings, no duplicates, and no name shared with the invoke channel list |

The contract-integrity mechanism itself was verified and is sound in **both**
directions, symmetrically:

- `API_CHANNELS … as const satisfies readonly ApiName[]` proves the listed
  channels are valid names; `MissingChannel = Exclude<ApiName, …>` proves none is
  missing. Same pair for events (`MissingEvent`).
- The preload guard (`preload/index.ts:26`) refuses an unknown name before it
  reaches `ipcRenderer.invoke`, and `transportFailure` converts a rejection into
  the result union so one failed call cannot discard its `Promise.all` siblings.
  Both are covered by tests that encode the failure, not just the happy path.

`ErrorBoundary`'s outer boundary (see the `#140` follow-up above) was also
verified correct in placement: it wraps `<App />` at `main.tsx`, which is the
only position that can catch a throw in `App`'s own render body.

### Vectors checked and dismissed in round 8 (with the reason)

Recorded so a later reviewer does not have to re-derive them, and so "no
finding" is distinguishable from "not looked at":

- **19 `void window.selfos.invoke(...)` fire-and-forget calls.** Not a latent
  unhandled rejection: `preload/index.ts:39` applies `transportFailure`
  (`shared/api.ts:853`) to *every* call, so `invoke` cannot reject — a rejected
  transport becomes `{ok:false,error}` like any other failure. Unit-tested,
  including the empty-message case that would otherwise render a blank banner.
- **`setTimeout` without `clearTimeout`** at `Notes.tsx:311` and
  `Reader.tsx:809` (toast/status auto-clear). React 18+ made `setState` after
  unmount a no-op rather than a warning, so there is no crash and the timer is
  collected when it fires. Benign; not a leak.
- **Contract integrity, both directions.** `API_CHANNELS`/`EVENT_NAMES` each
  carry a `satisfies` list plus an `Exclude<…, …> extends never` completeness
  proof, so a missing entry is a compile error and an invalid one is too. The
  preload guard refuses unknown names before `ipcRenderer.invoke`.
- **Timer/effect cleanup.** `App.tsx:184,274`, `Salah.tsx:58`, `Reader.tsx:414`
  all return `clearInterval` from their effects; `Notes.tsx:286` returns
  `clearTimeout(t)` on the debounced search.

## Round 8 — `design_critic` filed three Majors; two are real defects, one is a defect in my own round-7 work

`design_critic` returned no text on its first attempt (usage counters only) and
was resumed; the retry produced this report. All three findings were reproduced
by the Elephant before any fix.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 145 | MAJOR | **Salah completion double-counted `excused`.** `recentDays` increments `logged` for *every* row (`service.ts:269`, `e.logged++` before the status tests), so `excused` is a **subset** of `logged`. The streak rule was `d.missed === 0 && d.logged + d.excused >= PRAYER_COUNT` (`log.ts:206`) and the heat cell did the same (`Salah.tsx:231-233`). Both therefore counted excused prayers twice: a day with 3 on-time, 1 excused and 1 never logged passed on four rows, awarding an **F-SALAH-11 streak day** for five prayers that were not all accounted for, and rendering the strongest "full" cell | FIXED — `log.ts` compares `d.logged >= PRAYER_COUNT`; `Salah.tsx` subtracts excused before adding it back. Reproduced first: `{logged:4, missed:0, excused:1}` returned `current: 1`, must be `0` |
| 146 | MAJOR | **`ErrorBoundary`'s documented recovery path was false — in code added in round 7.** The fallback said "pick another module from the sidebar, or reopen this one". Re-selecting the module already active calls `setActive(m)` with the same value (`App.tsx:302`), which bails out of the update, so `resetKey` never changes and `componentDidUpdate`'s `prev.resetKey !== this.props.resetKey` never fires. Only switching to a *different* module and back worked | FIXED — the fallback now carries a "Try again" button calling straight into `setState`, which does not depend on `resetKey`; the copy no longer gives unreachable advice. Reproduced by test: same-key update does not clear, different-key does |
| 147 | MAJOR | **`Analytics` had no sequence guard.** `load` awaited three invokes and committed each result unconditionally, so clicking `90d` then `7d` quickly let the slower first response land last and overwrite the newer range — the header then read "over 7 days" above 90 days of figures. `Notes.tsx:277` and `Reader.tsx` already established the sequence-guard pattern in this codebase | FIXED — `loadSeq` ref; a stale response returns before touching state |
| 148 | MAJOR | **Event payloads crossed the bridge unvalidated.** `preload/index.ts` did `handler(payload as Events[E])` with no shape check, while `invoke` has a result union to absorb a bad value. A `theme-changed` push with a missing or null `palette` makes `themeVars()` (`App.tsx:67`, `Object.entries(t.palette)`) throw inside **`App`'s own render** — above the module boundary, so it blanked the window. Reproduced: `TypeError: Cannot convert undefined or null to object` | FIXED — `isValidEventPayload` in `shared/api.ts` checks the fields the renderer dereferences; the preload drops and logs a malformed payload rather than passing it on |

**On #146 and #148 together:** round 7's `#140` claimed the boundary made render
failures recoverable. Both findings show that claim was too broad — the recovery
instruction did not work, and the most likely real-world trigger (a malformed
theme push) throws *above* the boundary. `#140` is now correct only because
these two were fixed alongside it. Recorded plainly rather than left implied.

**Test coverage added (all encode the pre-fix behaviour):**

| Where | Cases |
|---|---|
| `tests/salah-log.test.ts` | 4 — four-rows-with-one-excused does **not** qualify; five-with-one-excused does; five plain does; a miss still breaks it |
| `tests/error-boundary.test.ts` | 2 — same-key update does not clear, different-key does |
| `tests/api-channels.test.ts` | 6 — `isValidEventPayload` accepts a good theme, refuses null/missing `palette`, refuses a missing dereferenced field, refuses non-objects, keeps `collector-status` separate |
| `tests/api-channels.test.ts` | 5 — `isEventName`/`EVENT_NAMES` (#144), previously untested |
| `spikes/verify-salah.cjs` | 3 — `history-days-are-bounded`, `logged-includes-excused`, and `streak-matches-recomputation`, which recomputes the streak from the reported history rows using the correct rule and requires the app's own number to agree. The old verifier only asserted `typeof streak.current === "number"`, so it could not have caught #145 |

**One pre-existing test had to be corrected, not just added.** `salah-log.test.ts`
"treats excused prayers as accounted for" used the fixture
`day("2026-11-01", 4, 0, 1)` and expected a complete day. Under `logged`'s real
meaning that fixture is **four** of five prayers, so the test asserted the
double-count as intended behaviour. Its stated intent ("excused is not a miss")
is right and the fixture was wrong: corrected to `logged: 5`, with a comment
recording that the fixture encoded the bug. Called out because silently editing
a pre-existing test to make a fix pass is exactly the move that should be
visible.

### Gates after round 8

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` | **427 passed** (was 410) |
| `verify-salah` | **32/32** (was 29) |
| Active workspace across the verify run | unchanged (2 → 2) |
| electron clients after the run | **0** |

## FOUND WHILE VERIFYING — the verifiers write to the user's real database

Not reported by any reviewer; found by checking the live DB's mtime (20:56)
against my `just verify-salah` run at 20:56.

`src/main/index.ts:23` calls `app.setName("SelfOS")` and nothing overrides
`app.getPath("userData")` in verifier mode. So `just verify-*` opens the **real**
`~/.config/SelfOS/selfos.sqlite` and writes to it. Verifier mode guards the
window (never mapped, never focused — the workspace rule) but not the data.

**Confirmed damage from one `verify-salah` run**, by diffing the user's 14:51
manual backup against the file afterwards:

| Row | Before | After |
|---|---|---|
| `prayer_log` 2026-11-03 `isha` | `late` (logged_at 1793699475694) | **`on_time`** (logged_at 1793721379806) |
| `qada_event` | 124 rows | **129** (+5, matching the verifier's missed→repay→clear cycle) |
| `ingest_run` / `browser_visit` / `focus_event` | — | +8 / +362 / +2 |

The last row is the live collector doing its job while the window was briefly
open, not test damage. The first two are the verifier's own writes.

**Nothing was restored.** The `isha` difference cannot be distinguished from the
user having logged it themselves, and overwriting real user data on a guess is
worse than leaving it. The 14:51 manual backup is intact.

**This is the same class as the workspace-5 rule and the OOM**: a tooling default
that damages the user's own machine during an agent's work, invisible unless
someone checks.

### Fixed — verifiers run against a scratch `userData`

`src/main/index.ts` now redirects `userData` whenever `isVerifier` is true, to
`~/.cache/SelfOS-verify` (swept on boot, stable across the run so a verifier can
still assert on state it wrote earlier). `SELFOS_USERDATA` overrides it for a
probe that wants a specific directory. It runs before anything reads
`app.getPath("userData")`, so the real database is unreachable from a
verification run **by construction** rather than by everyone remembering.

Verified the only way that means anything: md5 the real database, run the
verifier, md5 it again.

| Run | Result | Real DB md5 |
|---|---|---|
| `verify-salah` | 32/32 | unchanged (`c0e7eac9…`) |
| `verify-shell` | 24/24 | unchanged |
| `verify-habits` | 29/29 | unchanged |
| `verify-reading` | 28/28 | unchanged |

Same md5 before and after all four, with `~/.cache/SelfOS-verify/` holding the
writes. The run that previously changed the user's `isha` and `qada_event` now
provably cannot. Workspace remained 2 → 2 and no `electron` client appeared.

### Two verifier assertions were ambient, not real — exposed by the isolation fix

Isolating `userData` immediately failed two checks. Both were **pre-existing test
bugs that the shared real database had been masking**, not regressions:

| Check | Why it passed before | Why it failed after | Fix |
|---|---|---|---|
| `verify-time` `real-segments-written` (`segs.length >= 2`) and `selfos-captured` | The script focuses `helium` then `"selfos"`, but verifier mode never maps its own window — so `selfos` never exists to focus. The extra segments were the user's own history in the shared DB | Fresh DB holds only what this run wrote: `helium` | Assert `>= 1` and `helium`; replaced the unobservable self-capture check with `collector-follows-focus`, which asserts the collector recorded a *focused* window with non-zero duration. Self-capture is now documented as unobservable **by construction** |
| `verify-time` `day-aggregate` | `daySummary` reads `day_aggregate`, written only on the collector's flush interval; the old DB already had a row | No aggregate existed yet | The verifier now calls `time.rebuild` (the documented path, already used by `verify-shell`) before asserting, making it deterministic |
| `verify-sites` `ingest-incremental` (`rowsNew === 0`) | Prior runs against the shared DB had drained the history | `MAX_PAGES_PER_RUN` 10 × `PAGE_ROWS` 5000 = 50k, against a 58,642-row history, so the first run is page-capped and the second legitimately finds the remainder | Assert `secondNew < firstNew` — the actual invariant (the second run does not re-read the first's rows) |

Each had been "passing" by reading machine state that had nothing to do with the
code under test. Worth recording as a class: a verifier that asserts on ambient
state passes for the wrong reason and fails for the wrong reason.

### Final gates

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` (capped scope) | **427 passed** / 19 files |
| All nine verifiers | **318 checks, 0 failed** |
| Real database across all nine | md5 **identical** before and after |
| Active workspace across all nine | unchanged (1 → 1) |
| `electron` clients after all nine | **0** |

### #146 and #148 — cross-checked against the outer boundary

`design_critic` reviewed *before* the outer boundary was applied, so two of its
sub-claims are worth resolving explicitly rather than left as "fixed":

- **"`CommandPalette`, the sidebar and the top bar render outside the boundary."**
  True of the module boundary (`App.tsx:347-487`), and it still is — but all three
  are now inside the root boundary in `main.tsx:24`, which wraps `<App />` in
  its entirety. Confirmed by reading the tree: nothing sits between `createRoot`
  and `<ErrorBoundary>` except `StrictMode`.
- **"`themeVars()` throwing in `App`'s own render is uncaught."** That was the
  sharpest part of the finding and it was correct when filed. It is now fixed
  twice over: `isValidEventPayload` stops the malformed push at the preload
  (#148), and if anything else throws in `App` the root boundary catches it.
  Repairing only one layer would have been enough for this trigger; both are in
  place because the boundary is the general defence and the validation is the
  specific one.
- **"The fallback's 'reopen this one' advice does not work."** Correct, and it was
  my own copy from round 7. Fixed in #146 with a retry button.

The `themeVars` path is also why #148 was worth a boundary-independent fix: a
validation failure degrades to a stale theme, which is cosmetic, whereas relying
on the boundary alone would show the user an error screen for a cosmetic cause.

## Round 8 — `zoom_out` filed 3 Majors, 4 Nits: the unreachable-MUST-field class

All verified by the Elephant with searches before any fix. Every one is the same
shape: contract surface built for a PRD **MUST** that nothing could author or
read — so the requirement looked met while the data sat unused.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 149 | MAJOR | **`BookView.author` had no producer and no reader, against F-READ-02 (MUST "author (from metadata when present)").** Dead at all three layers: the import wrote a literal `NULL` (`library.ts:155` `VALUES (?, NULL, …)`), the reader's `getMetadata` type declared only `Title` (`Reader.tsx:23`), and no renderer referenced it. It could not be populated by import, could not be back-filled, and was not drawn | FIXED — `Author` added to the reader's metadata type and sent on the existing `reading.setPageCount` call; threaded through contract → handler → service → store; both fields `COALESCE`d so a file omitting one cannot blank what is stored; rendered on the card |
| 150 | MAJOR | **`GoalView.description` was displayed but unauthorable, against F-GOAL-01 (MUST).** The card rendered it (`Goals.tsx:97`) and `goals.update` could set it, but that channel has no renderer caller, and the create form collected title/kind/target/unit/dates and never `description`. So it was permanently null via the UI | FIXED — the create form gained the input and the payload sends it when non-empty |
| 151 | MAJOR | **`HealthReport.browserProfiles[].lastIngestAt` computed and never read, against F-SET-07 (MUST "last ingest time").** Fetched with a per-profile DB read and displayed nowhere; the System-health table rendered only `profileDir`, `strategy`, `exists` | FIXED — the health table now shows the most recent ingest time across profiles, or "never" |
| 152 | NIT | `cacheDocument`'s third parameter `keepId` was always the same value as `bookId` at its only call site, and the doc comment justified it with a hazard that cannot arise | FIXED — parameter removed; the eviction guard uses `bookId` |
| 153 | NIT | `NoteHitView.tags` extracted, FTS-indexed, returned on every hit, and rendered nowhere — while F-NOTES-02 (MUST) requires browsing "by title, tag, and full text" | FIXED — tags render on the note row, capped at six |
| 154 | NIT | `salah.log`'s `masjid` (F-SALAH-06, SHOULD) is accepted, validated and persisted but never sent by the UI and never crosses into `SalahDayView.prayers` | RECORDED — a SHOULD, and the write path is a deliberate reserve; not worth engine changes in a review fix |
| 155 | NIT | `GoalCard`'s `onRecord(value, note?)` `note` plumbing is unreachable — the record form has one input and always calls `onRecord(value)` | RECORDED — `goals.record`'s `note` **is** used by `verify-goals`, so the channel stays; only the component prop is dead |

`zoom_out` also independently confirmed the `#141` fix landed (the false
"sliders run 0.25..3" comment is gone) and correctly declined to re-open the
recorded `#949` no-reader cluster, the `platform`/`version` pair, and
`fmtCountdown` — listing them as known rather than re-deriving them, which is the
behaviour the settled list exists to produce.

### Gates after round 8 fixes

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` (capped) | **430 passed** |
| `verify-reading` | **29/29** (was 28 — adds `book-carries-author-field`) |
| `verify-notes` / `verify-goals` | 49/49, 48/48 |
| Real database across the runs | md5 **unchanged** |
| Active workspace | unchanged (1 → 1) |

## Round 8 — `codebase_details` filed 9 Majors + 3 Nits: false claims, four of them mine

The dominant class this round: **comments and docstrings that describe behaviour
the code does not have**, several made false by edits earlier in this same wave.
All 12 were verified against both sides before fixing.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 156 | MAJOR | Dashboard KPI claimed "focused time excludes media playback". It does not: `computeDayAggregate` adds every segment ≥15 s to `focusedMs` and accumulates media separately, so a 2-hour mpv segment counts in both. Focused is screen-minus-switch-noise — which `aggregate.ts`'s own header says | FIXED — comment corrected; the tile's `sub` was "active work", which is true and left alone |
| 157 | MAJOR | `requireAnchor`'s docstring and two verifier comment blocks asserted "the renderer has no error boundary" and described the blank-window failure as current. Made false by this wave's boundary work | FIXED — all three rewritten to state the failure as historical and name the three defences now in place |
| 158 | MAJOR | `ENTRY_STATUSES`' docstring claimed `satisfies` keeps the union and the array in step. It does not — it proves only that listed strings are valid members; a member added to the union and omitted from the array still compiles. Eight other enum mirrors defer to this comment | FIXED — comment states the limit explicitly and points at `API_CHANNELS`' `Exclude<…> extends never` as the real two-way check |
| 159 | MAJOR | Reader header cited a `views://pdfjs/` scheme. No such scheme exists; the registered one is `selfos-app` (`main/index.ts:216,222`) and the constant is `selfos-app://app/pdfjs` | FIXED |
| 160 | MAJOR | Four comments justified the 0..1 `scroll_offset` invariant with "(STACK §5.2)". §5.2 is the Hyprland collector; the column is declared in §4.2 "Physical schema" (`STACK.md:318`) | FIXED — all four citations |
| 161 | MAJOR | `// Keyboard navigation (F-READ-13)` annotated plain paging. F-READ-13 is a full-screen distraction-free mode (SHOULD) that is **not implemented** — no fullscreen call or chrome-hiding state exists | FIXED — comment says so, which also records F-READ-13 as an open SHOULD |
| 162 | MAJOR | Two comments described a "status strip" fed by the collector-status push (F-SHELL-08). No `.status-strip` element exists in `styles.css` or `App.tsx` | FIXED — comments now say the push feeds the dashboard health panel, and that the strip itself is unimplemented |
| 163 | MAJOR | Two tests in `tests/error-boundary.test.ts` — written by me in this wave — asserted behaviour they could not observe: one checked only initial state, the other invoked the fallback it had just passed in. `render()` was never executed, so the fallback-vs-default branch had zero coverage while the names claimed otherwise | FIXED — three tests now call `render()` and assert the element it returns: children pass through, a supplied fallback is chosen, and the default `.module-error` path contains the message and the retry control |
| 164 | MAJOR | Two verifier steps asserted predicates that are always true: `rowsNew >= 0` and `querySelectorAll().length >= 0`. Both passed in exactly the empty case their names imply they guard | FIXED — see the note below |
| 165 | NIT | `fmtCountdown` diverges from `formatDuration`: 3900 s → `1h 5m` vs `1h 05m`; 90 s → `1m` vs `2m`; 42 s → `0m` vs `42s` | RECORDED — the round-6 duplication cluster; a countdown and a duration may legitimately differ, but nothing says so in the code |
| 166 | NIT | Three texts said the boundary is "keyed by module, so switching modules **remounts** it". It is not given a React `key`; clearing happens in `componentDidUpdate` on the same instance | FIXED — wording, including the `resetKey` prop doc |
| 167 | NIT | `READER_SETTING_RANGE`'s zoom note cited `Math.max(0.25, scale)` as the producer. That expression writes `reading_position.zoom`, a **different field**; nothing sends `BookSettingsView.zoom` | FIXED — note now states the field has no producer today |

### One finding led somewhere and then did not — recorded as it happened

Fixing `#164`'s `rowsNew >= 0` I first strengthened it to `rowsRead > 0`, and the
verifier failed with `0 read, 49072 new`. That looked like a real product bug — a
read counter that never increments while 49k rows insert. It is not:
`IngestSummaryView` (`api.ts:542`) carries only `profileDir`/`rowsNew`/`strategy`/
`error`, and `services/context.ts:175` deliberately maps only those. `rowsRead`
never crosses the IPC boundary, so the assertion was reading a field that does not
exist on the view. Corrected to `rowsNew > 0`, which the contract does carry.

Worth recording because the intermediate state looked like a finding and was not
one. The genuine, smaller observation that falls out: `rowsRead`/`rowsSkipped`
are computed in the ingest worker and never surface, so an operator cannot tell
"read 50k, inserted 2" from "read 2, inserted 2" — the F-TIME-13 robustness
signal is partly invisible. Recorded, not fixed: extending the view is a contract
change.

**Round 8 totals:** 3 Majors from `design_critic`, 3 Majors + 4 Nits from
`zoom_out`, 9 Majors + 3 Nits from `codebase_details`. No Blockers. 21 applied,
3 recorded with reasons. **All three reviewers reported** — Round 8 is the first
fully-reported round since Round 6.

### Gates after round 8

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` (capped) | **431 passed** |
| Nine verifiers | **319 checks, 0 failed** |
| Real database | md5 **unchanged** across every run |
| Active workspace | unchanged (1 → 1) |
| `electron` clients | **0** |

## Open item — the ingest summary drops its own read/skip counts

Found while fixing `#164`. Not a defect, a contract gap, and recorded as such
because extending a view type is a contract change.

`BrowserHistoryIngest.ingest()` produces `IngestResult` with `rowsRead`,
`rowsNew` and `rowsSkipped` (`ingest.ts:192-194`), and that full object crosses
the worker boundary (`ingest-worker.ts:32` `IngestReply`). The service then maps
only three fields into the view the renderer sees:

```
// services/context.ts:175
this.#lastIngest = results.map((r) => ({
  profileDir: r.profileDir,
  rowsNew: r.rowsNew,
  strategy: r.strategy,
  error: r.error,
}));
```

`IngestSummaryView` (`api.ts:542`) therefore has no `rowsRead` or `rowsSkipped`.
Consequence for an operator: the health page cannot distinguish "read 50,000
rows, inserted 2" (a healthy incremental run) from "read 2, inserted 2" (a
watermark that has silently stopped advancing — the shape of F-TIME-13's
robustness concern). Both render as `rowsNew: 2`.

The metrics exist and are already persisted per run (`ingest_run.rows_read`,
`ingest.ts:340`), so this is a view-field addition plus a mapping line, not new
work. Left open rather than applied: it widens a public contract type, which the
project's working agreement reserves for explicit approval.

Two things this is **not**: it is not the cause of any current failure (the
verifier step that surfaced it was asserting a field the view never had), and it
is not a regression — the field has been absent since the summary view was added.

## Round 9 — `zoom_out`: one Major, and it is a defect in round 8's own fix

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 168 | MAJOR | **The F-READ-02 author back-fill was gated behind a stale page count, so it could never run for an already-opened book.** The whole metadata fetch sat inside `if (book.pageCount !== loaded.numPages)` — and `page_count` is written by that same call, so any book opened once before `author` existed has a correct count, the guard is false on every later open, and `author` stays NULL forever for the entire pre-existing library. Only a book never opened since import could ever get one. `#149` was recorded FIXED; it was fixed for the create path only | FIXED — the gate is now `book.pageCount !== loaded.numPages \|\| book.author === null`, so an already-open book back-fills on its next open and then stops |
| 169 | NIT | `App.tsx:344-348` still said switching modules "remounts the boundary". The element has no React `key`; clearing happens in `componentDidUpdate`. `#166` fixed three other copies of this claim and missed this one — and `ErrorBoundary.tsx` had been corrected to say the opposite, so the two files contradicted each other | FIXED |
| 170 | NIT | Two consecutive JSDoc blocks on `setPageCount` — the old one-liner left above the new block by the F-READ-02 edit, now half-true | FIXED |
| 171 | NIT | The new "Last ingest" row used `formatClock` (HH:MM only), so an ingest from days ago rendered as if today. The sibling "last backup" row one panel away uses `formatDateTime` | FIXED — `formatDateTime`, reusing the existing helper rather than writing one |
| 172 | NIT | Contract fields with no reader, none load-bearing for a MUST: `collector.lastEventAt`/`lastFlushAt`/`lastGapAt`, `browserProfiles[].historyPath`/`watermarkUs`, `HighlightView.bookId`/`createdAt`, `PrayerSlotView.autoTime`, `GoalMilestoneView.sort`, `GoalContributionView.source`, `GoalView.startDate`, `AnalyticsView.totals.focusedSeconds`/`readingSeconds` | RECORDED — joins the `#949` cluster; every one is computed and several are tested. **One item in the filed finding was wrong and is dropped:** it listed `SalahDayView.missed` as unread, but `SalahDayView` has no such field — the `d.missed` reads at `Salah.tsx:239-253` are on the *history* row type and are used heavily. The genuinely unread pair is `SalahDayView.onTime`/`complete` (verified: `grep -rn '\.onTime\|\.complete\b' src/renderer/` is empty), which is the already-recorded `#949` cluster |
| 173 | NIT | `GoalContributionView.source`'s only producers write a literal constant, so the field advertises a provenance axis no code path can vary (F-GOAL-02's "optional auto-source") | RECORDED — the column is the seam for a feature the PRD names; a one-valued column with no reader today |
| 174 | NIT | `data.exportCsv`'s `from`/`to` params are reachable only from verifiers; the renderer sends only `table`, and `to` is passed by nothing | RECORDED — the pure `tableToCsv` helper is exercised by tests; only the channel parameters are verifier-only |

`zoom_out` explicitly checked and cleared two vectors rather than leaving them
implicit: **no** renderer re-implements a `shared/` helper any more (the only
duplication left is the completion `Ring` and the bar row, already queued from
round 6), and each recently added surface earns its place — `ErrorBoundary.fallback`
has one caller and a genuinely different presentation, `resetKey` has one caller
and is the reset path, `Analytics.loadSeq` fixes a reproduced race, and the outer
boundary is **not** redundant because the inner one is created inside `App` and
so structurally cannot catch `App`'s own render.

### The author path is now proven end-to-end, not argued

The bundled `sample-40p.pdf` has no `/Author`, so the main flow could not test
this at all — which is how the gate defect survived round 8. Added
`spikes/fixtures/author-sample.pdf` (a minimal PDF whose Info dictionary carries
`/Author (Ada Lovelace)`) and three verifier steps that run against the real app:

| Step | Asserts |
|---|---|
| `author-null-on-import` | the import path stores NULL, so the test is not passing on a pre-populated value |
| `author-card-present` | the card renders before the click (the first attempt clicked nothing and silently tested nothing) |
| `author-backfilled-on-open` | opening the book writes `"Ada Lovelace"` — the exact path the gate blocked |

Independently confirmed by a manual probe through the app: `author: null` on
import → `"Ada Lovelace"` after opening, with the title also back-filled. The
steps fail against the pre-fix gate.

**Round 9 status:** `zoom_out` reported. `design_critic` and `codebase_details`
still running — the round is not clean until they file.

### Gates after round 9 in-progress work

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean |
| `vitest run` (capped) | **439 passed** |
| `verify-reading` | **32/32** |
| Real database | md5 **unchanged** |
| Active workspace | 1 throughout |

### A lint rule caught a second-order bug in the #168 fix

Fixing the gate to read `book.author` tripped
`lint/correctness/useExhaustiveDependencies`: the load effect used `book.author`
without depending on it — a stale closure. The obvious fix (add the dependency)
is wrong here: the effect loads and rasters the document, so depending on
`book.author` would re-run the whole load the instant the back-fill wrote the
author, reloading the book the user is reading.

Taken through a ref instead (`authorRef`, matching the file's existing `pageRef`
and `scaleRef`), which gives the effect the current value without making it a
dependency. Recorded because the lint warning was load-bearing, not noise, and
because "just add the dependency" would have traded a stale read for a visible
reload.

### Round 9 in-progress verification (Elephant)

Independently verified while the remaining two reviewers ran. All clean — no
defects, and each pinned by a test so the assumption is visible rather than
implicit.

- **`lastIngestAt` units.** `design_critic` was mid-way through checking these
  when its run ended without a report. Verified: the ingester writes
  `last_ingest_at = Date.now()` (`ingest.ts:318,324`, epoch ms) and
  `formatDateTime` takes ms (`format.ts:81`). They match. The schema declares
  `last_ingest_at INTEGER` with **no default** (`0001_init.sql:30`), so a
  never-ingested profile is NULL and the row's `typeof t === "number"` filter
  drops it — `Math.max` cannot be poisoned.
- **A `0` default would render "1 Jan 1970".** Not currently possible, but that
  is an assumption about the schema, so it is now asserted: if a default of `0`
  were ever added, the health page would show a 1970 timestamp that looks real.
- **`isValidEventPayload` cannot reject a valid theme push.** Every field it
  requires is produced with a `?? FALLBACK_THEME.x` default
  (`omarchy-theme.ts:71-82`) and `palette` is always a `Record<string, string>`
  (built by a loop over `PALETTE_KEYS`, or from the fallback). So the validator
  added in #148 drops malformed pushes without silently discarding good ones —
  the failure mode that would have made it worse than no validation.
- **`Analytics`'s `loadSeq`** (#147): `++loadSeq.current` before the awaits,
  compared after, so a stale response returns before touching state. Pinned for
  the two-in-flight and three-in-flight cases.

Six tests added (`tests/review-regressions.test.ts`): 3 for the Last-ingest
expression, 3 for the sequence guard.

**Two self-inflicted test-file breaks, recorded because they were real.** Twice
in a row, appending a `describe` block to `review-regressions.test.ts` with a
Python split-and-concatenate left a dangling `describe(` opening and the file
failed to parse. `tsc` and the suite both caught it immediately, and both were
fixed by removing the stray line. The lesson is mundane and worth writing down:
splitting a file on an import line and re-appending the remainder is not a safe
way to add a block — the opening line of the block gets consumed by the split.

## Round 9 — `design_critic`: 1 Major, 4 Nits

It also returned no text on its first attempt and was resumed; the retry produced
this report. All five verified before acting.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 175 | MAJOR | **`reading.setPageCount` failed the whole call when `pageCount` was 0, discarding the metadata it had just read.** pdf.js reports `numPages === 0` for a file it can load but not page (encrypted or structurally empty), and the reader sends that value unguarded (`Reader.tsx:350`). `service.ts:119` threw `"invalid page count"`, so title **and author** were lost and the error shown was about the page count rather than the file being unreadable. Worse, the obvious retry path was closed: the count could never be corrected, so the block re-fired on every open and failed every time | FIXED — a zero now skips only the `page_count` write (SQL `CASE WHEN ? > 0 THEN ? ELSE page_count END`) and the metadata back-fill still lands. A negative or non-integer count is still refused, since that is a caller bug, not a property of the file |
| 176 | NIT | The handler checked `typeof p.pageCount !== "number"` while the service required an integer, so `12.5` passed the boundary and failed deep inside — inconsistent with `requireId`/`dayCount`/`requireRange`, which all validate at the boundary | FIXED — `Number.isInteger` at the handler, with the message naming the requirement |
| 177 | NIT | **`HabitsView.load` and `SalahView.load` had no sequence guard**, while Analytics, Notes, Reader and Sites all do. `localDate` changes underneath them on the App's 30 s `today` rollover, re-creating and re-firing `load`, so a slow load for yesterday can land after today's and write yesterday's rows under today's date. The same class was fixed in four other components and these two were missed | FIXED — `loadSeq` in both, with the check after each await |
| 178 | NIT | The root boundary's `Reload` button is the only escape, so a *persistent* throw in `App` re-mounts, re-throws and loops with no way out but quitting | RECORDED — the reviewer rates it a hardening note, not a live defect: `readTheme` always returns an object with a `palette` record (`omarchy-theme.ts:60-81`), so main cannot currently produce the payload that triggers it. Clearing the persisted theme in the fallback is the fix if it ever becomes reachable |
| 179 | NIT | `isValidEventPayload` ends `return true` for an unknown event, which is unreachable today (the closed `EVENT_NAMES` and the `isEventName` call run first) but would silently accept anything if `Events` gained a member without a matching branch | RECORDED — noted in the report; the guard is documented as deliberately shallow |

`design_critic` explicitly confirmed the things it was asked to attack and found
**correct**: both error boundaries (the reset works, `render()` is reachable and
safe, nothing renders outside the root boundary — closing the `#140` follow-up's
"structurally not covered" caveat), the `COALESCE` SQL (a blank author cannot
corrupt stored data), `Analytics`'s `loadSeq`, and the channel guard's
bidirectional proof.

**One of its five findings was a stale read and is dropped.** Its #5 checked the
`lastIngestAt` units and reported the row as rendering via `formatClock` — but
that was changed to `formatDateTime` under `#171` *after* Round 9 was launched,
so the finding describes a line that no longer exists. The units conclusion
(epoch ms, correct) matched my own independent verification.

### Gates after round 9's design_critic findings

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` (capped) | **448 passed** |
| `verify-reading` / `verify-habits` / `verify-salah` | 32/32, 29/29, 32/32 |
| Real database | md5 **unchanged** |

### Self-audit of verifier step names (round 9, awaiting `codebase_details`)

Ran the vector myself rather than waiting: grepped every step predicate for
always-true shapes (`>= 0`, `> -1`). Two hits, one real.

| Step | Predicate | Verdict |
|---|---|---|
| `verify-sites` `category-shares-plausible` | `c.share >= 0 && c.share <= 1.001` | **Fine** — the upper bound is the assertion; a share above 1 is a real defect. Not vacuous |
| `verify-reading` `session-closes` | `ended.data.activeSeconds >= 0` | **Strengthened** — a duration cannot be negative, so this could not fail. It never called `reading.reportVisible`, so zero is the *correct* value and a positive assertion would be wrong; it now asserts both counters are present integers, which is what catches the contract drifting |

Also verified that the sequence guards added under `#177` behave correctly when
the caller is a recurring interval (as Salah's 60 s tick is): a slow load is
discarded only when a *newer* load supersedes it, and successive ticks that do
not overlap both apply. Added as three tests — an over-eager guard that dropped
every load but the last would have looked correct in the two-in-flight case.

### `#175` re-examined — the zero-page path is unreachable, so it is hardening, not a live defect

`design_critic`'s Major rested on `pdf.js` reporting `numPages === 0` for a file it
can load but not page. I fixed it, then tested the premise instead of trusting it.
The premise does not hold for this build.

Two PDFs were constructed and driven through the real app:

| File shape | pdf.js result |
|---|---|
| header + catalog, no page tree | **rejected**: `Reader error: Invalid PDF structure.` |
| valid catalog with `/Type /Pages /Kids [] /Count 0` | **rejected**: `Reader error: Invalid page request.` |

Neither reaches `setPageCount`: pdf.js refuses the document and the reader shows
its error state — no crash, no boundary trip (`moduleError: false` in both runs).
Reading the worker confirms why: `numPages` is `shadow`ed from
`catalog.numPages`, and a page tree that resolves to nothing fails earlier in
`getPage` than the point where the reader would consume the count.

**So `#175` is not a live defect.** It is still worth keeping: the guard change
(`CASE WHEN ? > 0`) is one line, it is the correct semantics for the column
(a zero means "could not page this", not "this book has no pages"), and the tests
pin that a zero cannot reset a count discovered by an earlier open. What is
**wrong** is the severity and the framing — recorded as hardening against an
unreachable path, not as a defect users could hit.

This is the second time in this thread that fixing a plausible-sounding finding
led somewhere other than the finding claimed (`see the rowsRead/`ingest-increment`
episode`). Both are recorded as they happened rather than quietly dropped, because
a review that only writes down the times it was right is not a record.

## Round 9 closure — not clean, `codebase_details` not run

`codebase_details` returned no report text twice (the first run emitted nothing,
the retry emitted nothing after a further 54 minutes). Per the loop's rule it is
recorded as **not run** — a reviewer that produces no report is not a reviewer
with zero findings.

| Reviewer | Round 9 status |
|---|---|
| `zoom_out` | **Ran** — 1 Major, 7 Nits; all verified, one item corrected |
| `design_critic` | **Ran** (after a no-report retry) — 1 Major, 4 Nits; all verified, one stale read dropped |
| `codebase_details` | **NOT RUN** — no report on two attempts |

**Round 9 is therefore not clean and does not count toward convergence.** Its
findings were still resolved (see above), but a missing reviewer means the round
cannot close clean under the loop's definition.

### Round 9 findings resolved

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 168 | MAJOR | Author back-fill gated behind a stale page count, so it could never run for an already-opened book | FIXED + proven end-to-end |
| 175 | MAJOR→hardening | `setPageCount` failed the whole call on `pageCount: 0` | FIXED — and **re-examined**: the zero-page path is unreachable in this pdf.js build, so recorded as hardening, not a live defect |
| 169, 170, 171, 176, 177 | NIT | Stale remount comment; duplicate JSDoc; clock-only timestamp; boundary/ service validation mismatch; `Habits`/`Salah` missing the sequence guard | FIXED |
| 172, 173, 174, 178, 179 | NIT | Unread contract fields; one-valued `source` column; verifier-only export params; root-boundary reload loop; `isValidEventPayload`'s unreachable `return true` | RECORDED |

Plus one verifier assertion strengthened (`session-closes`, which asserted
`activeSeconds >= 0` — a duration cannot be negative), found by running the
verifier-name audit myself while the last reviewer was outstanding.

### Gates at round 9 close

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (78 files) |
| `vitest run` (capped) | **451 passed** |
| `verify-reading` | **32/32** |
| Real database | md5 **unchanged** across every run this round |
| Active workspace | 1 throughout |

### Loop state after nine rounds

| Round | Clean? | Note |
|---|---|---|
| 6 | **Clean** | all three reported; 2 Majors found and fixed |
| 7 | Not clean | `codebase_details` stopped mid-audit |
| 8 | **Clean** | all three reported; 15 Majors, 21 applied |
| 9 | Not clean | `codebase_details` produced no report twice |

Convergence needs **two consecutive** clean rounds (the loop's rule). Round 8 was
clean and Round 9 was not, so the run is not converged. The loop's cap is 5
rounds and this is round 9 — well past it — but the user has explicitly asked for
the work to continue to completion rather than stop at the cap, so round 10
follows to attempt the consecutive pair.

## Round 10 — the enum-mirror hole, closed rather than documented

Round 8 (#158) found that `ENTRY_STATUSES`' docstring overstated what `satisfies`
proves, and **fixed the comment**. That was the wrong fix: the comment describing
a real hole leaves the hole. Round 10 closes it.

Eleven `as const satisfies readonly T[]` mirrors exist in `shared/api.ts`. Only
`API_CHANNELS` and `EVENT_NAMES` had the two-way `Exclude<…> extends never` proof
that makes a union member omitted from its runtime list a **compile error** rather
than a silent runtime gap — where the guard then refuses a value the type permits.

| Mirror | Proof before | Proof after |
|---|---|---|
| `API_CHANNELS`, `EVENT_NAMES` | two-way | two-way (unchanged) |
| `ENTRY_STATUSES`, `HABIT_KINDS`, `SCHEDULE_KINDS`, `PRAYER_IDS`, `PRAYER_STATUSES`, `BACKUP_KINDS` | one-way only | **two-way added** |
| `PAGE_BACKGROUNDS`, `ZOOM_MODES`, `READER_LAYOUTS` | one-way only | **two-way added** (indexing `BookSettingsView` fields, since those have no named union) |

**Both proof forms were proven load-bearing, not decorative** — not asserted:

| Removal | Result |
|---|---|
| delete `"clean"` from `ENTRY_STATUSES` | `error TS2322: Type 'true' is not assignable to type '"clean"'` |
| narrow `READER_LAYOUTS` to `["scroll"]` | `error TS2322: Type 'true' is not assignable to type '"single"'` |
| delete `"avoid"` from `HABIT_KINDS` (proof also relaxed) | runtime test fails, naming `- "avoid"` |

The third case matters because it is the runtime half. It also caught a mistake in
my own verification: the first attempt edited a multi-line array shape and
silently matched nothing, so the test "passed" without testing anything. Re-run
against the array's real one-line form, it fails as intended. A green result from
an edit that did not apply is worth writing down.

Added `tests/api-channels.test.ts` coverage: each mirror lists exactly its expected
members, and none has duplicates. The expected lists are written out in the test,
so a silent removal from the source list is caught by the suite as well as by the
compiler.

### Round 10 reviewer status

`codebase_details` **failed twice on the same API error** — `Tool use input must
be a string or object` — before producing any report, in both the subagent-type
and a fresh invocation. Recorded as **not run** for the round, and the documented
fallback was used instead: a general-purpose agent instructed to read the persona
file first, which is still a fresh zero-context reviewer (the EGM rule forbids
forking or resuming, not choosing a different harness entry point).

### The `codebase_details` vectors, run by the Elephant

`codebase_details` failed to produce a report in rounds 9 and 10 (three separate
attempts on round 10 alone: the named subagent type twice, a general-purpose
fallback once, all on the same harness API error `Tool use input must be a string
or object`). Rather than let its vectors go unchecked, the Elephant ran them —
they are static searches, which is what makes that legitimate rather than a
substitute for a fresh reviewer.

**Vector 2 — references. All clean, including the class that failed before.**

| Cited | Resolves to | Correct? |
|---|---|---|
| `§6.3` (×3, highlight anchoring) | 6.3 Highlight anchoring | yes |
| `§2.3` (×2, process model / closed channel list) | 2.3 Process model | yes |
| `§6.2` (display overrides filter) | 6.2 Display overrides | yes |
| `§6.4` (session tracking) | 6.4 Session tracking | yes |
| `§4.2` (scroll_offset 0..1) | 4.2 Physical schema | yes |

The four `§5.2 → §4.2` corrections from round 8 hold, and no new mismatch exists.
All **16** `F-` IDs cited in the scope exist in `PRD.md`, and each was checked
against its actual requirement text rather than its existence: F-READ-05 (scroll
offset restored), F-READ-07 (highlight re-render, orphaned not dropped), F-HABIT-12
(archive keeps history), F-SET-08 (theme follows Omarchy) all say what the citing
comments claim. F-READ-13 was the one misattribution and was corrected in round 8.

**Vector 3 — duplication.** Every `src/shared/` helper is imported where it
belongs (`formatDuration` in 4 renderer files, `formatClock`/`formatBytes`/
`formatDateTime`/`formatRelative` in 2 each, `describeSchedule`/`scrollFraction` in
1). Only two local formatters remain: `fmtCountdown` (`Salah.tsx:21`, the
long-recorded divergence) and `fmtValue` (`Goals.tsx:12`, a number formatter with
no shared equivalent — not a duplicate). The completion ring is still implemented
twice with the same `r="15.5"` and magic `97.4` (`Goals.tsx:22,26` and
`Habits.tsx:370,377,379`), as recorded in the round-6 duplication cluster.

No new defects found by these vectors. The outstanding finding is the same
duplication cluster already queued, which is a refactor with its own blast radius
rather than a review fix.

**Round 10 reviewer status:** `design_critic` and `zoom_out` running;
`codebase_details` **not run** (four failed attempts across two rounds on a harness
API error, unrelated to the review content). A final stripped-down retry is in
flight; if it also fails, the round is not clean and does not count toward
convergence.

## Harness problem: the `egm:*` typed subagents fail on this machine

Rounds 9 and 10 lost reviewer time to a reproducible infrastructure failure, not to
anything in the code. Recording it because it changes how the loop's "not run"
rule should be read, and because it cost five launches.

**Symptom:** the subagent terminates early with
`API Error: Tool use input must be a string or object (error type unknown)` — in
every case after reading the persona file and while beginning to read the target
scope, so it never reaches the point of producing findings.

**What is affected and what is not** (by direct observation, this session):

| Agent type | Result |
|---|---|
| `egm:egm-design` | **fails** — 2 of 2 attempts |
| `egm:egm-codebase-details` | **fails** — 3 of 3 attempts |
| `egm:egm-zoom-out` | **fails** — 1 of 1 attempt |
| `general-purpose` (persona read from file) | **survives** — 3 running |

So the failure tracks the agent *type*, not the prompt: a long prompt, a short
stripped-down prompt, and a plain-ASCII prompt all failed under an `egm:*` type,
while the same content given to a `general-purpose` agent ran. The EGM skill's own
guidance covers this case — "otherwise spawn a general-purpose subagent and tell it
to read that persona file first" — so the fallback is the documented one, not an
improvisation. It is still a **fresh zero-context context**, which is the property
the review depends on; only the harness entry point differs.

**Consequence for the loop's rules.** A reviewer that produces no report is
recorded as **not run** (never as zero findings), and that makes its round not
clean. That still applies to every round where a reviewer died, regardless of the
cause — an infrastructure failure does not make a round clean, it just explains
why. Rounds 9 and 10 are therefore both **not clean**, and convergence still needs
two consecutive rounds in which all three reviewers actually report.

## Round 10 — `codebase_details` (via the general-purpose fallback): 1 Major, 6 Nits

It filed successfully on the fallback agent type after four failures under
`egm:*` (see the harness note above). The Major is a defect I introduced **earlier
in this same round**.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 180 | MAJOR | **The `ENTRY_STATUSES` docstring still said the enum mirrors "predate [the two-way check] and have not been converted" — while the check sits eight lines below it.** I added the proofs under the enum-mirror work earlier in round 10 and did not update the comment describing them. It is load-bearing text: four other mirrors (`HABIT_KINDS`, `SCHEDULE_KINDS`, `PRAYER_STATUSES`, `BACKUP_KINDS`) point readers here with "see `ENTRY_STATUSES` for why these exist", so every one of them was told the opposite of what the file does | FIXED — the comment now describes the proof that exists, and records that it previously said the opposite |
| 181 | NIT | The `ResizeObserver` effect justified `[doc]` with "the wrapper ref only exists after the reader mounts its canvas, which happens once the document has loaded". The canvas wrap is rendered **unconditionally** (`Reader.tsx:977`), so `wrapRef.current` is set on the first render | FIXED — behaviour kept (observing before there is content is pointless), the stated reason corrected, and the `if (!wrap) return` guard named as the thing that actually handles a missing ref |
| 182 | NIT | The "Last ingest" row called the last-backup display a "sibling row". This table has no backup row; the only one is on the Data screen (`Data.tsx:79`) | FIXED |
| 183 | NIT | `SELFOS_APP_CLASSES`' comment said Electron reports "**both**" classes; the array holds three, and the comment named `selfos` as the `productName` while `package.json` sets `productName` to `SelfOS` | FIXED — the comment now explains all three and notes the earlier version said "both" |
| 184 | NIT | `Reader.tsx`'s selection handler inlined the exact body of the shared `toNormalized` helper — identical output, but the reader already imports from that module, so a change to the normalization convention would need editing twice | FIXED — calls `toNormalized`, which the resolver path already uses |
| 185 | NIT | `addHighlight` built its anchor with the literal `anchorVersion: 1` while `ANCHOR_VERSION` exists and the reader already imports `shared/anchors` — a second source of truth for a contract version number | FIXED — uses the constant |
| 186 | NIT | The `API_CHANNELS` block comment credited both directions of the completeness proof to `_ChannelsAreComplete`; the reverse direction is actually enforced by `satisfies` on the array | FIXED — the comment now names each mechanism and its direction |

**It also verified a long list of claims and found them correct**, which is worth
recording as much as the defects: `Api` keys vs `API_CHANNELS` compared
programmatically (75/75, no duplicates, nothing one-sided); every `invoke`/`on`
name in the scope resolving to a real channel; `§2.3`/`§3.4`/`§4.2`/`§6.2`/`§6.3`/
`§6.4` and `STACK S1` all resolving to the right headings; the F-READ-13 disclaimer
accurate; `api.ts`'s pointer to `App.tsx:67` landing on the line that would throw;
and a re-implementation sweep across the whole renderer finding nothing beyond the
two reuse gaps above and one explicitly documented wrapper.

**Round 10 reviewer status:** `codebase_details` reported (fallback type).
`design_critic` and `zoom_out` were relaunched on the fallback type and are
running; the round is not clean until they file.

---

# Round 11 — the main-process contract and bootstrap

Reviewers: `design_critic`, `codebase_details`, `zoom_out` (all three ran, fresh
context, read-only). Every finding was reproduced against the code before a fix
was applied. Round 11 is **not clean**: 1 Blocker and 19 Majors were filed.

| # | Severity | Finding | Verdict | Outcome |
|---|---|---|---|---|
| 187 | BLOCKER | `app.whenReady().then(...)` had no `catch`: a throw in `Services` (corrupt DB, unopenable notes index, ENOSPC, a NaN window size) left a process holding the single-instance lock with no window, no tray and no message; every later launch focused nothing and quit | CONFIRMED by reading | FIXED — the ready body is wrapped, `dialog.showErrorBox` names the failure, `app.exit(1)` releases the lock; a corrupt notes index is deleted and rebuilt once (derived data); `readWindowState` refuses non-finite dimensions |
| 188 | MAJOR | `fileResponse` read the whole file synchronously and ignored `Range`, so a 100 MB PDF crossed the main process in one buffer while the scheme claimed `stream: true` (F-READ-15, N-PERF-05) | CONFIRMED | FIXED — streamed body, `Accept-Ranges`, `206`/`416`, `Content-Length`; `.wasm` MIME added |
| 189 | MAJOR | No channel for F-SET-06 (delete by module/range), F-SET-02 (folders), F-SET-01 (excluded apps) | CONFIRMED (`grep` found no delete path) | FIXED — `data.deleteRange` (confirmation token required, notes excluded), `system.settings`/`setSettings`, collector exclusion, Data-page UI |
| 190 | MAJOR | No daily watch total (F-TIME-06): `mediaSeconds` is local players only and the dashboard rendered it as "watch time" | CONFIRMED | FIXED — `DaySummary.watchSeconds` = local + browser, rendered with provenance |
| 191 | MAJOR | Bootstrap ran `VACUUM INTO`, a 1–2 s `integrity_check` and a full vault reindex synchronously before first paint | CONFIRMED | FIXED — backup deferred 15 s, integrity scan on demand only, notes index rebuild bounded to one retry |
| 192 | MAJOR | `applyPendingRestore` deleted `-wal`/`-shm` before taking the safety copy and copied over the live file, so a kill could lose the newest committed rows and ENOSPC could truncate the DB | CONFIRMED | FIXED — sidecars copied beside the safety copy, staged file renamed into place |
| 193 | MAJOR | `habits.create` accepted a negative/non-finite `target`, making every day "satisfied" (or none) silently; the UI's `min` never ran because create is a button, not a form | CONFIRMED | FIXED — positive-finite guard; `unit`/`icon`/`color` validated too |
| 194 | MAJOR | Tray had no Hide and no "Log prayer…" (F-SHELL-03, F-SALAH-04) and `resources/` was empty, so the icon was a 1×1 translucent pixel | CONFIRMED (decoded the PNG) | FIXED — Hide, per-prayer submenu, real 44×44 `resources/tray.png`, `verify-shell` asserts it |
| 195 | MAJOR | No autostart and no `--hidden` (F-SHELL-05, F-TIME-11) | CONFIRMED | FIXED — `src/main/autostart.ts`, `system.autostart`/`setAutostart`, health row, `--hidden` honoured |
| 196 | MAJOR | STACK §8 promised a WCAG AA gate; none existed and the fallback failed AA (`muted`/`raised` 3.16:1) | CONFIRMED (computed) | FIXED — `muted` darkened to `#b0a292` (4.65:1), `contrastRatio` + runtime warning + unit test |
| 197 | MAJOR | The browser-profile list was written twice while its comment claimed it was configuration | CONFIRMED | FIXED — one `BROWSER_PROFILES`, both readers use it, comment corrected |
| 198 | MAJOR | `last_backup_at` was stamped on every tick and launch, and never by a manual backup | CONFIRMED | FIXED — stamped only when a file is written; manual backups stamp |
| 199 | MAJOR | STACK claimed hourly snapshots were "never on a timer"; the code ran hourly against a 454 MB file | CONFIRMED | FIXED — 4-hour cadence, STACK corrected (800 MB ceiling, Sites-page error surface) |
| 200 | MAJOR | `system.theme` returned a launch-time snapshot while the watcher bypassed it; `refreshTheme` had no caller | CONFIRMED | FIXED — `theme()` reads fresh |
| 201 | MAJOR | `fileResponse`'s justification ("net.fetch cannot read file: URLs") was false for Electron 45 | CONFIRMED | FIXED — comment replaced by the streaming implementation |
| 202 | MAJOR | `goals.create`/`update` validated `startDate` but not `targetDate`, so `2026-13-45` stored and pace rendered NaN | CONFIRMED | FIXED — both fields through `requireDateKey` |
| 203 | MAJOR | `reading.savePosition` accepted a non-finite `page` into an INTEGER NOT NULL column | CONFIRMED | FIXED — finite integer ≥ 1 |
| 204 | MAJOR | `sites.categorize` validated 2 of 4 fields; `"false"` persisted as `is_distracting = 1` | CONFIRMED | FIXED — boolean guards (and `salah.log`'s `jamaah`/`masjid`) |
| 205 | NIT | App-protocol containment used a prefix test | CONFIRMED (correct by accident) | FIXED — `resolve` + `relative` |
| 206 | NIT | Two byte-identical `formatHijri` implementations | CONFIRMED | FIXED — one export, imported |
| 207 | NIT | `#ingestBusy` duplicated `#ingestRun` | CONFIRMED | FIXED — removed |
| 208 | NIT | "Today" decided in three layers; seven unreachable defaults | CONFIRMED | FIXED — boundary decides; `salah.log` routes through `dateKeyOrToday`; service params required |
| 209 | NIT | Window state written synchronously on every resize | CONFIRMED | FIXED — `before-quit` only |
| 210 | NIT | `hijriSource` could label a computed date "salah-ctl" | CONFIRMED | FIXED |
| 211 | NIT | `reading.updateNote`/`deleteHighlight` re-implemented `requireId` and accepted non-integers | CONFIRMED | FIXED |
| 212 | NIT | Preload `platform`/`version` had no producer and no reader | CONFIRMED | FIXED — removed from the bridge |
| 213 | NIT | Tray pause checkbox went stale; `setPaused` returned the request, not the state | CONFIRMED | FIXED — rebuild on tracking change, return `status().paused` |
| 214 | NIT | `launch-mode` read a switch's value as the entry point (`--user-data-dir /tmp/x`) | CONFIRMED | FIXED + test |
| 215 | NIT | Theme watcher ignored `theme.generation`; STACK claimed `fs.watch` + `smol-toml` | CONFIRMED | FIXED — generation+mtime stamp, STACK corrected, parser handles trailing comments |
| 216 | NIT | `last_backup_at` parsed twice | CONFIRMED | FIXED — one `#lastBackupAt()` |
| 217 | NIT | Doc-comment drift: `HIGHLIGHT_COLORS` history, `STACK D-04` citation, `dialog:pickBook` test comment, justfile app_id claim, api.ts app_id wording | CONFIRMED | FIXED — all corrected |
| 218 | NIT | `system.rebuildAll` absent (F-SET-07 rebuild was one day at a time) | CONFIRMED | FIXED — walks every day with raw events |
| 219 | NIT | 19 write channels return `{ ok: true }` | CONFIRMED | RECORDED — contract change, needs approval (the reviewer agreed) |

## Round 11 verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean (80 files) |
| `vitest run` | **461 passed** (6 new: summary, contrast, autostart, switch values) |
| `verify-shell` | **32/32** (was 24; +8 for the new channels, tray icon, range) |
| Real database | untouched (verifier scratch) |

**Round 11 reviewer status:** all three reported. Not clean (Blocker + Majors).

---

# Round 12 — time and site accounting

Reviewers: all three ran, fresh context, read-only. The round is **not clean**:
1 Blocker, 16 Majors and 11 Nits (design_critic), 1 Blocker, 10 Majors and 19
Nits (codebase_details), 7 Majors and 10 Nits (zoom_out). Overlaps removed, the
distinct findings were verified against the code and fixed.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 220 | BLOCKER | The "snapshot" ingest path copied only the main DB and omitted a hot journal, so the copy could be missing committed rows; the immutable fast path could also race a writer | FIXED — always copy DB + `-journal`/`-wal`/`-shm` and open the copy read-write so SQLite recovers |
| 221 | BLOCKER | Wave-3 #3's "segment closes when the inferred site changes" was not in the code: a title change only retitled, so a two-hour browser stretch was attributed to the last site | FIXED — `#onTitle` closes and reopens on a site change; test updated to the split |
| 222 | MAJOR | Provisional snapshot rows were deleted by `started_at`, but the merger can move the start backwards, leaving an orphan counted twice | FIXED — delete by `session_id` + `:snapshot` before every write |
| 223 | MAJOR | `#flush` wrote an unsplit provisional row, so an open segment crossing midnight inflated yesterday | FIXED — provisional rows go through `splitAtMidnight` |
| 224 | MAJOR | `stop()` never closed the open segment, leaving a provisional row no later event replaces | FIXED — close and commit as final; the client no longer reports a gap for its own stop |
| 225 | MAJOR | `getSystemIdleState` was given milliseconds where Electron expects seconds (120 000 s ≈ 33 h), so the measured idle signal always said "active" | FIXED — explicit ms→s conversion + test |
| 226 | MAJOR | The `windowtitlev2` address gate was empty at startup/reconnect and stale after a drop | FIXED — primed from `hyprctl -j activewindow` on connect, cleared on close |
| 227 | MAJOR | `siteUsage` reconciled history and title time with `Math.max`, under-counting disjoint intervals and contradicting its header | FIXED — union of both interval sets; header corrected; test updated |
| 228 | MAJOR | `watchTime.bySite` reused whole-domain seconds, so the breakdown could exceed the total (200% bars) | FIXED — per-domain media union from the same filtered rows; `byTitle` added |
| 229 | MAJOR | A user's `is_media` rule was ignored for history rows | FIXED — `meta.media \|\| isMediaUrl(url)` in both paths |
| 230 | MAJOR | Browser visits were not clipped at local midnight | FIXED — intervals clipped to the visit's own day |
| 231 | MAJOR | Time read `reading_session` while reading called time's rebuild (P-1 cycle) | FIXED — `computeDayAggregate(db, date, readingSeconds)`; reading passes its own total |
| 232 | MAJOR | `localDateKey` was reached through the time module by eight files; analytics imported `addDays` from goals | FIXED — `shared/dates` owns both; re-export deleted |
| 233 | MAJOR | Three hand-maintained site catalogues had drifted (`nebula.tv` media but unrecognised; 10 title-known sites uncategorised) | FIXED — one `SITE_CATALOG` derives `MEDIA_RULES`, `DEFAULT_RULES` and `SUFFIX_SITES` |
| 234 | MAJOR | No F-TIME-08 focus sessions and no F-TIME-09 7×24 matrix/trend | FIXED — migration 0003, `focus_sessions`/`longest_focus_seconds`, `analytics.activity`, previous-period delta, UI |
| 235 | MAJOR | F-DASH-02 timeline had no category colour and no prayer overlay | FIXED — category per segment + `salah.markers` + CSS markers |
| 236 | MAJOR | F-TIME-07 bulk categorisation had no renderer caller | FIXED — uncategorized list with apply-all |
| 237 | MAJOR | Reload visits were dropped and a visit first seen at 0 duration was never refreshed | FIXED — reloads kept; `ON CONFLICT … duration_us = MAX(...)` |
| 238 | MAJOR | `last_backup_at`… (round 11 residue) verified fixed | CONFIRMED |
| 239 | NIT | `sameApp` merge ignored contiguity and invented time across a hole | FIXED |
| 240 | NIT | Exclusion lowercased only one side; excluded provisional rows survived | FIXED — one `normalizeClass`, delete before return |
| 241 | NIT | `segmentsWritten` counted 10 s snapshot rewrites | FIXED — final rows only |
| 242 | NIT | `socketPath` option was accepted but not wired | FIXED |
| 243 | NIT | `maxRows` was a dead knob documented as a per-run cap | FIXED — removed; `PAGE_ROWS`/`MAX_PAGES_PER_RUN` are the constants |
| 244 | NIT | `uncategorizedDomains` scanned the whole visit table | FIXED — bounded GROUP BY + `IN` |
| 245 | NIT | `pagesForDomain` collapsed every title row to one page | FIXED — title rows keyed by title |
| 246 | NIT | `/\bX$/i` matched any title ending in x | FIXED — exact `x` |
| 247 | NIT | `#titleProfileId` cached a 0 sentinel that would fail every insert | FIXED — throws |
| 248 | NIT | Window-title `visit_time_us` used Unix µs while history uses Chrome µs | FIXED — `msToChromeTime` |
| 249 | NIT | Two subprocesses every 5 s forever while auto-paused | FIXED — 6× backoff while paused |
| 250 | NIT | Snapshot left behind on worker timeout | FIXED — cleanup on timeout |
| 251 | NIT | `dayCount` existed in three places | FIXED — one in `shared/dates` |
| 252 | NIT | `history` field on `Services` was unused | FIXED — removed |
| 253 | NIT | `hourlyProfile` comment claimed focus, summed flickers; DST fallback undocumented | FIXED — comment |
| 254 | NIT | Category `distracting` was order-dependent | FIXED — any-domain rule |
| 255 | NIT | `visits` mixed source row counts | FIXED — documented as row count, title rows excluded from the site list |
| 256 | NIT | STACK claims: pause file flag, event table, title parser, ingest constants, schema `source`/types, `smol-toml`/`fs.watch`, zod | FIXED — all corrected |
| 257 | NIT | `F-TIME-10` longest stretch / switches per hour | PARTIAL — longest stretch shipped; switches/hour recorded |
| 258 | NIT | `F-TIME-11` crash supervision, F-TIME-12/15, F-DASH-09 components | RECORDED — target architecture documented in STACK §5.2/§14 |

## Round 12 verification

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `biome check src tests` | clean |
| `vitest run` | **461 passed** |
| verifiers | M0 32/32, M2 29/29, M3 32/32, M4 32/32, M5 49/49, M6 48/48, M7 52/52, M8 39/39; M1 skipped (no Hyprland socket) |

**Round 12 reviewer status:** all three reported. Not clean.

---

# Round 13 — habits, salah and goals

Reviewers: `zoom_out` (8 Majors, 11 Nits), `design_critic` (8 Majors, 9 Nits),
`codebase_details` (3 Majors, 7 Nits). All three reported; the round is **not
clean**. Every finding was reproduced before fixing.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 260 | MAJOR | Schedule versions were rewritten: a same-day change moved the old version back one day, and a second change fell through to `ON CONFLICT … DO UPDATE` | FIXED — versions immutable; a change takes effect tomorrow (walking past occupied future dates) |
| 261 | MAJOR | "Done today" had four definitions; count habits at target were satisfied for the streak but not the KPI/ring | FIXED — one `isComplete` in `shared/habits.ts` used by all four |
| 262 | MAJOR | Two prayer-time computations; `sunriseFor` re-configured adhan and fabricated 06:00, which decides Fajr on-time | FIXED — `computeTimes` returns sunrise; the 06:00 default is gone |
| 263 | MAJOR | A past day was judged with today's clock and windows | FIXED — `timesFor(date)`/`windowsFor(date)`; `day()`/`log()` pass the target date |
| 264 | MAJOR | Goal roll-up stopped at one level and three-level trees could not be created | FIXED — parent uses `child.rollup`; any active goal can be a parent |
| 265 | MAJOR | The header's Hijri date depended on whether Salah had been opened | FIXED — `lastHijri()` computes locally when uncached |
| 266 | MAJOR | F-HABIT-10 backfill had no UI | FIXED — entry-date control (30-day window) |
| 267 | MAJOR | Archived habits' heatmaps were computed, shipped and never drawn | FIXED — excluded by default; comment corrected |
| 268 | MAJOR | An active child of a completed parent was invisible | FIXED — a child whose parent is filtered out renders as a root |
| 269 | MAJOR | F-HABIT-01 icon/colour, F-HABIT-03 direct entry, F-HABIT-04 timer/minutes had no UI | FIXED — inputs added |
| 270 | MAJOR | F-HABIT-09 only 30-day completion | FIXED — 7/30/90 exposed and rendered |
| 271 | MAJOR | F-SALAH-03 late/missed could not be logged | FIXED — buttons added |
| 272 | MAJOR | F-GOAL-01 metric link absent | FIXED (v1: free-text `source`, shown on the card; auto-sourcing recorded) |
| 273 | MAJOR | `heatmapDays` docstring and streak header described unimplemented rules | FIXED |
| 274 | MAJOR | STACK §4.2 goal enums, §7 pure-function API, §10 qada formula were wrong | FIXED |
| 275 | NIT | Past-day Isha never settled | FIXED |
| 276 | NIT | Qada floor could hide a new debt after over-repayment | FIXED — repayment clamped to outstanding |
| 277 | NIT | `entries()` unbounded | FIXED — 400-day bound |
| 278 | NIT | `minutesOf` duplicated | FIXED — `minutesOfDay` in shared/dates |
| 279 | NIT | `increment()` unguarded for boolean/avoid | FIXED |
| 280 | NIT | changeSchedule collision walk bounded to 7 | FIXED — 366 |
| 281 | NIT | Salah 30-day streak cap, goal 50-row cap, 200-char title undocumented | FIXED — documented |
| 282 | NIT | F-SALAH-07 weekly/monthly, F-GOAL-04/06, F-HABIT-11/13, C-6 editor | RECORDED/PARTIAL — C-6 editor added; the rest marked not implemented |

## Round 13 verification

| Check | Result |
|---|---|
| `tsc --noEmit` / `biome` | clean |
| `vitest run` | **463 passed** (2 new) |
| verifiers | M0 32, M2 29, M3 32, M4 32, M5 49, M6 48, M7 52, M8 39; M1 skipped (no Hyprland) |

**Round 13 reviewer status:** all three reported. Not clean.

---

# Round 14 — renderer and shared layer

Reviewers: `design_critic` (4 Blockers, 5 Majors, 7 Nits), `codebase_details`
(2 Blockers, 15 Majors, 11 Nits), `zoom_out` (1 Major, 9 Nits). All reported;
the round is **not clean**.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 283 | BLOCKER | F-SHELL-08 status strip was not rendered | FIXED — persistent strip (tracking, activity, next prayer, DB, theme override) |
| 284 | BLOCKER | F-DASH-04/05/06 dashboard cards absent | FIXED — prayer checklist, habit one-tap, currently-reading |
| 285 | BLOCKER | Delete-module select enumerated array indices, so F-SET-06 could not address a module | FIXED — `DELETE_MODULES.map`, typed `DeleteModule` |
| 286 | BLOCKER | STACK claimed `isEvalSupported: false`; the reader never set it | FIXED — passed to `getDocument` |
| 287 | MAJOR | Ctrl+1…7 missing | FIXED |
| 288 | MAJOR | No manual theme override | FIXED — auto/light/dark persisted, light tokens |
| 289 | MAJOR | No responsive layout / fixed side panels clipped | FIXED — 1100px breakpoint, single column, `.main` scrolls |
| 290 | MAJOR | `color-scheme` fixed dark | FIXED — `[data-theme]` rules |
| 291 | MAJOR | Schedule picker could create a never-due habit | FIXED — sends weekdays/timesPerPeriod |
| 292 | MAJOR | Bulk categorise ignored errors and the write chain | FIXED — routed through the chain, failures counted |
| 293 | MAJOR | Two URL allowlists disagreed on `mailto:` | FIXED — main accepts mailto |
| 294 | MAJOR | Category vocabulary local to the renderer | FIXED — `CATEGORIES` in shared/api |
| 295 | MAJOR | Progress ring duplicated | FIXED — `Ring.tsx`, circumference derived |
| 296 | MAJOR | Timeline legend coloured a different key than the bars | FIXED — both use appClass |
| 297 | MAJOR | Prayer markers divided by a literal 24 h | FIXED — `dayLengthMs` |
| 298 | MAJOR | STACK library/test/LRU/CSP/scheme/layout claims false | FIXED — corrected |
| 299 | MAJOR | README spike commands/scripts/counts wrong | FIXED |
| 300 | NIT | Heatmap max recomputed per cell | FIXED — hoisted |
| 301 | NIT | nav cursor, focus-visible, reduced motion | FIXED |
| 302 | NIT | Header lacked the Gregorian date | FIXED |
| 303 | NIT | `PRAYER_COUNT` retyped as "five" | FIXED |
| 304 | NIT | temp helper doc, zoom custom option, analytics activity error, palette fuzzy | FIXED/simplified |
| 305 | NIT | Dead contract surface (habits.clear/heatmap, goals.update, notes.uri, focusSessions), useSeq duplication, reader text-layer a11y, media marker | RECORDED |

## Round 14 verification

| Check | Result |
|---|---|
| `tsc` / `biome` | clean |
| `vitest` | **463 passed** |
| verifiers | M0 32, M2 29, M3 32, M4 32, M5 49, M6 48, M7 52, M8 39; M1 skipped |

**Round 14 reviewer status:** all three reported. Not clean.

---

# Round 15 — reading and notes

Reviewers: `design_critic` (1 Blocker, 3 Majors, 6 Nits), `codebase_details`
(1 Blocker, 5 Majors, 5 Nits), `zoom_out` (4 Majors, 5 Nits). All reported;
not clean.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 306 | BLOCKER | `fs.watch(recursive)` is macOS/Windows only, so on Linux the notes watcher threw and never started — F-NOTES-06 unmet | FIXED — 2 s mtime-poll fallback on Linux |
| 307 | BLOCKER | STACK §9 claimed a write audit table that does not exist | FIXED — claim struck, atomic-write note added |
| 308 | MAJOR | `get(id)` was `list().find()`, and `list()` called `progress()` per book: O(n²)+N+1 | FIXED — indexed point query |
| 309 | MAJOR | `setLibraryDir` kept old paths but `resolveFile` required the new root: every old book unopenable | FIXED — known-roots set, old root retained |
| 310 | MAJOR | Import hashed with `readFileSync` (whole PDF resident) | FIXED — 1 MiB `readSync` loop, constant memory |
| 311 | MAJOR | Notes read reading's `highlight`/`highlight_note` tables (P-1) and duplicated the query | FIXED — shared `loadHighlights(db, bookId)` |
| 312 | MAJOR | `startsWith` containment in `resolveFile` | FIXED — shared `isInside` (resolve+relative) |
| 313 | MAJOR | STACK named chokidar/yaml/zod that are not dependencies | FIXED — corrected |
| 314 | MAJOR | Export-marker comment said count-keyed | FIXED — content-keyed stated |
| 315 | NIT | `createIfAbsent` not atomic | FIXED — temp→rename |
| 316 | NIT | `reading_position.zoom` unclamped on read | FIXED |
| 317 | NIT | Anchor version mismatch trusted v1 rects | FIXED — falls through to text search |
| 318 | NIT | Inline `require("node:fs")` in #writeNote | FIXED — top-level import |
| 319 | NIT | `.selfos-tmp` litter after a crash | FIXED — 24 h sweep on index |
| 320 | NIT | Note newlines broke the blockquote; firstLines comment; duplicate setPageCount doc | FIXED |
| 321 | NIT | Reading writes time's aggregate by direct import | RECORDED — minimal cross-module call, documented |

## Round 15 verification

| Check | Result |
|---|---|
| `tsc` / `biome` | clean |
| `vitest` | **464 passed** (1 new) |
| verifiers | all green (M0 32, M2 29, M3 32, M4 32, M5 49, M6 48, M7 52, M8 39; M1 skipped) |

**Round 15 reviewer status:** all three reported. Not clean.
