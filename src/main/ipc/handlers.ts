/**
 * Typed IPC handlers. Every handler validates its input and returns a
 * discriminated Result so the renderer never handles a thrown error
 * (STACK.md §12.2).
 */
import { app, dialog, ipcMain, shell } from "electron";
import type { HighlightAnchor } from "../../shared/anchors";
import {
  type Api,
  type ApiName,
  type ApiParams,
  type ApiResult,
  BACKUP_KINDS,
  type BookSettingsView,
  ENTRY_STATUSES,
  HABIT_KINDS,
  HIGHLIGHT_COLORS,
  PAGE_BACKGROUNDS,
  PRAYER_IDS,
  PRAYER_STATUSES,
  READER_LAYOUTS,
  READER_SETTING_RANGE,
  type Result,
  SCHEDULE_KINDS,
  type ScheduleKind,
  ZOOM_MODES,
} from "../../shared/api";
import { dayCount, isDateKey, todayKey } from "../../shared/dates";
import { autostartEnabled, setAutostart } from "../autostart";
import { isSafeExternalUrl } from "../external-url";
import { exportJson, exportPath, stageRestore, tableToCsv, writeExport } from "../modules/data/backup";
import type { Services } from "../services/context";

type Handler<K extends ApiName> = (
  params: ApiParams<K>,
  svc: Services,
) => Promise<ApiResult<K>> | ApiResult<K>;

const handlers: { [K in ApiName]: Handler<K> } = {
  "system.health": (_p, svc) => svc.health(),
  "system.theme": (_p, svc) => svc.theme(),
  "system.checkIntegrity": (_p, svc) => svc.checkIntegrity(),
  "system.autostart": () => ({ enabled: autostartEnabled() }),
  "system.setAutostart": (p) => {
    if (typeof p?.enabled !== "boolean") throw new Error("enabled must be a boolean");
    return { enabled: setAutostart(p.enabled) };
  },
  "system.settings": (_p, svc) => svc.settings(),
  "system.setSettings": (p, svc) => {
    if (!p || typeof p !== "object") throw new Error("settings are required");
    const patch: { libraryDir?: string; backupDir?: string; excludedApps?: string[] } = {};
    if (p.libraryDir !== undefined) {
      if (typeof p.libraryDir !== "string" || !p.libraryDir.trim()) {
        throw new Error("libraryDir must be a non-empty path");
      }
      patch.libraryDir = p.libraryDir;
    }
    if (p.backupDir !== undefined) {
      if (typeof p.backupDir !== "string" || !p.backupDir.trim()) {
        throw new Error("backupDir must be a non-empty path");
      }
      patch.backupDir = p.backupDir;
    }
    if (p.excludedApps !== undefined) {
      if (!Array.isArray(p.excludedApps) || p.excludedApps.some((a) => typeof a !== "string")) {
        throw new Error("excludedApps must be an array of strings");
      }
      patch.excludedApps = p.excludedApps;
    }
    return svc.setSettings(patch);
  },
  "system.rebuildAll": (_p, svc) => svc.rebuildAll(),
  "data.deleteRange": (p, svc) => {
    if (!p || typeof p.module !== "string" || !p.module) throw new Error("module is required");
    const from = p.from === undefined || p.from === null ? null : requireDateKey(p.from, "from");
    const to = p.to === undefined || p.to === null ? null : requireDateKey(p.to, "to");
    return svc.deleteRange(p.module, from, to, p.confirm);
  },
  "system.pauseTracking": (p, svc) => {
    if (typeof p?.paused !== "boolean") throw new Error("paused must be a boolean");
    return svc.setPaused(p.paused);
  },
  "dashboard.day": (p, svc) => svc.daySummary(dateKeyOrToday(p?.localDate)),
  "time.timeline": (p, svc) => svc.timeline(dateKeyOrToday(p?.localDate)),
  "time.topApps": (p, svc) => svc.topApps(dateKeyOrToday(p?.localDate)),
  "time.rebuild": (p, svc) => svc.rebuildDay(dateKeyOrToday(p?.localDate)),

  "habits.list": (p, svc) => svc.habits.list(dateKeyOrToday(p?.localDate), p?.includeArchived === true),
  "habits.create": (p, svc) => {
    if (!p || typeof p.name !== "string") throw new Error("name is required");
    // `kind` is stored in a `TEXT NOT NULL` column with no CHECK and
    // `daySatisfies` has no default branch, so an unknown member makes the
    // habit permanently unsatisfiable with nothing reported — the same shape
    // the `habits.log` guard below the next handler exists to prevent.
    if (!isOneOf(p.kind, HABIT_KINDS)) {
      throw new Error(`kind must be one of: ${HABIT_KINDS.join(", ")}`);
    }
    // A negative or non-finite target makes every future day "satisfied" (or
    // none), silently: the create control is a button, not a form submit, so
    // the input's `min` never runs (round-11 design_critic #13).
    if (p.target !== undefined && p.target !== null) {
      if (typeof p.target !== "number" || !Number.isFinite(p.target) || p.target <= 0) {
        throw new Error("target must be a positive finite number");
      }
    }
    if (p.unit !== undefined && p.unit !== null) requireString(p.unit, "unit");
    if (p.icon !== undefined && p.icon !== null) requireString(p.icon, "icon");
    if (p.color !== undefined && p.color !== null) {
      const color = requireString(p.color, "color");
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("color must be a #rrggbb value");
    }
    return { id: svc.habits.create({ ...p, schedule: requireSchedule(p.schedule) }, todayKey()) };
  },
  "habits.toggle": (p, svc) => {
    requireId(p?.habitId, "habitId");
    return svc.habits.toggle(p.habitId, dateKeyOrToday(p.localDate));
  },
  "habits.increment": (p, svc) => {
    requireId(p?.habitId, "habitId");
    if (typeof p.delta !== "number" || !Number.isFinite(p.delta)) throw new Error("delta must be a number");
    return svc.habits.increment(p.habitId, dateKeyOrToday(p.localDate), p.delta);
  },
  "habits.log": (p, svc) => {
    requireId(p?.habitId, "habitId");
    const localDate = requireDateKey(p.localDate, "localDate");
    // `status` is a compile-time union only. An unknown value reaches a
    // `TEXT NOT NULL` column with no CHECK, and `daySatisfies` has no default
    // branch, so the row is silently classified as not-done and the streak and
    // 30-day completion numbers are corrupted with no error shown anywhere.
    if (!isOneOf(p.status, ENTRY_STATUSES)) {
      throw new Error(`status must be one of: ${ENTRY_STATUSES.join(", ")}`);
    }
    if (p.value !== undefined && (typeof p.value !== "number" || !Number.isFinite(p.value))) {
      throw new Error("value must be a finite number");
    }
    svc.habits.log(p.habitId, localDate, p.status, p.value ?? 0, p.note);
    return { ok: true as const };
  },
  "habits.clear": (p, svc) => {
    requireId(p?.habitId, "habitId");
    svc.habits.clear(p.habitId, requireDateKey(p.localDate, "localDate"));
    return { ok: true as const };
  },
  "habits.archive": (p, svc) => {
    requireId(p?.habitId, "habitId");
    svc.habits.archive(p.habitId, Boolean(p.archived));
    return { ok: true as const };
  },
  "habits.changeSchedule": (p, svc) => {
    requireId(p?.habitId, "habitId");
    // A schedule version is selected by comparing `effective_from` as a
    // string, so a junk value makes the version unreachable or always-wins.
    // The schedule itself is validated for the same reason as at creation.
    svc.habits.changeSchedule(
      p.habitId,
      requireSchedule(p.schedule),
      requireDateKey(p.effectiveFrom, "effectiveFrom"),
    );
    return { ok: true as const };
  },
  "habits.heatmaps": (p, svc) => svc.habits.heatmaps(dateKeyOrToday(p?.localDate), dayCount(p?.days, 84)),
  "habits.heatmap": (p, svc) => {
    requireId(p?.habitId, "habitId");
    // The renderer picks this number and `heatmapDays` allocates one cell per
    // day, so the pure function must not be the only guard.
    return svc.habits.heatmap(p.habitId, dateKeyOrToday(p.localDate), dayCount(p.days, 84));
  },

  "salah.day": async (p, svc) => {
    const day = await svc.salah.day(dateKeyOrToday(p?.localDate));
    // Flatten the time source into the shape the renderer consumes.
    return {
      localDate: day.localDate,
      hijri: day.hijri,
      source: day.source,
      location: day.location,
      times: day.source_times.prayers,
      current: day.current,
      next: day.next,
      prayers: day.prayers,
      logged: day.logged,
      onTime: day.onTime,
      missed: day.missed,
      complete: day.complete,
      qada: day.qada,
      streak: day.streak,
    };
  },
  "salah.log": (p, svc) => {
    if (!isOneOf(p?.prayer, PRAYER_IDS)) {
      throw new Error(`prayer must be one of: ${PRAYER_IDS.join(", ")}`);
    }
    // The status drives the qada ledger, so an unknown value must not reach it.
    if (p.status !== undefined && !isOneOf(p.status, PRAYER_STATUSES)) {
      throw new Error(`status must be one of: ${PRAYER_STATUSES.join(", ")}`);
    }
    return svc.salah.log(p.prayer, {
      // The boundary decides the day (D-04): `salah.clear` already requires it,
      // and leaving this one to the service made a third implementation of
      // "today" (see the round-11 zoom-out finding).
      ...(p.localDate !== undefined
        ? { localDate: requireDateKey(p.localDate, "localDate") }
        : { localDate: dateKeyOrToday(undefined) }),
      ...(p.status ? { status: p.status } : {}),
      ...(p.jamaah !== undefined ? { jamaah: requireBoolean(p.jamaah, "jamaah") } : {}),
      ...(p.masjid !== undefined ? { masjid: requireString(p.masjid, "masjid") } : {}),
    });
  },
  "salah.markers": async (p, svc) => svc.prayerMarkers(dateKeyOrToday(p?.localDate)),
  "salah.clear": (p, svc) => {
    if (!isOneOf(p?.prayer, PRAYER_IDS)) {
      throw new Error(`prayer must be one of: ${PRAYER_IDS.join(", ")}`);
    }
    svc.salah.clear(p.prayer, requireDateKey(p.localDate, "localDate"));
    return { ok: true as const };
  },
  "salah.repayQada": (p, svc) => {
    if (!isOneOf(p?.prayer, PRAYER_IDS)) {
      throw new Error(`prayer must be one of: ${PRAYER_IDS.join(", ")}`);
    }
    // The count becomes `-Math.abs(count)` in the qada ledger; a non-number
    // became NaN and rendered as "NaN" in the debt panel.
    if (p.count !== undefined && (typeof p.count !== "number" || !Number.isFinite(p.count))) {
      throw new Error("count must be a finite number");
    }
    return svc.salah.repayQada(p.prayer, p.count ?? 1);
  },
  // `recentDays` allocates one entry per day, so an unclamped value is an
  // allocation primitive on the process that owns the IPC loop and the DB.
  "salah.history": (p, svc) => svc.salah.history(dayCount(p?.days, 30)),

  "reading.list": (_p, svc) => svc.reading.list(),
  "reading.pickBook": async () => {
    const result = await dialog.showOpenDialog({
      title: "Import PDF",
      properties: ["openFile"],
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  },
  "reading.import": (p, svc) => {
    if (!p || typeof p.path !== "string" || !p.path) throw new Error("path is required");
    return svc.reading.importBook(p.path);
  },
  "reading.setPageCount": (p, svc) => {
    requireId(p?.bookId, "bookId");
    // Integer check at the boundary, matching requireId/dayCount/requireRange:
    // `typeof === "number"` let 12.5 through to fail deep in the service.
    if (!Number.isInteger(p.pageCount)) throw new Error("pageCount must be an integer");
    svc.reading.setPageCount(p.bookId, p.pageCount, p.title, p.author);
    return { ok: true as const };
  },
  "reading.saveSettings": (p, svc) => {
    requireId(p?.bookId, "bookId");
    if (!p.settings) throw new Error("settings are required");
    svc.reading.saveSettings(p.bookId, validateBookSettings(p.settings));
    return { ok: true as const };
  },
  "reading.savePosition": (p, svc) => {
    requireId(p?.bookId, "bookId");
    // The service rounds and clamps, but `Math.round(NaN)` is NaN and the
    // column is INTEGER NOT NULL: a non-finite page reached SQLite and a later
    // open asked pdf.js for page Infinity (round-11 design_critic #10).
    if (typeof p.page !== "number" || !Number.isFinite(p.page) || p.page < 1) {
      throw new Error("page must be a finite number of at least 1");
    }
    // Validate the optional numerics too: they reach SQLite REAL columns.
    if (p.scrollOffset !== undefined && !Number.isFinite(p.scrollOffset)) {
      throw new Error("scrollOffset must be a finite number");
    }
    // The column is declared 0..1 within the page (STACK §4.2); a value outside
    // that range would restore the reader past the end of the content.
    if (p.scrollOffset !== undefined && (p.scrollOffset < 0 || p.scrollOffset > 1)) {
      throw new Error("scrollOffset must be between 0 and 1");
    }
    if (p.zoom !== undefined && !Number.isFinite(p.zoom)) {
      throw new Error("zoom must be a finite number");
    }
    svc.reading.savePosition(p.bookId, p.page, p.scrollOffset, p.zoom);
    return { ok: true as const };
  },
  "reading.startSession": (p, svc) => {
    requireId(p?.bookId, "bookId");
    return { sessionId: svc.reading.startSession(p.bookId) };
  },
  "reading.turnPage": (p, svc) => {
    requireId(p?.bookId, "bookId");
    svc.reading.turnPage(p.bookId);
    return { ok: true as const };
  },
  "reading.reportVisible": (p, svc) => {
    requireId(p?.bookId, "bookId");
    // A heartbeat value reaches the session clamp as a REAL; `NaN` would make
    // `Math.min(wall, NaN)` NaN and store a nonsense `active_seconds`.
    if (typeof p?.seconds !== "number" || !Number.isFinite(p.seconds) || p.seconds < 0) {
      throw new Error("seconds must be a finite, non-negative number");
    }
    svc.reading.reportVisibleSeconds(p.bookId, p.seconds);
    return { ok: true as const };
  },
  "reading.endSession": (p, svc) => {
    requireId(p?.bookId, "bookId");
    if (
      p?.visibleSeconds !== undefined &&
      (typeof p.visibleSeconds !== "number" || !Number.isFinite(p.visibleSeconds) || p.visibleSeconds < 0)
    ) {
      throw new Error("visibleSeconds must be a finite, non-negative number");
    }
    return svc.reading.endSession(p.bookId, p?.visibleSeconds);
  },
  "reading.highlights": (p, svc) => {
    requireId(p?.bookId, "bookId");
    return svc.reading.highlights(p.bookId);
  },
  "reading.addHighlight": (p, svc) => {
    requireId(p?.bookId, "bookId");
    if (!p.anchor || typeof p.text !== "string") throw new Error("anchor and text are required");
    // `page` lands in a NOT NULL column and `color` in an unvalidated TEXT
    // column, so both are checked here rather than surfacing as a driver error.
    if (typeof p.page !== "number" || !Number.isInteger(p.page) || p.page < 1) {
      throw new Error("page must be a positive integer");
    }
    if (p.color !== undefined && !isOneOf(p.color, HIGHLIGHT_COLORS)) {
      throw new Error(`color must be one of: ${HIGHLIGHT_COLORS.join(", ")}`);
    }
    return {
      id: svc.reading.addHighlight(p.bookId, {
        page: p.page,
        color: p.color || "yellow",
        text: p.text,
        anchor: requireAnchor(p.anchor),
        ...(p.note ? { note: p.note } : {}),
      }),
    };
  },
  "reading.updateNote": (p, svc) => {
    requireId(p?.highlightId, "highlightId");
    svc.reading.updateNote(p.highlightId, p.body ?? "");
    return { ok: true as const };
  },
  "reading.deleteHighlight": (p, svc) => {
    requireId(p?.highlightId, "highlightId");
    svc.reading.deleteHighlight(p.highlightId);
    return { ok: true as const };
  },
  "reading.exportMarkdown": (p, svc) => {
    requireId(p?.bookId, "bookId");
    return svc.reading.exportMarkdown(p.bookId);
  },

  "notes.status": (_p, svc) => svc.notes.status(),
  "notes.selectVault": (p, svc) => {
    if (!p || typeof p.path !== "string" || !p.path) throw new Error("path is required");
    return svc.notes.selectVault(p.path);
  },
  "notes.clearVault": (_p, svc) => svc.notes.clearVault(),
  "notes.list": (_p, svc) => svc.notes.list(),
  "notes.search": (p, svc) => svc.notes.search(typeof p?.query === "string" ? p.query : ""),
  "notes.read": (p, svc) => {
    if (!p || typeof p.path !== "string") throw new Error("path is required");
    const content = svc.notes.read(p.path);
    return content === null ? null : { content };
  },
  "notes.uri": (p, svc) => {
    if (!p || typeof p.path !== "string") throw new Error("path is required");
    return { uri: svc.notes.uri(p.path, p.heading) };
  },
  "notes.reindex": (_p, svc) => ({ count: svc.notes.reindex() }),
  "notes.open": async (p, svc) => {
    if (!p || typeof p.path !== "string") throw new Error("path is required");
    const uri = svc.notes.uri(p.path, p.heading);
    // One allowlist for every outbound URI (see main/external-url.ts). This path
    // used to re-implement the check as a prefix test, so a scheme added or
    // removed there would silently leave this one behind.
    if (!isSafeExternalUrl(uri)) throw new Error("refusing to open an unsafe URI");
    await shell.openExternal(uri);
    return { opened: true };
  },
  "notes.exportHighlights": (p, svc) => {
    requireId(p?.bookId, "bookId");
    return svc.notes.exportHighlights(p.bookId, p.folder);
  },
  "notes.quickCapture": (p, svc) => {
    if (!p || typeof p.text !== "string") throw new Error("text is required");
    return svc.notes.quickCapture(p.text, p.folder);
  },
  "notes.ensureDailyNote": (p, svc) => svc.notes.ensureDailyNote(p?.folder),

  "goals.list": (p, svc) => svc.goals.list({ includeClosed: p?.includeClosed === true }),
  "goals.get": (p, svc) => {
    requireId(p?.goalId, "goalId");
    return svc.goals.get(p.goalId);
  },
  "goals.create": (p, svc) => {
    if (!p || typeof p.title !== "string") throw new Error("title is required");
    if (typeof p.kind !== "string") throw new Error("kind is required");
    // `validateGoalInput` shape-checks the date with a regex, so "2026-13-45"
    // passes it and `daysBetween` then parses it to NaN — every pace figure for
    // the goal renders NaN. `goals.addMilestone` already routes its `dueDate`
    // through `requireDateKey`; this field must agree with it.
    if (p.startDate !== undefined && p.startDate !== null) {
      requireDateKey(p.startDate, "startDate");
    }
    // The sibling field had the same hole the comment above describes: the
    // service's regex accepted "2026-13-45", so pace rendered NaN.
    if (p.targetDate !== undefined && p.targetDate !== null) {
      requireDateKey(p.targetDate, "targetDate");
    }
    return { id: svc.goals.create(p) };
  },
  "goals.update": (p, svc) => {
    requireId(p?.goalId, "goalId");
    if (!p.patch || typeof p.patch !== "object") throw new Error("patch is required");
    if (p.patch.targetDate !== undefined && p.patch.targetDate !== null) {
      requireDateKey(p.patch.targetDate, "targetDate");
    }
    svc.goals.update(p.goalId, p.patch);
    return { ok: true as const };
  },
  "goals.record": (p, svc) => {
    requireId(p?.goalId, "goalId");
    if (typeof p.value !== "number" || !Number.isFinite(p.value)) throw new Error("value must be a number");
    svc.goals.record(p.goalId, p.value, p.note);
    return { ok: true as const };
  },
  "goals.addMilestone": (p, svc) => {
    requireId(p?.goalId, "goalId");
    if (typeof p.title !== "string") throw new Error("title is required");
    return {
      id: svc.goals.addMilestone(
        p.goalId,
        p.title,
        p.dueDate === undefined || p.dueDate === null ? null : requireDateKey(p.dueDate, "dueDate"),
      ),
    };
  },
  "goals.setMilestone": (p, svc) => {
    requireId(p?.milestoneId, "milestoneId");
    if (typeof p.done !== "boolean") throw new Error("done must be a boolean");
    svc.goals.setMilestone(p.milestoneId, p.done);
    return { ok: true as const };
  },
  "goals.removeMilestone": (p, svc) => {
    requireId(p?.milestoneId, "milestoneId");
    svc.goals.removeMilestone(p.milestoneId);
    return { ok: true as const };
  },
  "goals.close": (p, svc) => {
    requireId(p?.goalId, "goalId");
    if (p.status !== "completed" && p.status !== "abandoned") {
      throw new Error("status must be completed or abandoned");
    }
    svc.goals.close(p.goalId, p.status, p.reason);
    return { ok: true as const };
  },
  "goals.reopen": (p, svc) => {
    requireId(p?.goalId, "goalId");
    svc.goals.reopen(p.goalId);
    return { ok: true as const };
  },

  "analytics.range": (p, svc) => svc.analytics(dayCount(p?.days, 30)),
  "analytics.activity": (p, svc) => svc.activity(dayCount(p?.days, 7)),
  "analytics.hourly": (p, svc) => svc.hourly(dateKeyOrToday(p?.localDate)),
  "analytics.domains": (p, svc) => svc.domains(dayCount(p?.days, 30)),

  "sites.day": (p, svc) => svc.sites(dateKeyOrToday(p?.localDate)),
  "sites.pages": (p, svc) => {
    if (!p || typeof p.domain !== "string" || !p.domain) throw new Error("domain is required");
    return svc.pages(p.domain, dateKeyOrToday(p.localDate));
  },
  // `uncategorizedDomains` ends in `.slice(0, limit)`, and `slice(0, -1)` counts
  // from the end rather than truncating, so a negative limit returned all but the
  // last domain. Probed: `limit: -1` on three domains returned two.
  "sites.uncategorized": (p, svc) => svc.uncategorized(requireRange(p?.limit ?? 50, "limit", 1, 1000)),
  "sites.categorize": (p, svc) => {
    if (!p || typeof p.domain !== "string") throw new Error("domain is required");
    if (typeof p.category !== "string") throw new Error("category is required");
    // These reach INTEGER columns through `setDomainRule`; a string "false"
    // is truthy and would persist is_distracting = 1.
    if (p.distracting !== undefined) requireBoolean(p.distracting, "distracting");
    if (p.media !== undefined) requireBoolean(p.media, "media");
    return svc.categorize(p.domain, p.category, { distracting: p.distracting, media: p.media });
  },
  // Runs in the ingest worker (STACK §4.1); awaiting it here does not block the
  // IPC loop, which is the point — the old handler ran the copy and the
  // `DatabaseSync` reads on the main thread.
  "sites.ingest": (_p, svc) => svc.ingestNow(),
  "sites.lastIngest": (_p, svc) => svc.lastIngest(),

  "backup.status": (_p, svc) => svc.backupStatus(),
  "backup.create": (p, svc) => {
    const kind = p?.kind ?? "manual";
    // `backupName` falls through to the daily branch for anything that is not
    // exactly `weekly`/`manual`, and the returned view echoes the value back
    // across the contract as a `BackupKind` — so it is checked here.
    if (!isOneOf(kind, BACKUP_KINDS)) {
      throw new Error(`kind must be one of: ${BACKUP_KINDS.join(", ")}`);
    }
    const file = svc.backup.create(kind);
    // A manual backup is a real backup: it moves "last backup" forward too.
    svc.markBackup();
    return file;
  },
  "backup.restore": (p, svc) => {
    if (!p || typeof p.name !== "string") throw new Error("name is required");
    // Only names from our own listing may be restored: a path from the renderer
    // would let it overwrite the database with any file on disk.
    const match = svc.backup.list().find((f) => f.name === p.name);
    if (!match) throw new Error("backup not found");
    // Staged, not applied: the swap needs no open connection, so it happens on
    // the next launch. Applying it now would be silently undone by the live
    // connection's WAL checkpoint.
    const res = stageRestore(match.path, svc.dbPath);
    return { restored: true as const, safetyCopy: "", staged: res.backupName };
  },
  "data.tables": (_p, svc) =>
    svc.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((r) => ({
        name: r.name,
        rows: svc.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${r.name.replace(/"/g, '""')}"`)?.n ?? 0,
      })),
  "data.exportJson": (_p, svc) =>
    writeExport(exportPath(svc.userDataDir, "json"), JSON.stringify(exportJson(svc.db), null, 2)),
  "data.exportCsv": (p, svc) => {
    if (!p || typeof p.table !== "string" || !p.table) throw new Error("table is required");
    const csv = tableToCsv(svc.db, p.table, {
      ...(p.from === undefined ? {} : { from: requireDateKey(p.from, "from") }),
      ...(p.to === undefined ? {} : { to: requireDateKey(p.to, "to") }),
    });
    return writeExport(exportPath(svc.userDataDir, "csv", p.table), csv);
  },
};

/** Runtime membership check for a closed union coming from the renderer. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function requireId(id: unknown, field: string): asserts id is number {
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error(`${field} must be an integer`);
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

/**
 * Validate a renderer-supplied habit schedule before it reaches SQLite.
 *
 * `kind` is stored in `habit_schedule.kind` (`TEXT NOT NULL`, no CHECK) and
 * `requiredPerPeriod` / `isDueOn` switch on it with no `default` branch, so an
 * unknown member makes the schedule silently unreachable rather than failing.
 * `weekdays` and `timesPerPeriod` reach `#insertSchedule` unchecked and feed
 * period arithmetic directly, so they are validated here too.
 *
 * Shared by `habits.create` and `habits.changeSchedule`: a schedule change is
 * the same write one handler over, and leaving it unguarded is how this defect
 * survived the earlier pass on `habits.log`.
 */
const requireSchedule = (
  value: unknown,
): {
  kind: ScheduleKind;
  weekdays?: number[] | null;
  timesPerPeriod?: number | null;
} => {
  if (!value || typeof value !== "object") throw new Error("schedule is required");
  const s = value as { kind?: unknown; weekdays?: unknown; timesPerPeriod?: unknown };
  if (!isOneOf(s.kind, SCHEDULE_KINDS)) {
    throw new Error(`schedule.kind must be one of: ${SCHEDULE_KINDS.join(", ")}`);
  }
  if (s.weekdays !== undefined && s.weekdays !== null) {
    if (!Array.isArray(s.weekdays) || s.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new Error("schedule.weekdays must be integers 1..7");
    }
  }
  if (s.timesPerPeriod !== undefined && s.timesPerPeriod !== null) {
    if (!Number.isInteger(s.timesPerPeriod) || (s.timesPerPeriod as number) < 1) {
      throw new Error("schedule.timesPerPeriod must be a positive integer");
    }
  }
  return {
    kind: s.kind,
    ...(s.weekdays !== undefined ? { weekdays: s.weekdays as number[] | null } : {}),
    ...(s.timesPerPeriod !== undefined ? { timesPerPeriod: s.timesPerPeriod as number | null } : {}),
  };
};

/**
 * Validate a renderer-supplied highlight anchor before it is persisted.
 *
 * The anchor is stored as JSON and re-read on every open of the book, where the
 * reader hands it to `resolveAnchor`. That function calls `anchor.rects.every`
 * and `normalizeText(anchor.text)` unconditionally, so a malformed anchor is not
 * a cosmetic problem: `rects` as a string throws `TypeError`, a missing `text`
 * throws inside `findByText`. At the time this guard was added the renderer had
 * no error boundary, so that throw unmounted the whole React root and reopening
 * the book re-crashed it, with the delete control inside the panel that could no
 * longer render. That is no longer the failure mode: there is now a boundary
 * around the module area (`components/ErrorBoundary.tsx`) and a second one at the
 * root (`main.tsx`), and `ReadingService.parseAnchor` normalises a bad stored
 * anchor on read so it degrades to the "orphaned" state instead of throwing.
 * This guard remains the first line — it stops the bad value being written at
 * all — and the other two exist because data can arrive by other paths. A
 * non-object `rects` entry silently yields `{x:null,…}` rects instead.
 *
 * Verified by probe through the real bridge: `{rects: "nope"}` and a missing
 * `text` were both accepted and stored before this guard existed.
 */
const requireAnchor = (value: unknown): HighlightAnchor => {
  if (!value || typeof value !== "object") throw new Error("anchor is required");
  const a = value as Record<string, unknown>;
  if (!Array.isArray(a.rects)) throw new Error("anchor.rects must be an array");
  const rect = (r: unknown): boolean => {
    if (!r || typeof r !== "object") return false;
    const o = r as Record<string, unknown>;
    return [o.x, o.y, o.w, o.h].every((n) => typeof n === "number" && Number.isFinite(n));
  };
  if (!a.rects.every(rect)) throw new Error("anchor.rects must be objects of finite x/y/w/h");
  if (typeof a.text !== "string") throw new Error("anchor.text must be a string");
  if (typeof a.rotation !== "number" || !Number.isFinite(a.rotation)) {
    throw new Error("anchor.rotation must be a number");
  }
  if (!Number.isInteger(a.page) || (a.page as number) < 1) {
    throw new Error("anchor.page must be a positive integer");
  }
  return value as HighlightAnchor;
};

/**
 * Validate a renderer-supplied `localDate`, or fall back to today when absent.
 *
 * Every table is keyed by this string (PRD D-04; `STACK.md` §4.2 for the columns) and nothing else in main
 * checked it, so a malformed value was not refused by SQLite — it was stored,
 * and the row then fell outside every `= ?` and `BETWEEN` the app issues.
 * Probed before adding this: `habits.log {localDate: "junk"}` stored `"junk"`
 * and `salah.log {localDate: ""}` stored an empty date, in both cases leaving a
 * row that no screen, streak or aggregate can ever see. `time.rebuild` is worse:
 * it writes a `day_aggregate` row under the junk key and reports success.
 *
 * Only an *absent* field means "default to today". An empty string is a value
 * the caller sent, and coercing it to today made the guard itself a silent
 * substitution — the same defect one layer up.
 */
function dateKeyOrToday(value: unknown, field = "localDate"): string {
  if (value === undefined || value === null) return todayKey();
  if (!isDateKey(value)) throw new Error(`${field} must be a YYYY-MM-DD date`);
  return value;
}

/** As above, but the caller has no sensible default: the field is required. */
function requireDateKey(value: unknown, field: string): string {
  if (!isDateKey(value)) throw new Error(`${field} must be a YYYY-MM-DD date`);
  return value;
}

function requireRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validate the reader settings object before it is persisted.
 *
 * The whole object used to go straight into `JSON.stringify` and then into the
 * `book.settings_json` column, so an unknown enum member or a non-finite number
 * was stored and read back by the render path for the life of the book. `NaN`
 * is the worst case: JSON cannot represent it, so it round-trips as `null` and
 * `pageFilter` interpolates that into a CSS filter string.
 *
 * Rebuilt field by field rather than spread, so a key the contract does not
 * name cannot be persisted either.
 */
function validateBookSettings(value: unknown): BookSettingsView {
  if (!value || typeof value !== "object") throw new Error("settings must be an object");
  const s = value as Partial<BookSettingsView>;
  if (!isOneOf(s.pageBackground, PAGE_BACKGROUNDS)) {
    throw new Error(`pageBackground must be one of: ${PAGE_BACKGROUNDS.join(", ")}`);
  }
  if (!isOneOf(s.zoomMode, ZOOM_MODES)) {
    throw new Error(`zoomMode must be one of: ${ZOOM_MODES.join(", ")}`);
  }
  if (!isOneOf(s.layout, READER_LAYOUTS)) {
    throw new Error(`layout must be one of: ${READER_LAYOUTS.join(", ")}`);
  }
  if (typeof s.invert !== "boolean") throw new Error("invert must be a boolean");
  if (typeof s.hideHeaders !== "boolean") throw new Error("hideHeaders must be a boolean");
  return {
    pageBackground: s.pageBackground,
    invert: s.invert,
    brightness: requireRange(
      s.brightness,
      "brightness",
      READER_SETTING_RANGE.brightness.min,
      READER_SETTING_RANGE.brightness.max,
    ),
    contrast: requireRange(
      s.contrast,
      "contrast",
      READER_SETTING_RANGE.contrast.min,
      READER_SETTING_RANGE.contrast.max,
    ),
    zoomMode: s.zoomMode,
    zoom: requireRange(s.zoom, "zoom", READER_SETTING_RANGE.zoom.min, READER_SETTING_RANGE.zoom.max),
    layout: s.layout,
    cropMargins: requireRange(
      s.cropMargins,
      "cropMargins",
      READER_SETTING_RANGE.cropMargins.min,
      READER_SETTING_RANGE.cropMargins.max,
    ),
    hideHeaders: s.hideHeaders,
  };
}

export function registerIpc(svc: Services): void {
  for (const [name, handler] of Object.entries(handlers) as Array<[ApiName, Handler<ApiName>]>) {
    ipcMain.handle(`selfos:${name}`, async (event, params: unknown): Promise<Result<unknown>> => {
      try {
        // The channel *names* are closed; the *callers* were not. Any future
        // second webContents, embedded frame, or surviving window could reach
        // the full 75-channel API, so the sender's origin is checked too.
        const url = event.senderFrame?.url ?? "";
        const trusted =
          url.startsWith("selfos-app://app/") ||
          (!app.isPackaged && /^https?:\/\/localhost(?:[:/]|$)/.test(url));
        if (!trusted) throw new Error("unauthorized sender");
        const data = await (handler as (p: unknown, s: Services) => unknown)(params, svc);
        return { ok: true, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ipc] ${name} failed:`, message);
        return { ok: false, error: message };
      }
    });
  }
}

export type { Api, ApiName, ApiParams, ApiResult };
