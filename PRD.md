# SelfOS — Product Requirements Document

**Status:** Draft v0.1 · **Date:** 2026-11-02 · **Owner:** saboor
**Companion document:** [`STACK.md`](./STACK.md) — every technology choice, rationale, and verification behind this PRD. Each requirement below is tagged with the stack section that implements it.

---

## 0. How to read this document

This PRD defines **what** SelfOS is and **why** each behaviour exists. It deliberately contains no framework, library, or schema-level decisions; those live in `STACK.md`. Where a requirement depends on a platform capability, the dependency is named in a **Constraint** note rather than chosen here.

Requirement IDs are stable (`F-*` functional, `N-*` non-functional, `D-*` data). The acceptance criteria are written so that each can become a test.

---

## 1. Summary

SelfOS is a **single-user, local-first personal operating system for the desktop**: one window that reads your books, tracks your habits, measures where your screen time actually goes, logs your prayers, records notes into your existing Obsidian vault, and rolls progress and goals into one honest daily picture.

It is **not** a website, not a cloud service, and not a bundle of seven disconnected utilities. Its defining product property is the **cross-module timeline**: reading time, focus time, prayer completion, habit streaks, and goal progress all land on the same day view, computed from the same local database.

### One-sentence positioning

> The app that tells you, at the end of a day, what you actually did — read, built, prayed, wasted — and what it cost.

### Why now

The user's desktop already produces the raw material: Hyprland knows the focused window, Helium's history records real dwell time, an existing `salah-daemon` fires adhan alarms, and an Obsidian vault holds notes. SelfOS is the missing **ledger and dashboard** that unifies them. The hard part is not collecting data; it is making the collection trustworthy and the summary honest.

---

## 2. Goals and non-goals

### 2.1 Goals

| # | Goal | Measure of success |
|---|---|---|
| G1 | One daily view answers "where did my time go and did I do what I intended?" | Dashboard renders in < 1 s and is accurate to within 60 s of real activity |
| G2 | Every tracked number is traceable to a source event | Any daily total can be drilled down to the rows that produced it |
| G3 | Tracking runs without user discipline | Screen time and site time require zero manual logging; only habits and prayers are manual |
| G4 | Reading and note-taking are usable daily, not demos | A 300-page PDF is readable with highlights, notes, and restored position |
| G5 | The app survives its own failure | A crashed tracker, a corrupt row, or a dead browser never blocks the UI or loses data |
| G6 | Data is portable and private | Full export to JSON/CSV; no network egress of personal data |

### 2.2 Non-goals (v1)

- **N1 — Multi-user / accounts.** No login, no tenancy, no server.
- **N2 — Cloud sync.** Single device only. Schema is migration-ready for sync later, but no sync code ships.
- **N3 — Mobile / web clients.** Linux desktop only.
- **N4 — macOS / Windows.** Explicitly deferred (see §3.3).
- **N5 — Building a note editor.** Obsidian remains the note app; SelfOS links to it.
- **N6 — Social features, leaderboards, sharing.**
- **N7 — AI features.** No LLM summarization, recommendations, or chat in v1.
- **N8 — Media library management** (no torrenting, no streaming-service integrations, no DRM).

### 2.3 Success definition for v1

The user opens SelfOS every day for **30 consecutive days** without a manual fallback (no external time tracker, no separate habit app, no separate prayer log) and the dashboard numbers match their memory of the day.

---

## 3. Users, platforms, and operating assumptions

### 3.1 Primary user

A single technically capable Linux user (the owner) who:
- runs **Omarchy on Hyprland (Wayland)**, currently Hyprland 0.56.2;
- browses in **Helium** (Chromium-based, supports Chrome extensions);
- keeps notes in **Obsidian**;
- already runs a **salah/adhan stack** (Quickshell bar widget + systemd daemon + CLI);
- reads PDFs (religious/seerah material, textbooks, papers) and wants typographic control.

### 3.2 Platform assumptions

| Assumption | Value | Consequence for requirements |
|---|---|---|
| Compositor | Hyprland on Wayland | Active-window data comes from Hyprland IPC, **not** X11 polling (C-1) |
| Shell | Omarchy | Theme is read from the Omarchy state dir (C-2) |
| Desktop runtime libs | GTK 3, WebKitGTK 4.1, libayatana-appindicator, librsvg | Present on this machine; the tray and GTK integration depend on them (C-3) |
| Resources | ~1.6 GB RAM free, ~25 GB disk free | Cannot copy large browser DBs; must stream/attach read-only (C-4) |
| Display | Single 1896×1026-class viewport | Layout must work at 1280×720 minimum |

### 3.3 Explicitly deferred platforms

macOS and Windows are out of scope for v1, but the architecture must not *prevent* them. The rule: **all OS integration sits behind a named adapter interface** (see F-TIME-09 and `STACK.md` §6). No module may call `hyprctl` directly from UI code.

---

## 4. Product model (how the pieces fit)

SelfOS has **one shell** and **seven modules**, plus a cross-cutting **timeline**.

```
                    ┌──────────────────────────────┐
                    │        Dashboard / Day        │  ← the product's face
                    │  (timeline, streak, next salah)│
                    └───────────────┬──────────────┘
                                    │ reads one SQLite DB
   ┌──────────┬──────────┬──────────┼──────────┬──────────┬──────────┐
   │ Reading  │ Habits   │ Screen & │  Salah   │  Notes   │ Progress │
   │ (PDF)    │          │ Watch    │          │ (Obsidian│  & Goals │
   │          │          │  Time    │          │  links)  │          │
   └──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
                                    │
                    ┌───────────────┴──────────────┐
                    │   Collectors (background)     │
                    │  Hyprland IPC · browser hist. │
                    │  systemd salah-daemon (read)  │
                    └──────────────────────────────┘
```

**Design principle P-1 — Modules never read each other's tables directly.** They communicate through a small set of **derived views** and **events** (e.g. "a focus session ended", "a reading session ended", "a prayer was logged"). This is what makes each module independently testable and keeps the cross-module timeline coherent.

**Design principle P-2 — Collection is separate from presentation.** Collectors write raw facts; modules compute meaning. A module can be deleted and its raw data remains.

**Design principle P-3 — Every derived number is reproducible.** Streaks, totals, and progress are computed from raw events, never stored as the source of truth (caches allowed only if rebuildable).

---

## 5. Functional requirements

Legend: **MUST** = v1 blocker · **SHOULD** = v1 target · **MAY** = v1 if time allows.

### 5.1 Shell and navigation (F-SHELL)

| ID | Requirement | Priority |
|---|---|---|
| F-SHELL-01 | The app opens to a **Dashboard** showing today at a glance. | MUST |
| F-SHELL-02 | A persistent sidebar navigates to Reading, Habits, Time, Salah, Notes, Progress/Goals, Settings. | MUST |
| F-SHELL-03 | The app has a **tray icon** with: show/hide, "start/stop tracking", "log prayer…", quit. | MUST |
| F-SHELL-04 | Closing the main window **hides** the app; tracking and reminders continue. Quit is explicit. | MUST |
| F-SHELL-05 | The app launches on login (systemd user unit) and starts minimized to tray. | SHOULD |
| F-SHELL-06 | Keyboard: `Ctrl+1…7` jumps to modules; `Ctrl+K` opens a command palette (search books, notes, actions). | SHOULD |
| F-SHELL-07 | Window remembers size, position, and maximized state across restarts. | SHOULD |
| F-SHELL-08 | A **status strip** always shows: tracking state (on/paused), current activity, next prayer countdown, and DB health (last backup). | MUST |
| F-SHELL-09 | The app never blocks the UI on I/O; every list has an explicit loading, empty, and error state. | MUST |
| F-SHELL-10 | Single-instance enforcement: launching twice focuses the existing window. | MUST |

### 5.2 Reading (F-READ)

Scope decision: **PDF only**, with **display overrides on the original page** (no text reflow). Reader depth: **highlights + notes**.

| ID | Requirement | Priority |
|---|---|---|
| F-READ-01 | Import PDFs from a file picker or by drag-and-drop into the app; copies are stored in a managed library folder; the original path is recorded. | MUST |
| F-READ-02 | A library view lists books with cover/first-page thumbnail, title, author (from metadata when present), page count, progress %, last-read time, and a "currently reading" section. | MUST |
| F-READ-03 | Open a book and render pages faithfully (text, images, tables, vector art) with **selectable text**. | MUST |
| F-READ-04 | **Display overrides**, per book and globally: page background (original / dark / sepia / black), invert or brightness/contrast adjustment for scanned documents, zoom, fit-width vs fit-page, continuous scroll vs single-page, margin crop, and hide page headers/footers where the text layer allows. | MUST |
| F-READ-05 | **Reading position is saved continuously** (debounced) and restored on reopen, including the exact scroll offset within a page. | MUST |
| F-READ-06 | Progress is tracked as page + percent; a reading session is recorded with start, end, pages turned, and active seconds. | MUST |
| F-READ-07 | **Highlights**: select text → choose one of ≥4 colors → highlight persists and re-renders on the exact text range after restart and after window resize/zoom change. | MUST |
| F-READ-08 | **Notes on highlights**: attach a free-text note to any highlight; edit and delete it. | MUST |
| F-READ-09 | A per-book **annotations panel** lists all highlights and notes, each clickable to jump to its page. | MUST |
| F-READ-10 | Every highlight/note can be **exported to Obsidian** as a markdown block (quote, page number, book title, link back to the book in SelfOS) into a chosen vault folder. | SHOULD |
| F-READ-11 | Search within a book returns page-numbered results and highlights the matched text. | SHOULD |
| F-READ-12 | Bookmarks (named page markers) independent of highlights. | SHOULD |
| F-READ-13 | Reader is **distraction-free**: full-screen reading mode hides the shell chrome. | SHOULD |
| F-READ-14 | Reading time feeds the daily "reading" total and any duration-based habit (e.g. "read 30 min"). | MUST |
| F-READ-15 | Large PDFs (≥ 100 MB, ≥ 800 pages) open without freezing the UI; pages render on demand and are cached with a bounded memory budget. | MUST |
| F-READ-16 | Copying text from the page works and preserves line breaks sensibly. | SHOULD |
| F-READ-17 | Two-page spread mode for landscape documents. | MAY |
| F-READ-18 | OCR for scanned PDFs (making them highlightable). | MAY (see N-*) |

> **Constraint C-5:** Highlight persistence depends on a stable text-range representation across renderer versions. The stack document must specify the anchor format and a migration path (see `STACK.md` §7.3).

> **Note on constraint IDs:** `C-n` identifiers are **local to this document**. `STACK.md` uses its own `C-n` and `S-n` numbering for a different set of constraints and risks; always cite them as "PRD C-n" or "STACK C-n" when crossing documents.

### 5.3 Habits (F-HABIT)

Scope: **boolean, count/quantity, duration, and negative/avoidance** habits, with daily and weekly schedules.

| ID | Requirement | Priority |
|---|---|---|
| F-HABIT-01 | Create a habit with: name, icon/color, type (boolean, count, duration, negative), unit (for count/duration), daily target, and schedule. | MUST |
| F-HABIT-02 | **Boolean**: one-tap "done" per day; un-done by tapping again. | MUST |
| F-HABIT-03 | **Count**: increment/decrement and direct entry against a daily target (e.g. 8 glasses, 10 000 steps). Partial completion is recorded, not just pass/fail. | MUST |
| F-HABIT-04 | **Duration**: enter minutes or run a timer; partial time counts toward the target. | MUST |
| F-HABIT-05 | **Negative/avoidance**: each day is "clean" or "slipped"; a slip records an optional reason; the streak counts clean days. | MUST |
| F-HABIT-06 | **Schedules**: every day, specific weekdays, N times per week, or N times per month. Off-schedule days never break a streak. | MUST |
| F-HABIT-07 | **Skips / excused days**: mark a day as skipped; it neither breaks nor extends the streak. | MUST |
| F-HABIT-08 | **Streaks** computed from schedule + completion + skips, with current and longest streak per habit. | MUST |
| F-HABIT-09 | **Completion rate** over 7/30/90 days, and a calendar heatmap per habit. | MUST |
| F-HABIT-10 | **Backfill**: edit any past day within a configurable window (default 30 days). | MUST |
| F-HABIT-11 | **Reminders**: per-habit optional notification time(s), suppressed when already complete. | SHOULD |
| F-HABIT-12 | **Archive** a habit without deleting history. | MUST |
| F-HABIT-13 | Habits can be **linked to another module's data**: e.g. "read 30 min" auto-completes from reading sessions; "pray on time" auto-completes from salah logs. | SHOULD |
| F-HABIT-14 | Today view: all habits for today with a single progress ring; one-tap completion from the dashboard. | MUST |
| F-HABIT-15 | Reordering habits via drag. | SHOULD |

> **Constraint C-6:** A habit's schedule can change over time. Historical streaks must be computed against the schedule **in effect on that date**, so schedule changes must be versioned, not overwritten (see `STACK.md` §7.2).

### 5.4 Screen time and watch time (F-TIME)

Scope decision: **full screen time + heavy analytics**, with media viewing surfaced as a first-class "watch time" metric. Primary source: **browser history parsing**; fallback: **window-title parsing**.

| ID | Requirement | Priority |
|---|---|---|
| F-TIME-01 | A background collector records the **focused window** (app class, title, workspace) continuously while the session is unlocked, with second-level resolution. | MUST |
| F-TIME-02 | Collector **pauses** when the session locks, the screen sleeps, or the user pauses tracking; idle gaps are never attributed to the last app. | MUST |
| F-TIME-03 | **App time**: total focused time per application per day, with a timeline showing switches. | MUST |
| F-TIME-04 | **Website time** from browser history: per-domain and per-page dwell, with real durations (not inferred from gaps between visits). | MUST |
| F-TIME-05 | **Fallback** when history is unavailable (browser locked, missing, or a site not in history): derive site/page from the window title and attribute focused time to it. The UI must indicate which source produced each number. | MUST |
| F-TIME-06 | **Watch time**: time spent on recognized media — streaming sites (YouTube, Netflix, Twitch, etc.), video URLs, and local media players (mpv/VLC). Shown as a distinct daily total and per-title breakdown where detectable. | MUST |
| F-TIME-07 | **Category rules**: user-defined domain→category mapping (e.g. `youtube.com` → Entertainment, `github.com` → Work) with a default ruleset; unknown domains land in "Uncategorized" and are easy to categorize in bulk. | MUST |
| F-TIME-08 | **Focus sessions**: contiguous stretches on a single app/domain above a threshold (default 5 min), counted per day; total focused hours. | MUST |
| F-TIME-09 | **Analytics surface**: day/week/month views; top apps, top sites, top categories; a 24-hour stacked timeline; a 7×24 heatmap of activity; trend vs previous period; "first activity" and "last activity" times. | MUST |
| F-TIME-10 | **Distraction report**: time in user-marked "distracting" categories, longest single stretch, and number of switches per hour. | SHOULD |
| F-TIME-11 | The collector is **robust**: if Hyprland restarts or the socket drops, it reconnects; if it crashes, it restarts and does not double-count the gap. | MUST |
| F-TIME-12 | **Manual correction**: the user can exclude an app/domain, merge misattributed sessions, or mark a period as "not tracked". | SHOULD |
| F-TIME-13 | History ingestion is **incremental** (watermark per browser profile), idempotent (re-running never duplicates), and never mutates the browser's database. | MUST |
| F-TIME-17 | Because the browser's database is locked while the browser runs, ingestion uses a **temporary consistent snapshot**. Snapshots are bounded in size, deleted immediately after use, and reported on the health page. The user is told once, in plain language, that site time comes from a snapshot of browser history. | MUST |
| F-TIME-14 | Multiple browser profiles (e.g. Helium `Default` and `Profile 2`) are supported, each identified separately and attributable to the same browser app. | MUST |
| F-TIME-15 | Retention: raw window events are downsampled after a configurable period (default 90 days) into hourly aggregates; daily aggregates are kept forever. | SHOULD |
| F-TIME-16 | All tracking can be paused from the tray with one click, and the paused state is visible everywhere. | MUST |

> **Constraint C-1:** Wayland forbids global X11-style window inspection. The collector must use Hyprland's IPC event socket (`socket2`), not `xdotool`/`xprop`. This is a hard architectural constraint, not a preference.
> **Constraint C-4:** Browser history databases can be hundreds of MB (observed: 454 MB). They must be read in place, read-only, without copying.
> **Constraint C-7:** Chromium history timestamps are microseconds since 1601-01-01 and `visit_duration` is microseconds; conversion and timezone handling must be centralized and tested.

### 5.5 Salah (F-SALAH)

Scope: **prayer logging + qada debt**, integrating with — not replacing — the existing adhan stack.

**Existing system (discovered, not assumed):** a Python `salah-ctl` computes astronomical times (Karachi 18°/18°, Hanafi Asr) and plays adhan via mpv; `salah-daemon` (systemd, 20 s poll) triggers alarms and manages wake timers; a Quickshell bar widget displays next prayer. **It has no concept of whether a prayer was performed.** That gap is this module's reason to exist. See `STACK.md` §5.4 and §10 for the integration contract.

| ID | Requirement | Priority |
|---|---|---|
| F-SALAH-01 | Display today's five prayers with times **sourced from the existing stack's status interface** (single source of truth for times), not recomputed independently. | MUST |
| F-SALAH-02 | If the existing stack is unavailable, fall back to local astronomical computation with the same method (18°/18°, Hanafi) and clearly flag the fallback. | MUST |
| F-SALAH-03 | Log each prayer as **on-time**, **late** (performed after its window's preferred end), **missed**, or **excused** (travel/illness/menstruation), with the time of logging. | MUST |
| F-SALAH-04 | One-tap logging from the dashboard, the salah module, and the tray; logging is idempotent and editable later the same day. | MUST |
| F-SALAH-05 | **Qada debt**: missed prayers accumulate per prayer (Fajr…Isha); marking a qada performed decrements the debt and records the make-up date. Debt is shown per prayer and in total. | MUST |
| F-SALAH-06 | **Jamaah** flag per prayer (prayed in congregation), optional masjid name. | SHOULD |
| F-SALAH-07 | **Hijri date** display and a daily/weekly/monthly **prayer completion heatmap**. | MUST |
| F-SALAH-08 | **Ramadan mode**: fasting log per day, tarawih flag, and suhoor/iftar times from the same time source. | SHOULD |
| F-SALAH-09 | The app **never plays adhan audio itself** while the existing stack owns alarms; it may offer a "test" action that calls the existing CLI, and must not create competing alarms. | MUST |
| F-SALAH-10 | A **settings bridge**: changing calculation angles, city, or per-prayer custom times from SelfOS writes to the existing config format (round-trip safe) or is disabled if the schema would be lost. | SHOULD |
| F-SALAH-11 | Streak of days with all five prayers logged (not necessarily on-time), with excused days excluded. | SHOULD |
| F-SALAH-12 | Salah completion can feed a linked habit (F-HABIT-13). | SHOULD |

> **Constraint C-8:** The existing stack stores state in `/tmp` and a JSON config. SelfOS must treat it as an **external system with a contract** (its `status` JSON), tolerate its absence, and never write to its state file. Any write integration must be additive and reversible.

### 5.6 Notes (F-NOTES)

Scope decision: **integrate Obsidian; do not build a note editor.**

| ID | Requirement | Priority |
|---|---|---|
| F-NOTES-01 | The app detects and lets the user select one or more **Obsidian vault folders**. | MUST |
| F-NOTES-02 | A **read-only note browser**: list/search markdown files by title, tag, and full text, with a rendered preview. | MUST |
| F-NOTES-03 | **Open in Obsidian**: any note opens in Obsidian via its URI scheme, optionally at a heading. | MUST |
| F-NOTES-04 | **Full-text search** across the vault (body, headings, tags) with highlighted snippets. | MUST |
| F-NOTES-05 | **Write-back is limited and explicit**: export book highlights/notes (F-READ-10), and create a daily note stub from the dashboard. All writes are user-initiated and go to a configured folder. | MUST |
| F-NOTES-06 | The index updates when files change outside the app (file watcher, debounced), without full re-index. | MUST |
| F-NOTES-07 | **Quick capture**: from the command palette, append a line/idea to today's daily note or an inbox note. | SHOULD |
| F-NOTES-08 | **Link SelfOS entities to notes**: attach a note path to a book, habit, or goal; show backlinks from SelfOS entities. | SHOULD |
| F-NOTES-09 | The app never edits or reformats an existing note except through explicit user actions, and never deletes notes. | MUST |
| F-NOTES-10 | The vault path is configurable and the app degrades gracefully if it moves. | MUST |

> **Constraint C-9:** A read-only-by-default stance is a **safety requirement**, not a limitation: the vault is the user's primary knowledge store and may be synced elsewhere. Writes must be minimal, atomic, and never rewrite user content.

### 5.7 Progress and goals (F-GOAL)

Scope: **progress tracker + goal tracker**, unified.

| ID | Requirement | Priority |
|---|---|---|
| F-GOAL-01 | Create a **goal** with: title, description, type (numeric target, milestone checklist, or recurring quota), start date, target date, and optional link to a habit/module metric. | MUST |
| F-GOAL-02 | **Numeric goals**: current value / target, with manual updates and an optional auto-source (reading pages, focus hours, prayer completion). | MUST |
| F-GOAL-03 | **Milestone goals**: an ordered checklist with dates; progress = completed/total. | MUST |
| F-GOAL-04 | **Recurring quota goals** (e.g. "12 books this year"): progress derived from linked module events. | SHOULD |
| F-GOAL-05 | Progress is displayed as a ring/bar with **projected completion date** based on current pace, and a warning when off-pace. | MUST |
| F-GOAL-06 | **Progress dashboard**: all active goals, their pace, and this week's contribution. | MUST |
| F-GOAL-07 | **Archive / complete / abandon** a goal with a reason; history is retained. | MUST |
| F-GOAL-08 | Goals can be **nested** (annual → quarterly → weekly) with roll-up. | SHOULD |
| F-GOAL-09 | Every goal shows **which raw events contributed** to its current value. | SHOULD |

### 5.8 Dashboard and daily timeline (F-DASH)

The dashboard is the product. It must be honest, dense, and fast.

| ID | Requirement | Priority |
|---|---|---|
| F-DASH-01 | **Today header**: Gregorian + Hijri date, day number, and "first activity" time. | MUST |
| F-DASH-02 | **24-hour timeline**: a single horizontal band showing app/site activity colored by category, with media segments marked, and prayer times overlaid as markers. | MUST |
| F-DASH-03 | **KPI row**: focused time, screen time, watch time, reading time, habits completed (n/N), prayers logged (n/5), current best streak. Each KPI is clickable to its module. | MUST |
| F-DASH-04 | **Next prayer** countdown and today's prayer checklist with one-tap logging. | MUST |
| F-DASH-05 | **Today's habits** with one-tap completion. | MUST |
| F-DASH-06 | **Currently reading** card with progress and a "resume" action. | MUST |
| F-DASH-07 | **Goals at risk**: goals off-pace this week, with the reason. | SHOULD |
| F-DASH-08 | **Daily reflection**: a one-line prompt whose answer is written to the daily note in Obsidian. | SHOULD |
| F-DASH-09 | Week and month views reusing the same components with period selectors. | MUST |
| F-DASH-10 | The dashboard must load from cached aggregates and never wait on the collectors. | MUST |

### 5.9 Settings and data management (F-SET)

| ID | Requirement | Priority |
|---|---|---|
| F-SET-01 | Configure tracked/excluded apps and domains; category rules; media-site list. | MUST |
| F-SET-02 | Configure library folder, vault folder(s), data folder, and backup folder. | MUST |
| F-SET-03 | **Export**: full JSON export and per-module CSV export. | MUST |
| F-SET-04 | **Backup**: automatic daily SQLite backup with retention (e.g. 14 daily + 8 weekly), plus manual backup/restore. | MUST |
| F-SET-05 | **Import** a previous export (restore into a fresh DB). | SHOULD |
| F-SET-06 | **Delete data** by module and by date range, with confirmation. | MUST |
| F-SET-07 | A **health page**: collector status, last ingest time, DB size, row counts, last backup, and a "rebuild derived data" action. | MUST |
| F-SET-08 | Theme follows the Omarchy theme automatically (C-2), with a manual override. | MUST |

---

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| N-PERF-01 | Cold start to interactive dashboard ≤ 2 s on the target machine. |
| N-PERF-02 | Dashboard period switch (day/week/month) ≤ 300 ms from cache. |
| N-PERF-03 | The UI stays ≥ 55 fps while scrolling a PDF; page rasterization happens off the UI thread. |
| N-PERF-04 | Collector steady-state CPU < 2% average; idle (screen locked) < 0.5%. |
| N-PERF-05 | Memory: app ≤ 600 MB with a 300-page PDF open; history ingestion must not buffer an entire DB in memory (C-4). |
| N-PERF-06 | Any query on the dashboard is indexed; no full table scan on the hot path. |
| N-REL-01 | No data loss on crash: WAL mode, atomic writes, and a write-ahead ingest watermark. |
| N-REL-02 | A corrupt or partially ingested browser DB never crashes the app; it is skipped and reported in health. |
| N-REL-03 | Schema migrations are versioned, forward-only, and backed up before running. |
| N-REL-04 | The collector resumes correctly after suspend/resume and compositor restart without double-counting. |
| N-SEC-01 | No personal data leaves the machine. No analytics, no crash reporting, no remote logging. |
| N-SEC-02 | External content (PDF JS, remote images) is sandboxed; PDF scripting is disabled by default. |
| N-SEC-03 | The app reads browser DBs read-only and never writes to another app's files. |
| N-SEC-04 | RPC between UI and main process is the only privileged boundary; page JavaScript never gets filesystem or process APIs. |
| N-UX-01 | Every destructive action requires confirmation; every long action shows progress and is cancellable. |
| N-UX-02 | Full keyboard operability for logging (habits, prayers) and navigation. |
| N-UX-03 | Contrast meets WCAG AA in both the Omarchy theme and the built-in fallback theme. |
| N-UX-04 | Empty states teach the next action; errors say what failed and what to do. |
| N-A11Y-01 | Screen-reader labels on all interactive controls; focus order is logical. |
| N-I18N-01 | Arabic text (prayer names, Hijri dates) renders correctly with proper shaping and RTL where applicable. |
| N-MAINT-01 | Each module is independently testable; collectors have integration tests against recorded fixtures. |
| N-MAINT-02 | No module imports another module's internals; shared types live in a single contracts package. |

---

## 7. Data requirements (product-level)

The stack document owns the physical schema; these are the product-level guarantees it must satisfy.

| ID | Requirement |
|---|---|
| D-01 | **One database file** holds all module data; media (PDFs) and notes live on disk, referenced by path. |
| D-02 | Every raw event is **immutable once written**; corrections are new rows or explicit tombstones, never silent overwrites. |
| D-03 | Every derived metric (streak, total, progress) is **recomputable** from raw events. |
| D-04 | **Time** is stored as UTC instants plus a local-date key for day bucketing, so DST and timezone changes do not corrupt history. |
| D-05 | **Browser history facts** are stored with their source (`history` vs `window-title`), profile, and ingestion run, so provenance is auditable. |
| D-06 | **Reading positions and highlights** are anchored to a representation that survives re-render and is versioned (C-5). |
| D-07 | **Prayer logs** store the computed time *and* the time actually logged, so "on-time" vs "late" is defensible. |
| D-08 | **Habit schedule history** is versioned (C-6). |
| D-09 | The database is **exportable to a single portable archive** with a manifest and schema version. |
| D-10 | A **foreign-key-clean** database is a release gate; the health page reports integrity check results. |

---

## 8. Integrations and contracts

| Integration | Contract | Failure mode required |
|---|---|---|
| Hyprland IPC (`socket2`) | Event stream (`activewindow`, `workspace`, `monitor`, `openwindow`/`closewindow`) | Reconnect with backoff; gap marked as "untracked", never attributed |
| `hyprctl activewindow -j` / `cursorpos` | JSON snapshot for reconciliation after reconnect | Poll on reconnect only; not the hot path |
| Existing salah stack (`salah-ctl status`) | JSON: prayers, current, next, isPlaying, custom times | Read-only; fall back to local computation; never write state |
| Existing salah config (`~/.config/omarchy/salah.json`) | JSON config (city, angles, custom times, alarms) | Optional write bridge; abort if round-trip would lose fields |
| Browser history (Helium `net.imput.helium/Default/History`, `Profile 2/History`) | Chromium `urls` + `visits` schema | Read-only, in place, incremental watermark |
| Obsidian vault | Markdown files on disk + `obsidian://` URI | Read-only by default; atomic writes only on explicit export |
| Omarchy theme (`~/.local/state/omarchy/current/theme/colors.toml`) | TOML color tokens | Watch for theme change; fall back to built-in palette |
| systemd user units | `salah-daemon.service` pattern for our own units | Units are installed/uninstalled explicitly, not silently |

---

## 9. Risks and open questions

### 9.1 Top risks

| # | Risk | Likelihood | Impact | Mitigation (see STACK.md) |
|---|---|---|---|---|
| R1 | Highlight anchors break after re-render or library upgrade | **Medium** | **Low** | **Measured (SP-5):** zero drift across zoom 1×–3×; rotation is not invariant, so anchors store `rotation` and fall back to text search. See `STACK.md` §6.3 |
| R2 | History-based site attribution is wrong for background tabs / SPAs | High | Medium | Dwell durations are real but focus is unknown; combine with window-title fallback; show provenance |
| R3 | PDF performance on large/scanned files | Medium | High | Render on demand, bounded cache, worker thread; profile against a real 100+ MB file |
| R4 | Memory pressure during PDF + history ingest | Medium | High | Measured: 242 MB PSS idle, ~312 MB with a PDF open. But `earlyoom` is configured to prefer Electron, so a spike gets SelfOS killed. Small page cache, worker-thread ingest, separately killable collector; see `STACK.md` §15 S1 |
| R5 | Existing salah stack's `/tmp` state and `sudo` wake timer assumptions | Medium | Medium | Read-only integration; document the contract; never depend on its state file |
| R6 | The desktop framework is a long-lived dependency; Electron ships a full Chromium | Medium | Medium | Exact version pin, 3-major support window, documented migration fallback; see `STACK.md` §2 |
| R7 | Scope: seven modules at working depth in one v1 | High | High | Shared shell + contracts first; each module independently shippable; see §10 |

### 9.2 Open questions (to resolve before build)

1. **OQ-1** — Should the app *own* a copy of each PDF, or reference the user's existing library in place? (Affects F-READ-01 and portability.)
2. **OQ-2** — Should screen-time tracking include **passive** media (video playing while another app is focused)? Requires a media-session signal not currently available.
3. **OQ-3** — Is "watch time" meant to include **short-form** (Shorts/Reels) separately from long-form? (Affects F-TIME-06 and analytics.)
4. **OQ-4** — Should qada debt be **auto-suggested** from missed prayers, or purely manual?
5. **OQ-5** — Should the Obsidian integration ever create *notes per book*, or always append to one export note?
6. **OQ-6** — Is the Omarchy theme authoritative for the reader's page background, or should the reader always offer its own reading surface? (Reading comfort may justify divergence.)

---

## 10. Release plan (product milestones)

Each milestone is independently usable; none blocks a later one.

| Milestone | Contents | Exit criterion |
|---|---|---|
| **M0 — Skeleton** | Shell, navigation, tray, DB, migrations, health page, Omarchy theme | App launches to tray, persists, and shows health |
| **M1 — Time** | Hyprland collector, app time, history ingest, categories, timeline | A full day of screen time is accurate and survives restart |
| **M2 — Habits** | All four habit types, schedules, streaks, heatmap, backfill | 30-day streak history computes correctly across schedule changes |
| **M3 — Salah** | Prayer display from existing stack, logging, qada, heatmap | A week of prayers logged and qada reconciled |
| **M4 — Reading** | PDF library, reader, display overrides, position, highlights, notes | A 300-page PDF read across restarts with highlights intact |
| **M5 — Notes** | Vault detection, search, open-in-Obsidian, highlight export | Search a real vault and export a book's highlights |
| **M6 — Goals** | Goals, progress, pacing, dashboard roll-up | Annual reading goal derives from reading events |
| **M7 — Polish** | Command palette, analytics depth, backups, export, a11y | 30-day daily-use trial passes |
| **M8 — Site time** | Browser-history ingest, per-site/page time, watch time, categories, provenance | Site time and watch time match what the browser actually did |

---

## 11. Glossary

- **Focus session** — a contiguous stretch of time with one app/domain focused, above a threshold.
- **Watch time** — time on recognized media surfaces (streaming sites, video URLs, local players).
- **Screen time** — total focused time, regardless of media.
- **Qada** — a missed obligatory prayer that must be made up later.
- **Clean day** — a day without a slip for an avoidance habit.
- **On-time / late / missed / excused** — the four prayer outcomes.
- **Derived metric** — any number computed from raw events (streak, total, progress).

---

## 12. References

Technology choices and their verification live in [`STACK.md`](./STACK.md). Measured spike results — including two design changes forced by evidence — are in [`spikes/RESULTS.md`](./spikes/RESULTS.md). External sources consulted while writing this PRD:

- Electron 45 — release notes and breaking changes: <https://releases.electronjs.org/release/v45.0.0>, <https://www.electronjs.org/docs/latest/breaking-changes>
- Electron support windows: <https://endoflife.date/electron>
- `node:sqlite` (release-candidate status, `readOnly`, `setReadBigInts`): <https://nodejs.org/api/sqlite.html>
- `powerMonitor` platform coverage: <https://www.electronjs.org/docs/latest/api/power-monitor>
- Tauri's Linux renderer limitation (`wry` has no Chromium backend): <https://docs.rs/crate/wry/latest/features>, <https://github.com/orgs/tauri-apps/discussions/8524>
- ActivityWatch watchers and the Wayland limitation: <https://docs.activitywatch.net/en/latest/watchers.html>
- Hyprland IPC (community reference): <https://wiki.hyprland.org/0.45.0/IPC>
- react-pdf-highlighter (PDF.js annotation components): <https://github.com/agentcooper/react-pdf-highlighter>

Local environment evidence used (not assumptions):

- Hyprland 0.56.2, `socket2` present at `/run/user/1000/hypr/<sig>/.socket2.sock`
- Helium profile `~/.config/net.imput.helium/Default/History`: 28 035 URLs / 59 220 visits; `visit_duration` populated; readable live with `?immutable=1`
- Existing salah stack: `~/.local/bin/salah-ctl`, `~/.local/bin/salah-daemon`, `~/.config/systemd/user/salah-daemon.service`, `~/.config/omarchy/salah.json`, `saboor.salah` Quickshell widget
- Omarchy theme tokens: `~/.local/state/omarchy/current/theme/colors.toml` (mode, accent, background, foreground, muted, and ANSI palette)
