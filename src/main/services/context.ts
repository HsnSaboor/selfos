/**
 * Service container. Owns the DB handle and the module services the IPC
 * handlers call. Kept plain (no DI framework) — there is one of everything.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { app } from "electron";
import type {
  ActivityCellView,
  AnalyticsView,
  AppUsage,
  BackupStatusView,
  DaySummary,
  DomainUsageView,
  HealthReport,
  HourBucketView,
  IngestSummaryView,
  PrayerMarker,
  SystemSettingsView,
  ThemeTokens,
  TimelineSegment,
} from "../../shared/api";
import { localDateKey } from "../../shared/dates";
import { autostartEnabled } from "../autostart";
import { Db } from "../db/driver";
import { currentVersion, migrate } from "../db/migrate";
import type { IngestResult } from "../integrations/browser-history/ingest";
import {
  cleanupSnapshots,
  type ProfileConfig,
  seedDefaultRules,
  strategyFor,
} from "../integrations/browser-history/ingest";
import type { IngestReply, IngestRequest } from "../integrations/browser-history/ingest-worker";
import { guessSite, isBrowserClass } from "../integrations/browser-history/title";
import { readTheme } from "../integrations/omarchy-theme";
import { formatHijri } from "../integrations/salah/compute";
import { daysToRebuild, summarizeDay } from "../modules/dashboard/summary";
import { applyPendingRestore, BackupService } from "../modules/data/backup";
import { GoalsService } from "../modules/goals/service";
import { HabitsService } from "../modules/habits/service";
import { NotesService } from "../modules/notes/service";
import { ReadingService } from "../modules/reading/service";
import { SalahService } from "../modules/salah/service";
import {
  activityMatrix,
  analyse,
  hourlyProfile,
  timelineSegments,
  topAppsForDay,
  topDomains,
} from "../modules/time/analytics";
import { TimeCollector } from "../modules/time/collector";
import {
  categoryForDomain,
  categoryUsage,
  loadRules,
  pagesForDomain,
  setDomainRule,
  siteTotals,
  siteUsage,
  uncategorizedDomains,
  watchTime,
} from "../modules/time/sites";

const HELIUM_ROOT = join(homedir(), ".config/net.imput.helium");

/**
 * The browser profiles to ingest, in one place.
 *
 * This list used to be written twice — once for ingest and once for the health
 * page — while its comment claimed it was configuration. Two lists that must
 * agree decide what is read and what is reported, so a third profile could be
 * ingested and invisible, or reported and never read. The names are still
 * literals: F-SET-01 settings are a separate surface (see `settings()`).
 */
const BROWSER_PROFILES = ["Default", "Profile 2"] as const;

/**
 * F-SET-06 module → tables, with the day column each is filtered by.
 *
 * Notes are absent on purpose: the vault holds the user's own files, and a
 * "delete data" action must never reach them.
 */
const DELETE_MODULES: Record<string, Array<{ table: string; column: string }>> = {
  time: [
    { table: "focus_event", column: "local_date" },
    { table: "day_aggregate", column: "local_date" },
  ],
  sites: [{ table: "browser_visit", column: "local_date" }],
  habits: [{ table: "habit_entry", column: "local_date" }],
  salah: [
    { table: "prayer_log", column: "local_date" },
    { table: "qada_event", column: "local_date" },
    { table: "fasting_log", column: "local_date" },
  ],
  reading: [{ table: "reading_session", column: "local_date" }],
  goals: [
    // Children first: goal_progress/goal_milestone reference goal(id) with no
    // ON DELETE, and foreign_keys is ON, so deleting the parent first raises
    // SQLITE_CONSTRAINT_FOREIGNKEY and rolls the whole range back.
    { table: "goal_progress", column: "at" },
    { table: "goal_milestone", column: "due_date" },
    { table: "goal", column: "start_date" },
  ],
};

/**
 * How long one ingest pass may run before the worker is treated as hung.
 *
 * A full pass drains up to `MAX_PAGES_PER_RUN` pages, and the snapshot copy is
 * seconds on a large file; five minutes is well past any real run. Without a
 * bound, a worker that never replies would stop ingest for the rest of the
 * process's life.
 */
const INGEST_TIMEOUT_MS = 5 * 60 * 1000;

export type IngestSummary = IngestSummaryView;
export class Services {
  readonly db: Db;
  readonly dbPath: string;
  readonly userDataDir: string;
  /** Set when a staged restore was applied on this launch. */
  readonly restoredFrom: string | null;
  readonly startedAt = Date.now();
  readonly collector: TimeCollector;
  readonly habits: HabitsService;
  readonly salah: SalahService;
  readonly reading: ReadingService;
  readonly notes: NotesService;
  readonly goals: GoalsService;
  readonly backup: BackupService;
  #backupTimer: NodeJS.Timeout | null = null;
  #integrity = "unchecked";
  #integrityAt: number | null = null;
  readonly #earlyoom = detectEarlyoomPreference();
  #ingestTimer: NodeJS.Timeout | null = null;
  /**
   * The pass currently running, so a manual `sites.ingest` that arrives while
   * the timer is mid-run joins it instead of returning stale data.
   */
  #ingestRun: Promise<void> | null = null;
  /** Lazily created; see `ingestInWorker`. */
  #ingestWorker: Worker | null = null;
  /** Resolver for the one in-flight worker request, if any. */
  #ingestPending: ((reply: IngestReply) => void) | null = null;
  #lastIngest: IngestSummary[] = [];

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.dbPath = join(userDataDir, "selfos.sqlite");
    // A staged restore must be applied before the database is opened: with a
    // connection open, the old WAL is checkpointed back over the restored file
    // and the restore is silently undone.
    this.restoredFrom = applyPendingRestore(this.dbPath);
    this.db = Db.open(this.dbPath);
    migrate(this.db);
    this.collector = new TimeCollector(this.db, {
      sessionId: detectSessionId(),
      // The reading module owns reading_session; time asks it for the day total
      // instead of reading its table (PRD P-1). The closure is lazy because
      // `reading` is constructed just below.
      readingSeconds: (date) => this.reading?.readingSeconds(date) ?? 0,
    });
    this.habits = new HabitsService(this.db);
    this.salah = new SalahService(this.db);
    this.reading = new ReadingService(this.db, join(userDataDir, "library"));
    this.notes = this.openNotes(join(userDataDir, "notes-index.sqlite"));
    this.goals = new GoalsService(this.db);
    this.backup = new BackupService(this.db, join(userDataDir, "backups"));
    // The ingest itself runs in the worker (STACK §4.1); the main process only
    // supervises it, so no BrowserHistoryIngest is constructed here.
    seedDefaultRules(this.db);
  }

  /**
   * Open the notes index, rebuilding it once if the file is unreadable.
   *
   * The index is derived data (STACK §9): a corrupt or truncated file must not
   * stop the app from starting, so the file and its sidecars are removed and
   * the open retried. A second failure is a real error and propagates to the
   * ready handler, which shows it.
   */
  private openNotes(indexPath: string): NotesService {
    const bookTitle = (id: number) => this.reading?.store.get(id)?.title ?? null;
    try {
      return new NotesService(this.db, indexPath, bookTitle);
    } catch (err) {
      console.error("[notes] index open failed, rebuilding:", err instanceof Error ? err.message : err);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${indexPath}${suffix}`, { force: true });
      return new NotesService(this.db, indexPath, bookTitle);
    }
  }

  /** Profiles to ingest; one list shared with the health page. */
  browserProfilesConfig(): ProfileConfig[] {
    return BROWSER_PROFILES.map((profileDir) => ({
      browser: "helium",
      profileDir,
      historyPath: join(HELIUM_ROOT, profileDir, "History"),
    }));
  }

  /**
   * Ingest on startup, then every four hours. A large snapshot copy is
   * deliberately not on a short timer (F-TIME-17, STACK §5.3 step 4): an hourly
   * cadence copied a 454 MB file up to 24 times a day. One overlapping run is
   * skipped rather than queued, so a slow disk cannot pile up work.
   */
  startHistoryIngest(): void {
    cleanupSnapshots(join(this.userDataDir, "snapshots"));
    const run = () => {
      void this.runIngest();
    };
    // Defer the first run so startup is not blocked by a 454 MB read.
    setTimeout(run, 3000);
    this.#ingestTimer = setInterval(run, 4 * 60 * 60 * 1000);
  }

  /**
   * Run one ingest pass in the worker and record the result.
   *
   * The work itself is synchronous (`DatabaseSync` + `copyFileSync`) and can
   * take seconds on a large history file, so it runs off the main thread
   * (STACK §4.1, §5.3 step 8). Overlapping runs are skipped, not queued.
   */
  private runIngest(): Promise<void> {
    // One pass at a time: a second caller joins the run in flight.
    if (this.#ingestRun) return this.#ingestRun;
    this.#ingestRun = this.#doIngest().finally(() => {
      this.#ingestRun = null;
    });
    return this.#ingestRun;
  }

  async #doIngest(): Promise<void> {
    try {
      const results = await this.ingestInWorker();
      if (!results) return;
      this.#lastIngest = results.map((r) => ({
        profileDir: r.profileDir,
        rowsNew: r.rowsNew,
        strategy: r.strategy,
        error: r.error,
      }));
      // Site time changed, so today's aggregate is stale.
      this.collector.rebuild(localDateKey(new Date()));
    } catch (err) {
      console.error("[ingest] failed:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Post one ingest request to the worker.
   *
   * Returns `null` when the worker could not run at all (a missing bundle in a
   * test or a crash), so the caller records "no new data" rather than throwing
   * into a timer callback.
   */
  private ingestInWorker(): Promise<IngestResult[] | null> {
    return new Promise((resolve) => {
      let worker: Worker;
      try {
        worker = this.#ensureIngestWorker();
      } catch (err) {
        console.error("[ingest] worker unavailable:", err instanceof Error ? err.message : err);
        resolve(null);
        return;
      }
      // A worker that never answers would leave the run pending forever, so
      // ingest would never run again — a silent permanent stop. The timeout
      // kills the worker (so the next run rebuilds it) and resolves as "no
      // data", which is the same outcome as a crash.
      const timer = setTimeout(() => {
        if (!this.#ingestPending) return;
        console.error("[ingest] worker timed out; restarting it");
        this.#ingestPending = null;
        this.#ingestWorker = null;
        void worker.terminate();
        // The snapshot is deleted on the normal path; a timeout must not leave
        // up to 800 MB behind until the next launch (F-TIME-17).
        cleanupSnapshots(join(this.userDataDir, "snapshots"));
        resolve(null);
      }, INGEST_TIMEOUT_MS);
      this.#ingestPending = (reply) => {
        clearTimeout(timer);
        this.#ingestPending = null;
        if (reply.type === "error") {
          console.error("[ingest] worker error:", reply.message);
          resolve(null);
          return;
        }
        resolve(reply.results);
      };
      const req: IngestRequest = {
        type: "ingest",
        dbPath: this.dbPath,
        snapshotDir: join(this.userDataDir, "snapshots"),
        profiles: this.browserProfilesConfig(),
      };
      worker.postMessage(req);
    });
  }

  /**
   * The worker, created once and kept for the process lifetime.
   *
   * A crash must not wedge ingest forever: the `exit` handler drops the
   * reference and resolves any in-flight request, so the next run rebuilds it.
   */
  #ensureIngestWorker(): Worker {
    if (this.#ingestWorker) return this.#ingestWorker;
    // `__dirname` is `out/main` at runtime, and electron-vite emits the worker
    // next to the main bundle (see the `ingest-worker` input in the config).
    const workerPath = join(__dirname, "ingest-worker.cjs");
    const worker = new Worker(workerPath);
    worker.on("message", (reply: IngestReply) => this.#ingestPending?.(reply));
    worker.on("error", (err) => {
      console.error("[ingest] worker failed:", err.message);
      this.#ingestPending?.({ type: "error", message: err.message });
    });
    worker.on("exit", (code) => {
      if (this.#ingestWorker === worker) this.#ingestWorker = null;
      if (code !== 0) this.#ingestPending?.({ type: "error", message: `worker exited with ${code}` });
    });
    this.#ingestWorker = worker;
    return worker;
  }

  /** Await one ingest pass. Used by the `sites.ingest` IPC handler. */
  async ingestNow(): Promise<IngestSummary[]> {
    // Joins a run already in flight rather than returning `#lastIngest`, which
    // is empty on the first pass — a manual "ingest now" during the startup run
    // reported "no profiles" and then the data appeared on its own.
    await this.runIngest();
    return this.#lastIngest;
  }

  lastIngest(): IngestSummary[] {
    return this.#lastIngest;
  }

  sites(localDate: string) {
    const date = localDate;
    const sites = siteUsage(this.db, date);
    const totals = siteTotals(this.db, date);
    return {
      localDate: date,
      sites,
      totals,
      categories: categoryUsage(this.db, date, sites, totals.webSeconds),
      watch: watchTime(this.db, date),
    };
  }

  pages(domain: string, localDate: string) {
    return pagesForDomain(this.db, domain, localDate);
  }

  uncategorized(limit?: number) {
    return uncategorizedDomains(this.db, limit ?? 50);
  }

  categorize(domain: string, category: string, opts: { distracting?: boolean; media?: boolean } = {}) {
    setDomainRule(this.db, domain, category, opts);
    return { ok: true as const };
  }

  /**
   * Take a backup at startup if today's is missing, then every six hours.
   * Failure is logged, never fatal: a backup problem must not stop tracking.
   *
   * The integrity scan and the first backup used to run synchronously inside
   * the ready handler (and the scan 5 s later), each blocking every IPC call
   * for as long as it took on a 41 MB database. Both are deferred behind first
   * paint; the scan is on demand from the Data page in any case.
   */
  startBackups(): void {
    const run = () => {
      try {
        // Stamp only when a file was actually written: the timestamp used to be
        // written on every tick and every launch, so "last backup" showed the
        // last attempt.
        const made = this.backup.runScheduled();
        if (made) this.#stampBackup();
      } catch (err) {
        console.error("[backup] failed:", err instanceof Error ? err.message : err);
      }
    };
    // Safety copies from earlier restores are full-size DBs; keep 7 days.
    try {
      for (const name of readdirSync(this.userDataDir)) {
        if (!name.startsWith("selfos.sqlite.pre-restore-")) continue;
        const p = join(this.userDataDir, name);
        if (Date.now() - statSync(p).mtimeMs > 7 * 86_400_000) rmSync(p, { force: true });
      }
    } catch {
      /* best effort */
    }
    setTimeout(run, 15_000);
    this.#backupTimer = setInterval(run, 6 * 60 * 60 * 1000);
  }

  #stampBackup(): void {
    this.db.run(
      "INSERT INTO meta(key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(Date.now()),
    );
  }

  /** Record a manual backup as the last backup (F-SET-07's health row). */
  markBackup(): void {
    this.#stampBackup();
  }

  /** The last backup instant, parsed once for both readers. */
  #lastBackupAt(): number | null {
    const row = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'last_backup_at'");
    return row?.value ? Number(row.value) : null;
  }

  analytics(days = 30): AnalyticsView {
    return analyse(this.db, days);
  }

  /** F-TIME-09: 7×24 activity matrix. */
  activity(days = 7): ActivityCellView[] {
    return activityMatrix(this.db, days);
  }

  hourly(localDate: string): HourBucketView[] {
    return hourlyProfile(this.db, localDate);
  }

  domains(days = 30): DomainUsageView[] {
    return topDomains(this.db, days);
  }

  backupStatus(): BackupStatusView {
    return {
      directory: this.backup.directory,
      files: this.backup.list(),
      lastBackupAt: this.#lastBackupAt(),
    };
  }

  startTracking(): void {
    this.collector.start();
  }

  stopTracking(): void {
    this.collector.stop();
  }

  /** The current theme. Read fresh: the watcher is not the only writer. */
  theme(): ThemeTokens {
    return readTheme();
  }

  /** Called by the main process so a pause from the tray reaches the renderer. */
  onTrackingChange: ((state: { running: boolean; paused: boolean }) => void) | null = null;

  setPaused(paused: boolean): { paused: boolean } {
    this.collector.setPaused(paused);
    const status = this.collector.status();
    this.onTrackingChange?.({ running: status.running, paused: status.paused });
    // Report the achieved state, not the requested one: an automatic pause
    // (lock/idle) can re-assert itself immediately after a resume.
    return { paused: status.paused };
  }

  get paused(): boolean {
    return this.collector.status().paused;
  }

  /**
   * Health snapshot. Deliberately cheap: the dashboard polls this every 5 s.
   *
   * `PRAGMA integrity_check` measured 1–2 s on a 41 MB database, and the
   * earlyoom probe spawns a subprocess — both block the main process, so
   * neither belongs on a polling path. Integrity is cached from the last
   * explicit check (startup, or the Data page's "check now"); the earlyoom
   * answer is computed once, since it cannot change while the app runs.
   */
  health(): HealthReport {
    const size = existsSync(this.dbPath) ? statSync(this.dbPath).size : 0;

    return {
      dbPath: this.dbPath,
      dbSizeBytes: size,
      schemaVersion: currentVersion(this.db),
      integrity: this.#integrity,
      lastBackupAt: this.#lastBackupAt(),
      collector: this.collector.status(),
      browserProfiles: this.browserProfiles(),
      earlyoomPreference: this.#earlyoom,
      autostart: autostartEnabled(),
      // Set once at construction; without it a staged restore applies silently.
      restoredFrom: this.restoredFrom,
    };
  }

  /** Run the expensive integrity scan on demand. Returns the cached value. */
  checkIntegrity(): { integrity: string; at: number } {
    this.#integrity = this.db.integrityCheck();
    this.#integrityAt = Date.now();
    return { integrity: this.#integrity, at: this.#integrityAt };
  }

  private browserProfiles(): HealthReport["browserProfiles"] {
    return this.browserProfilesConfig().map(({ profileDir, historyPath }) => {
      const row = this.db.get<{ last_ingest_at: number | null; watermark_us: string }>(
        "SELECT last_ingest_at, watermark_us FROM browser_profile WHERE profile_dir = ?",
        profileDir,
      );
      return {
        profileDir,
        historyPath,
        exists: existsSync(historyPath),
        lastIngestAt: row?.last_ingest_at ?? null,
        watermarkUs: row?.watermark_us ?? null,
        // Same decision the ingester makes, so the health page cannot claim a
        // different strategy than the one actually used. A zero-byte journal
        // does not force a snapshot.
        strategy: strategyFor(historyPath),
      };
    });
  }

  daySummary(localDate: string): DaySummary {
    const agg = this.db.get<{
      screen_seconds: number;
      focused_seconds: number;
      media_seconds: number;
      reading_seconds: number;
      first_activity: number | null;
      last_activity: number | null;
      switches: number;
    }>("SELECT * FROM day_aggregate WHERE local_date = ?", localDate);
    const habitStates = this.habits.list(localDate);
    const prayers = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM prayer_log WHERE local_date = ?",
      localDate,
    );
    // Prefer the Hijri date the salah stack already reported, so the header and
    // the Salah module never disagree by a day (they use different calendars).
    // When the stack answered without one, say "computed": labelling a locally
    // computed date "salah-ctl" is the divergence `hijriSource` exists to stop.
    const salahHijri = this.salah.lastHijri();
    return summarizeDay({
      localDate,
      agg: agg ?? undefined,
      habitStates,
      prayersLogged: prayers?.n ?? 0,
      hijri: salahHijri.value ?? formatHijri(new Date()),
      hijriSource: salahHijri.value ? salahHijri.source : "computed",
      watchSeconds: watchTime(this.db, localDate, siteUsage(this.db, localDate)).seconds,
    });
  }

  /** F-DASH-02: prayer markers for the timeline overlay. */
  async prayerMarkers(localDate: string): Promise<PrayerMarker[]> {
    const day = await this.salah.day(localDate);
    const logs = new Map(day.prayers.map((p) => [p.id, p.status]));
    return day.source_times.prayers.map((p) => ({
      prayer: p.id,
      time: p.time,
      status: logs.get(p.id) ?? null,
    }));
  }

  timeline(localDate: string): TimelineSegment[] {
    // The time module owns focus_event; the container only delegates.
    const rules = loadRules(this.db);
    return timelineSegments(this.db, localDate).map((r) => ({
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      appClass: r.appClass,
      appTitle: r.appTitle,
      seconds: r.seconds,
      category: isBrowserClass(r.appClass)
        ? categoryForDomain(this.db, guessSite(r.appTitle)?.site ?? "", rules)
        : "App",
    }));
  }

  topApps(localDate: string): AppUsage[] {
    return topAppsForDay(this.db, localDate);
  }
  rebuildDay(localDate: string): { rebuilt: string } {
    this.collector.rebuild(localDate);
    this.#refreshAutoGoals(localDate);
    return { rebuilt: localDate };
  }

  /**
   * F-GOAL-02 auto-source: goals whose `source` names a module metric get a
   * progress row derived from that module's own table on each rebuild.
   */
  #refreshAutoGoals(localDate: string): void {
    const goals = this.db.all<{ id: number; source: string | null }>(
      "SELECT id, source FROM goal WHERE status = 'active' AND source IS NOT NULL AND source != 'manual'",
    );
    for (const g of goals) {
      let value: number | null = null;
      if (g.source === "reading:pages") {
        value =
          this.db.get<{ n: number | null }>(
            "SELECT SUM(pages_turned) AS n FROM reading_session WHERE local_date = ?",
            localDate,
          )?.n ?? 0;
      } else if (g.source === "focus:hours") {
        const s = this.db.get<{ ms: number }>(
          "SELECT SUM(ended_at - started_at) AS ms FROM focus_event WHERE local_date = ?",
          localDate,
        );
        value = Math.round((s?.ms ?? 0) / 3_600_000);
      } else if (g.source === "salah:prayers") {
        value =
          this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prayer_log WHERE local_date = ?", localDate)
            ?.n ?? 0;
      }
      if (value === null) continue;
      // goal_progress has no unique key: replace today's auto row for this
      // goal/source instead of stacking a new one on every rebuild.
      const dayStart = new Date(`${localDate}T00:00:00`).getTime();
      this.db.run(
        "DELETE FROM goal_progress WHERE goal_id = ? AND source = ? AND at >= ? AND at < ?",
        g.id,
        g.source,
        dayStart,
        dayStart + 86_400_000,
      );
      this.db.run(
        "INSERT INTO goal_progress (goal_id, at, value, source, note) VALUES (?, ?, ?, ?, 'auto')",
        g.id,
        Date.now(),
        value,
        g.source,
      );
    }
  }

  /** F-SET-07: rebuild every derived day, not only the one asked for. */
  rebuildAll(): { rebuilt: number } {
    const days = daysToRebuild(this.db);
    for (const day of days) {
      this.collector.rebuild(day);
      this.#refreshAutoGoals(day);
    }
    return { rebuilt: days.length };
  }

  /** F-SET-02/01: the configurable folders and the excluded-app list. */
  settings(): SystemSettingsView {
    return {
      libraryDir: this.reading.store.libraryDir,
      vaultDir: this.notes.status().vault?.path ?? null,
      backupDir: this.backup.directory,
      // `userData` is chosen by Electron at launch; it is reported, not changed.
      dataDir: this.userDataDir,
      excludedApps: this.collector.excludedApps(),
    };
  }

  /**
   * Apply a settings patch. Only fields that can change without a restart are
   * accepted; an unknown field is ignored rather than silently stored.
   */
  setSettings(patch: {
    libraryDir?: string;
    backupDir?: string;
    excludedApps?: string[];
  }): SystemSettingsView {
    if (patch.libraryDir !== undefined) this.reading.store.setLibraryDir(patch.libraryDir);
    if (patch.backupDir !== undefined) this.backup.setDirectory(patch.backupDir);
    if (patch.excludedApps !== undefined) this.collector.setExcluded(patch.excludedApps);
    return this.settings();
  }

  /**
   * F-SET-06: delete rows for one module inside a date range.
   *
   * `confirm` must be exactly `true`: this is the only destructive path in the
   * app, and the renderer sends the token only after its own confirmation
   * dialog. Notes are deliberately not a module here — the vault is the user's
   * files, not app data.
   */
  deleteRange(module: string, from: string | null, to: string | null, confirm: unknown): { deleted: number } {
    if (confirm !== true) throw new Error("confirmation is required");
    const tables = DELETE_MODULES[module];
    if (!tables) throw new Error(`unknown module: ${module}`);
    let deleted = 0;
    this.db.transaction(() => {
      // goal_progress has no day column (at is epoch ms): delete by parent goal
      // in the range, and milestones by parent too (due_date may be NULL).
      if (module === "goals") {
        const goals = this.db.all<{ id: number }>(
          `SELECT id FROM goal WHERE start_date >= ? AND start_date <= ?`,
          from ?? "0000-01-01",
          to ?? "9999-12-31",
        );
        const ids = goals.map((g) => g.id);
        for (const id of ids) {
          this.db.run("DELETE FROM goal_progress WHERE goal_id = ?", id);
          this.db.run("DELETE FROM goal_milestone WHERE goal_id = ?", id);
        }
      }
      for (const { table, column } of tables) {
        const where: string[] = [];
        const params: unknown[] = [];
        if (from) {
          where.push(`${column} >= ?`);
          params.push(from);
        }
        if (to) {
          where.push(`${column} <= ?`);
          params.push(to);
        }
        if (module === "goals" && table !== "goal") continue;
        const sql = `DELETE FROM ${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
        deleted += this.db.run(sql, ...params).changes;
      }
    });
    // Aggregates are derived from the raw rows that were just removed.
    for (const day of daysToRebuild(this.db)) this.collector.rebuild(day);
    return { deleted };
  }

  close(): void {
    if (this.#backupTimer) clearInterval(this.#backupTimer);
    if (this.#ingestTimer) clearInterval(this.#ingestTimer);
    // The worker holds its own connection to the database, so it must be gone
    // before `db.close()`: a worker still mid-transaction would keep the file
    // open past the close and could checkpoint a WAL the main process no longer
    // expects. `terminate` is asynchronous, but it stops the worker from
    // starting new work immediately.
    this.#ingestWorker?.terminate();
    this.#ingestWorker = null;
    this.#ingestPending = null;
    this.collector.stop();
    // A reader left open must not leave a session row that never ends.
    this.reading.closeAllSessions();
    this.notes.close();
    this.db.close();
  }
}

/** XDG session id, with a loginctl fallback when the env var is absent. */
function detectSessionId(): string {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;
  try {
    const out = execFileSync("loginctl", ["list-sessions", "--no-legend"], { encoding: "utf8" });
    const line = out.split("\n").find((l) => l.includes(process.env.USER ?? ""));
    return line?.trim().split(/\s+/)[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * earlyoom on this machine prefers killing Electron processes (SP-2).
 * `systemctl show -p ExecStart` returns the unexpanded `$EARLYOOM_ARGS`
 * template, so read the running process's actual cmdline instead.
 */
function detectEarlyoomPreference(): boolean {
  try {
    const pid = execFileSync("pgrep", ["-x", "earlyoom"], { encoding: "utf8" }).trim().split("\n")[0];
    if (!pid) return false;
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return /--prefer[= ]+\S*electron/i.test(cmdline);
  } catch {
    return false;
  }
}

export function userDataDir(): string {
  return app.getPath("userData");
}
