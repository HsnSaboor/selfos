/**
 * The single source of truth for the main <-> renderer contract.
 *
 * Rules:
 *  - This module is imported by main, preload, and renderer. It must stay
 *    type-only plus pure helpers; no Electron or Node imports.
 *  - Every request has a typed params object and a typed result.
 *  - Results are a discriminated union so the UI never sees a thrown error.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Window classes that mean "this app" (verified on Hyprland 0.56).
 *
 * Which one appears depends on how the process was started: the raw binary
 * reports `electron`, and one launch path was observed lowercasing the product
 * name to `selfos`. All three are recognised.
 *
 * `package.json` sets `productName` to `SelfOS`; the lowercase `selfos` entry
 * is kept because a harness launch has been seen reporting it. An earlier
 * version of this comment said "both", which did not match the three
 * entries below it.
 */
export const SELFOS_APP_CLASSES = ["selfos", "electron", "SelfOS"] as const;

export function isSelfOSApp(appClass: string): boolean {
  return SELFOS_APP_CLASSES.includes(appClass as (typeof SELFOS_APP_CLASSES)[number]);
}

/**
 * Every screen in the sidebar. The renderer derives its nav from this, so the
 * contract cannot drift from what the app actually renders (it previously
 * listed seven modules while the app had ten).
 */
export const MODULE_IDS = [
  "dashboard",
  "reading",
  "habits",
  "time",
  "analytics",
  "sites",
  "salah",
  "notes",
  "goals",
  "data",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface DaySummary {
  localDate: string;
  hijri: string;
  /** Where the Hijri date came from, so the UI never mixes conventions. */
  hijriSource: "salah-ctl" | "computed";
  screenSeconds: number;
  focusedSeconds: number;
  /** Local-player media time only; see `watchSeconds`. */
  mediaSeconds: number;
  /** F-TIME-06: local player + browser watch time for the day. */
  watchSeconds: number;
  readingSeconds: number;
  habitsDone: number;
  habitsTotal: number;
  prayersLogged: number;
  bestStreak: number;
  firstActivity: number | null;
  lastActivity: number | null;
  switches: number;
  /** F-TIME-08: contiguous same-app runs of at least five minutes. */
  focusSessions: number;
  /** F-TIME-10: longest single focus stretch, seconds. */
  longestFocusSeconds: number;
}

export interface HealthReport {
  dbPath: string;
  dbSizeBytes: number;
  schemaVersion: number;
  integrity: string;
  lastBackupAt: number | null;
  collector: {
    running: boolean;
    paused: boolean;
    connected: boolean;
    lastEventAt: number | null;
    lastFlushAt: number | null;
    lastGapAt: number | null;
    pauseReason: string | null;
    segmentsWritten: number;
    eventCounts: Record<string, number>;
    error: string | null;
  };
  browserProfiles: Array<{
    profileDir: string;
    historyPath: string;
    exists: boolean;
    lastIngestAt: number | null;
    watermarkUs: string | null;
    strategy: "immutable" | "snapshot" | "unavailable";
  }>;
  earlyoomPreference: boolean;
  /** F-SHELL-05: whether the XDG autostart entry is installed. */
  autostart: boolean;
  /**
   * Path of the safety copy kept when a staged restore was applied on this
   * launch, or null when none was staged.
   *
   * `Services.restoredFrom` held this value from the moment the database opened
   * and nothing read it, so restoring a backup replaced the user's database with
   * no visible trace anywhere in the UI — the first sign was missing history.
   * The Data page states it now.
   */
  restoredFrom: string | null;
}

export interface TimelineSegment {
  startedAt: number;
  endedAt: number;
  appClass: string;
  appTitle: string;
  seconds: number;
  /** F-DASH-02: category label for the band colour. */
  category: string;
}

export interface PrayerMarker {
  prayer: PrayerId;
  time: string;
  status: PrayerStatus | null;
}

export interface AppUsage {
  appClass: string;
  seconds: number;
  share: number;
}

export type HabitKind = "boolean" | "count" | "duration" | "avoid";
export type EntryStatus = "done" | "partial" | "skipped" | "slipped" | "clean";
/**
 * Runtime form of `EntryStatus`, for the IPC boundary.
 *
 * The union is a compile-time type only, so a handler validating a renderer
 * payload has nothing to check against without a list.
 *
 * `satisfies` alone is one-way: it proves every string listed is a valid
 * `EntryStatus`, but NOT that every `EntryStatus` is listed. The proof below the
 * array closes that: a member added to the union and omitted here makes
 * `Exclude<…>` resolve to something other than `never`, and the declaration
 * fails to typecheck. That is the same two-way pattern as `API_CHANNELS` (see
 * `_ChannelsAreComplete`), and every enum mirror in this file now carries it.
 *
 * (Between rounds 8 and 10 this comment said the opposite — that the mirrors
 * "predate it and have not been converted" — while the mirror below had already
 * been converted. Four other lists point here, so the stale claim was read
 * widely.)
 */
export const ENTRY_STATUSES = [
  "done",
  "partial",
  "skipped",
  "slipped",
  "clean",
] as const satisfies readonly EntryStatus[];
// Two-way proof, as for `API_CHANNELS`: a member added to `EntryStatus` and not
// listed above is a compile error, not a silent runtime gap.
type MissingEntryStatus = Exclude<EntryStatus, (typeof ENTRY_STATUSES)[number]>;
const _EntryStatusesComplete: MissingEntryStatus extends never ? true : MissingEntryStatus = true;
/**
 * Runtime form of `HabitKind`; see `ENTRY_STATUSES` for why these exist.
 *
 * `kind` reaches `habit.kind` (`TEXT NOT NULL`, no CHECK) and `daySatisfies`
 * switches on it with no `default` branch — so an unknown value stored here
 * makes the habit permanently unsatisfiable, with no error shown anywhere.
 */
export const HABIT_KINDS = ["boolean", "count", "duration", "avoid"] as const satisfies readonly HabitKind[];
// Two-way proof, as for `API_CHANNELS`: a member added to `HabitKind` and not
// listed above is a compile error, not a silent runtime gap.
type MissingHabitKind = Exclude<HabitKind, (typeof HABIT_KINDS)[number]>;
const _HabitKindsComplete: MissingHabitKind extends never ? true : MissingHabitKind = true;
export type ScheduleKind = "daily" | "weekdays" | "times_per_week" | "times_per_month";
/**
 * Runtime form of `ScheduleKind`; see `ENTRY_STATUSES`.
 *
 * Same failure shape as `HabitKind`, one layer down: `requiredPerPeriod` and
 * `isDueOn` switch on it with no default, so `undefined` propagates into the
 * streak arithmetic.
 */
export const SCHEDULE_KINDS = [
  "daily",
  "weekdays",
  "times_per_week",
  "times_per_month",
] as const satisfies readonly ScheduleKind[];
// Two-way proof, as for `API_CHANNELS`: a member added to `ScheduleKind` and not
// listed above is a compile error, not a silent runtime gap.
type MissingScheduleKind = Exclude<ScheduleKind, (typeof SCHEDULE_KINDS)[number]>;
const _ScheduleKindsComplete: MissingScheduleKind extends never ? true : MissingScheduleKind = true;

export interface HabitSchedule {
  id: number;
  effectiveFrom: string;
  kind: ScheduleKind;
  weekdays: number[] | null;
  timesPerPeriod: number | null;
}

export interface HabitView {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  icon: string | null;
  color: string | null;
  schedule: HabitSchedule | null;
  todayEntry: { localDate: string; value: number; status: EntryStatus } | null;
  streak: { current: number; longest: number; unit: "days" | "weeks" | "months" };
  completion7d: number;
  completion30d: number;
  completion90d: number;
  dueToday: boolean;
  archivedAt: number | null;
}

export interface HeatmapCell {
  date: string;
  state: "satisfied" | "failed" | "neutral" | "pending";
}

export interface NewHabitInput {
  name: string;
  kind: HabitKind;
  unit?: string | null;
  target?: number | null;
  icon?: string | null;
  color?: string | null;
  schedule: { kind: ScheduleKind; weekdays?: number[] | null; timesPerPeriod?: number | null };
}

export type PrayerId = "fajr" | "dhuhr" | "asr" | "maghrib" | "isha";
export type PrayerStatus = "on_time" | "late" | "missed" | "excused";

/** Runtime forms of the prayer unions; see `ENTRY_STATUSES`. */
export const PRAYER_IDS = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const satisfies readonly PrayerId[];
// Two-way proof, as for `API_CHANNELS`: a member added to `PrayerId` and not
// listed above is a compile error, not a silent runtime gap.
type MissingPrayerId = Exclude<PrayerId, (typeof PRAYER_IDS)[number]>;
const _PrayerIdsComplete: MissingPrayerId extends never ? true : MissingPrayerId = true;

/**
 * Prayers per day.
 *
 * Both processes score a day against this, so it lives beside the ids rather
 * than in main: the renderer retyped `5` in four places (the score, the two
 * heatmap thresholds and the dashboard KPI), and nothing kept those in step
 * with the streak rule.
 */
export const PRAYER_COUNT = PRAYER_IDS.length;

/**
 * Highlight colours, shared by the reader's swatches and the IPC validator.
 *
 * The renderer had its own copy and the handler had none, so an unknown colour
 * reached the `highlight.color` column unchecked. It now lives here and both
 * import it.
 */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "magenta", "red"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const PRAYER_STATUSES = [
  "on_time",
  "late",
  "missed",
  "excused",
] as const satisfies readonly PrayerStatus[];
// Two-way proof, as for `API_CHANNELS`: a member added to `PrayerStatus` and not
// listed above is a compile error, not a silent runtime gap.
type MissingPrayerStatus = Exclude<PrayerStatus, (typeof PRAYER_STATUSES)[number]>;
const _PrayerStatusesComplete: MissingPrayerStatus extends never ? true : MissingPrayerStatus = true;

export interface PrayerSlotView {
  id: PrayerId;
  name: string;
  time: string;
  autoTime?: string;
  isCustom?: boolean;
}

export interface SalahDayView {
  localDate: string;
  hijri: string;
  source: "salah-ctl" | "computed";
  location: string;
  times: PrayerSlotView[];
  current: PrayerId | null;
  next: { id: PrayerId; time: string; remainingSec: number } | null;
  prayers: Array<{
    id: PrayerId;
    status: PrayerStatus | null;
    expectedStatus: PrayerStatus | "open" | "upcoming";
    loggedAt: number | null;
    jamaah: boolean;
  }>;
  logged: number;
  onTime: number;
  missed: number;
  complete: boolean;
  qada: { byPrayer: Record<PrayerId, number>; total: number };
  streak: { current: number; longest: number };
}

export interface BookView {
  id: number;
  title: string;
  author: string | null;
  pageCount: number;
  page: number;
  /** Fraction (0..1) of the page's scrollable range, restored on reopen (F-READ-05). */
  scrollOffset: number;
  percent: number;
  lastReadAt: number | null;
  highlightCount: number;
  settings: BookSettingsView;
}

export interface BookSettingsView {
  pageBackground: "original" | "dark" | "sepia" | "black";
  invert: boolean;
  brightness: number;
  contrast: number;
  zoomMode: "fit-width" | "fit-page" | "custom";
  zoom: number;
  layout: "scroll" | "single";
  cropMargins: number;
  hideHeaders: boolean;
}

/**
 * Runtime forms of the reader settings' closed unions, for the IPC boundary.
 *
 * `reading.saveSettings` took the object whole and persisted it with
 * `JSON.stringify`, so an unknown `pageBackground` or `zoomMode` was stored and
 * then read back by the render path for the life of the book. Probed before
 * adding this: `{pageBackground: "evil", zoom: -5, brightness: NaN}` was stored
 * verbatim as `{"pageBackground":"evil","brightness":null,"zoom":-5}` — `NaN`
 * is not representable in JSON and came back as `null`, which `pageFilter`
 * then interpolated into a CSS filter string.
 */
export const PAGE_BACKGROUNDS = [
  "original",
  "dark",
  "sepia",
  "black",
] as const satisfies readonly BookSettingsView["pageBackground"][];
export const ZOOM_MODES = [
  "fit-width",
  "fit-page",
  "custom",
] as const satisfies readonly BookSettingsView["zoomMode"][];
export const READER_LAYOUTS = ["scroll", "single"] as const satisfies readonly BookSettingsView["layout"][];

// Two-way proofs, as for `API_CHANNELS`. These three index a field of
// `BookSettingsView` rather than a named union, so the field's type is the
// reference: narrowing a union here, or adding a member to it without listing it
// above, fails the build instead of leaving the validator quietly refusing a
// value the type permits.
type MissingPageBackground = Exclude<BookSettingsView["pageBackground"], (typeof PAGE_BACKGROUNDS)[number]>;
const _PageBackgroundsComplete: MissingPageBackground extends never ? true : MissingPageBackground = true;
type MissingZoomMode = Exclude<BookSettingsView["zoomMode"], (typeof ZOOM_MODES)[number]>;
const _ZoomModesComplete: MissingZoomMode extends never ? true : MissingZoomMode = true;
type MissingReaderLayout = Exclude<BookSettingsView["layout"], (typeof READER_LAYOUTS)[number]>;
const _ReaderLayoutsComplete: MissingReaderLayout extends never ? true : MissingReaderLayout = true;

/**
 * Bounds the reader's numeric settings, as a validator's contract.
 *
 * These are deliberately **wider** than the controls currently produce, so the
 * range is what the boundary will accept, not a mirror of the UI. Do not
 * "correct" them toward the sliders: that would reject a persisted value the
 * moment a control's range is narrowed, silently resetting the setting on the
 * next open. The real producers today:
 *
 * - brightness / contrast: the two sliders, `min={0.6} max={1.6}`
 *   (`Reader.tsx`). The 0.25..3 bound leaves headroom for a future
 *   steeper control. There is no zoom control in the reader.
 * - zoom: **no producer writes this field today.** `Reader.tsx`'s
 *   `Math.max(0.25, scale)` writes `reading_position.zoom`, which is a different
 *   field validated only for finiteness (`handlers.ts`); nothing sends
 *   `BookSettingsView.zoom`. The bound is a ceiling the reader's rendering path
 *   is sized for (8) with the same 0.25 floor as the position field, kept so a
 *   future zoom control has a defined range.
 * - cropMargins: 0..0.4, currently only ever 0 — F-READ-04's margin crop has no
 *   control yet.
 *
 * An earlier version of this comment claimed the sliders "run 0.25..3", which
 * was simply false; the bounds never derived from the controls.
 */
export const READER_SETTING_RANGE = {
  brightness: { min: 0.25, max: 3 },
  contrast: { min: 0.25, max: 3 },
  zoom: { min: 0.25, max: 8 },
  cropMargins: { min: 0, max: 0.4 },
} as const;

export interface HighlightView {
  id: number;
  bookId: number;
  page: number;
  color: string;
  text: string;
  note: string | null;
  createdAt: number;
  anchor: {
    page: number;
    rects: Array<{ x: number; y: number; w: number; h: number }>;
    text: string;
    rotation: number;
    anchorVersion: number;
  };
}

export interface NoteHitView {
  path: string;
  title: string;
  snippet: string;
  tags: string[];
  modifiedAt: number;
}

export interface NotesStatusView {
  vault: { path: string; name: string } | null;
  discovered: Array<{ path: string; name: string }>;
  noteCount: number;
  lastIndexAt: number | null;
}

export type GoalKindView = "numeric" | "milestone" | "quota";
export type GoalStatusView = "active" | "completed" | "abandoned";

export interface GoalPaceView {
  fraction: number;
  expectedFraction: number;
  projectedDate: string | null;
  deltaDays: number | null;
  offPace: boolean;
  perDay: number;
  remaining: number;
  daysRemaining: number | null;
}

export interface GoalMilestoneView {
  id: number;
  title: string;
  dueDate: string | null;
  doneAt: number | null;
  sort: number;
  overdue: boolean;
}

export interface GoalContributionView {
  id: number;
  at: number;
  value: number;
  source: string;
  note: string | null;
}

export interface GoalView {
  id: number;
  title: string;
  description: string | null;
  kind: GoalKindView;
  status: GoalStatusView;
  unit: string | null;
  startDate: string;
  targetDate: string | null;
  parentId: number | null;
  closeReason: string | null;
  closedAt: number | null;
  value: number;
  target: number | null;
  pace: GoalPaceView;
  milestones: GoalMilestoneView[];
  milestonesDone: number;
  milestonesTotal: number;
  rollup: number | null;
  childCount: number;
  /** Free-text link to a habit/module metric (F-GOAL-01), or "manual". */
  source: string;
  contributions: GoalContributionView[];
}

export interface NewGoalInput {
  title: string;
  description?: string;
  /** Optional habit/module metric this goal tracks (F-GOAL-01). */
  source?: string;
  kind: GoalKindView;
  targetValue?: number | null;
  unit?: string | null;
  startDate: string;
  targetDate?: string | null;
  parentId?: number | null;
}

export interface DayPointView {
  localDate: string;
  screenSeconds: number;
  focusedSeconds: number;
  mediaSeconds: number;
  readingSeconds: number;
  switches: number;
}

export interface AnalyticsView {
  from: string;
  to: string;
  days: DayPointView[];
  totals: {
    screenSeconds: number;
    focusedSeconds: number;
    mediaSeconds: number;
    readingSeconds: number;
    switches: number;
  };
  activeDayCount: number;
  averageScreenSeconds: number;
  bestDay: DayPointView | null;
  worstDay: DayPointView | null;
  longestStreak: number;
  currentStreak: number;
  /** Screen time in the preceding period of equal length (F-TIME-09). */
  previousScreenSeconds: number;
  /** Percent change vs that period; null when it had no activity. */
  screenDeltaPct: number | null;
}

export interface ActivityCellView {
  weekday: number;
  hour: number;
  seconds: number;
}

export interface HourBucketView {
  hour: number;
  seconds: number;
}

export interface DomainUsageView {
  domain: string;
  seconds: number;
  visits: number;
}

export type BackupKind = "daily" | "weekly" | "manual";
/**
 * Runtime form of `BackupKind`; see `ENTRY_STATUSES` for why these exist.
 *
 * `backupName` falls through to the daily branch for anything that is not
 * exactly `weekly`/`manual`, and the view echoes the string back across the
 * contract as a `BackupKind`, so an unknown member is not refused anywhere.
 */
export const BACKUP_KINDS = ["daily", "weekly", "manual"] as const satisfies readonly BackupKind[];
// Two-way proof, as for `API_CHANNELS`: a member added to `BackupKind` and not
// listed above is a compile error, not a silent runtime gap.
type MissingBackupKind = Exclude<BackupKind, (typeof BACKUP_KINDS)[number]>;
const _BackupKindsComplete: MissingBackupKind extends never ? true : MissingBackupKind = true;

export interface BackupFileView {
  name: string;
  path: string;
  kind: BackupKind;
  bytes: number;
  createdAt: number;
}

export interface BackupStatusView {
  directory: string;
  files: BackupFileView[];
  lastBackupAt: number | null;
}

export interface SiteUsageView {
  domain: string;
  category: string;
  distracting: boolean;
  media: boolean;
  seconds: number;
  visits: number;
  source: "history" | "window-title" | "mixed";
  historySeconds: number;
  titleSeconds: number;
}

export interface CategoryUsageView {
  category: string;
  seconds: number;
  share: number;
  distracting: boolean;
}

export interface SiteTotalsView {
  webSeconds: number;
  distractingSeconds: number;
  mediaSeconds: number;
}

export interface SitesView {
  localDate: string;
  sites: SiteUsageView[];
  totals: SiteTotalsView;
  categories: CategoryUsageView[];
  watch: {
    seconds: number;
    bySite: Array<{ domain: string; seconds: number }>;
    byTitle: Array<{ title: string; seconds: number }>;
  };
}

export interface PageUsageView {
  url: string;
  title: string | null;
  seconds: number;
  visits: number;
}

export interface IngestSummaryView {
  profileDir: string;
  rowsNew: number;
  strategy: string;
  error: string | null;
}

export interface ThemeTokens {
  name: string;
  mode: "dark" | "light";
  background: string;
  sunken: string;
  raised: string;
  foreground: string;
  muted: string;
  selection: string;
  accent: string;
  palette: Record<string, string>;
}

/** F-SET-06: modules that can be deleted by date range (notes are files). */
/** Category vocabulary shared by the Sites rules editor and main. */
export const CATEGORIES = [
  "Work",
  "Entertainment",
  "Social",
  "Learning",
  "Reference",
  "Communication",
  "Shopping",
  "News",
  "Uncategorized",
] as const;

export const DELETE_MODULES = ["time", "sites", "habits", "salah", "reading", "goals"] as const;
export type DeleteModule = (typeof DELETE_MODULES)[number];

/** F-SET-01/02: the configurable folders and excluded apps. */
export interface SystemSettingsView {
  libraryDir: string;
  vaultDir: string | null;
  backupDir: string;
  /** Electron chooses this at launch; reported, not changed. */
  dataDir: string;
  excludedApps: string[];
}

/** Request map: name -> { params, result }. Keep names namespaced by module. */
export interface Api {
  "system.health": { params: undefined; result: HealthReport };
  "system.theme": { params: undefined; result: ThemeTokens };
  "system.pauseTracking": { params: { paused: boolean }; result: { paused: boolean } };
  "system.checkIntegrity": { params: undefined; result: { integrity: string; at: number } };
  "system.autostart": { params: undefined; result: { enabled: boolean } };
  "system.setAutostart": { params: { enabled: boolean }; result: { enabled: boolean } };
  "system.settings": { params: undefined; result: SystemSettingsView };
  "system.setSettings": {
    params: { libraryDir?: string; backupDir?: string; excludedApps?: string[] };
    result: SystemSettingsView;
  };
  "system.rebuildAll": { params: undefined; result: { rebuilt: number } };
  "dashboard.day": { params: { localDate?: string }; result: DaySummary };
  "time.timeline": { params: { localDate?: string }; result: TimelineSegment[] };
  "time.topApps": { params: { localDate?: string }; result: AppUsage[] };
  "time.rebuild": { params: { localDate?: string }; result: { rebuilt: string } };
  "habits.list": { params: { localDate?: string; includeArchived?: boolean }; result: HabitView[] };
  "habits.create": { params: NewHabitInput; result: { id: number } };
  "habits.toggle": {
    params: { habitId: number; localDate?: string };
    result: { status: EntryStatus | null };
  };
  "habits.increment": {
    params: { habitId: number; delta: number; localDate?: string };
    result: { value: number; status: EntryStatus };
  };
  "habits.log": {
    params: { habitId: number; localDate: string; status: EntryStatus; value?: number; note?: string };
    result: { ok: true };
  };
  "habits.clear": { params: { habitId: number; localDate: string }; result: { ok: true } };
  "habits.archive": { params: { habitId: number; archived: boolean }; result: { ok: true } };
  "habits.changeSchedule": {
    params: { habitId: number; effectiveFrom: string; schedule: NewHabitInput["schedule"] };
    result: { ok: true };
  };
  "habits.heatmap": { params: { habitId: number; days?: number; localDate?: string }; result: HeatmapCell[] };
  /** Every habit's heatmap in one call, so a habit toggle is not N IPC calls. */
  "habits.heatmaps": {
    params: { days?: number; localDate?: string };
    result: Record<number, HeatmapCell[]>;
  };

  "salah.day": { params: { localDate?: string }; result: SalahDayView };
  "salah.log": {
    params: {
      prayer: PrayerId;
      localDate?: string;
      status?: PrayerStatus;
      jamaah?: boolean;
      masjid?: string;
    };
    result: { status: PrayerStatus };
  };
  "salah.clear": { params: { prayer: PrayerId; localDate: string }; result: { ok: true } };
  "salah.repayQada": {
    params: { prayer: PrayerId; count?: number };
    result: { byPrayer: Record<PrayerId, number>; total: number };
  };
  "salah.markers": { params: { localDate?: string }; result: PrayerMarker[] };
  "salah.history": {
    params: { days?: number };
    result: Array<{ localDate: string; logged: number; missed: number; excused: number }>;
  };

  "reading.list": { params: undefined; result: BookView[] };
  /** Native PDF picker. In the Api map so it shares the Result contract. */
  "reading.pickBook": { params: undefined; result: string | null };
  "reading.import": { params: { path: string }; result: { id: number; created: boolean } };
  "reading.setPageCount": {
    params: { bookId: number; pageCount: number; title?: string; author?: string };
    result: { ok: true };
  };
  "reading.saveSettings": { params: { bookId: number; settings: BookSettingsView }; result: { ok: true } };
  "reading.savePosition": {
    /** Omitted fields keep their stored value (see BookStore.savePosition). */
    params: { bookId: number; page: number; scrollOffset?: number; zoom?: number };
    result: { ok: true };
  };
  "reading.startSession": { params: { bookId: number }; result: { sessionId: number } };
  "reading.turnPage": { params: { bookId: number }; result: { ok: true } };
  /** Reader heartbeat: visible seconds so far, used when the session closes. */
  "reading.reportVisible": { params: { bookId: number; seconds: number }; result: { ok: true } };
  "reading.endSession": {
    /** `visibleSeconds` comes from the reader; omit only if unknown. */
    params: { bookId: number; visibleSeconds?: number };
    result: { activeSeconds: number; pagesTurned: number };
  };
  "reading.highlights": { params: { bookId: number }; result: HighlightView[] };
  "reading.addHighlight": {
    params: {
      bookId: number;
      page: number;
      color: string;
      text: string;
      anchor: HighlightView["anchor"];
      note?: string;
    };
    result: { id: number };
  };
  "reading.updateNote": { params: { highlightId: number; body: string }; result: { ok: true } };
  "reading.deleteHighlight": { params: { highlightId: number }; result: { ok: true } };
  "reading.exportMarkdown": { params: { bookId: number }; result: { title: string; markdown: string } };

  "goals.list": { params: { includeClosed?: boolean }; result: GoalView[] };
  "goals.get": { params: { goalId: number }; result: GoalView | null };
  "goals.create": { params: NewGoalInput; result: { id: number } };
  "goals.update": {
    params: {
      goalId: number;
      patch: Partial<Pick<NewGoalInput, "title" | "description" | "targetValue" | "unit" | "targetDate">>;
    };
    result: { ok: true };
  };
  "goals.record": { params: { goalId: number; value: number; note?: string }; result: { ok: true } };
  "goals.addMilestone": {
    params: { goalId: number; title: string; dueDate?: string | null };
    result: { id: number };
  };
  "goals.setMilestone": { params: { milestoneId: number; done: boolean }; result: { ok: true } };
  "goals.removeMilestone": { params: { milestoneId: number }; result: { ok: true } };
  "goals.close": {
    params: { goalId: number; status: "completed" | "abandoned"; reason?: string };
    result: { ok: true };
  };
  "goals.reopen": { params: { goalId: number }; result: { ok: true } };

  "analytics.range": { params: { days?: number }; result: AnalyticsView };
  "analytics.activity": { params: { days?: number }; result: ActivityCellView[] };
  "analytics.hourly": { params: { localDate?: string }; result: HourBucketView[] };
  "analytics.domains": { params: { days?: number }; result: DomainUsageView[] };

  "sites.day": { params: { localDate?: string }; result: SitesView };
  "sites.pages": { params: { domain: string; localDate?: string }; result: PageUsageView[] };
  "sites.uncategorized": { params: { limit?: number }; result: Array<{ domain: string; seconds: number }> };
  "sites.categorize": {
    params: { domain: string; category: string; distracting?: boolean; media?: boolean };
    result: { ok: true };
  };
  "sites.ingest": { params: undefined; result: IngestSummaryView[] };
  "sites.lastIngest": { params: undefined; result: IngestSummaryView[] };

  "backup.status": { params: undefined; result: BackupStatusView };
  "backup.create": { params: { kind?: "daily" | "weekly" | "manual" }; result: BackupFileView };
  "backup.restore": {
    params: { name: string };
    /** Staged on disk; applied on the next launch, when no connection is open. */
    result: { restored: true; safetyCopy: string; staged: string };
  };
  "data.exportJson": { params: undefined; result: { path: string; bytes: number } };
  "data.exportCsv": {
    params: { table: string; from?: string; to?: string };
    result: { path: string; bytes: number };
  };
  "data.tables": { params: undefined; result: Array<{ name: string; rows: number }> };
  "data.deleteRange": {
    params: { module: DeleteModule; from?: string | null; to?: string | null; confirm: true };
    result: { deleted: number };
  };

  "notes.status": { params: undefined; result: NotesStatusView };
  "notes.selectVault": { params: { path: string }; result: NotesStatusView };
  "notes.clearVault": { params: undefined; result: NotesStatusView };
  "notes.list": { params: undefined; result: NoteHitView[] };
  "notes.search": { params: { query: string }; result: NoteHitView[] };
  "notes.read": { params: { path: string }; result: { content: string } | null };
  "notes.uri": { params: { path: string; heading?: string }; result: { uri: string } };
  "notes.reindex": { params: undefined; result: { count: number } };
  "notes.open": { params: { path: string; heading?: string }; result: { opened: boolean } };
  "notes.exportHighlights": {
    params: { bookId: number; folder?: string };
    result: { path: string; created: boolean; skipped: boolean };
  };
  "notes.quickCapture": {
    params: { text: string; folder?: string };
    result: { path: string; created: boolean };
  };
  "notes.ensureDailyNote": { params: { folder?: string }; result: { path: string; created: boolean } };
}

export type ApiName = keyof Api;
export type ApiParams<K extends ApiName> = Api[K]["params"];
export type ApiResult<K extends ApiName> = Api[K]["result"];

/**
 * Every IPC channel the renderer may call, as a runtime list.
 *
 * `ApiName` is erased at compile time, so a bridge that concatenates
 * `selfos:${name}` is a generic `ipcRenderer.invoke` passthrough in disguise:
 * the renderer could reach any channel the main process registers, including
 * ones deliberately outside the `Api` map. STACK §2.3/§3.4 require a *closed
 * list*, so the preload checks the name against this array at runtime.
 *
 * The list and the `Api` map agree in both directions, by two mechanisms:
 * `as const satisfies readonly ApiName[]` on this array rejects a *listed name
 * that is not a channel*, and the `_ChannelsAreComplete` assertion below rejects
 * a *channel that is not listed*. Together they close the set; neither does it
 * alone, and an earlier version of this comment credited both to the assertion.
 */
export const API_CHANNELS = [
  "analytics.domains",
  "analytics.hourly",
  "analytics.range",
  "analytics.activity",
  "backup.create",
  "backup.restore",
  "backup.status",
  "dashboard.day",
  "data.exportCsv",
  "data.exportJson",
  "data.tables",
  "data.deleteRange",
  "goals.addMilestone",
  "goals.close",
  "goals.create",
  "goals.get",
  "goals.list",
  "goals.record",
  "goals.removeMilestone",
  "goals.reopen",
  "goals.setMilestone",
  "goals.update",
  "habits.archive",
  "habits.changeSchedule",
  "habits.clear",
  "habits.create",
  "habits.heatmap",
  "habits.heatmaps",
  "habits.increment",
  "habits.list",
  "habits.log",
  "habits.toggle",
  "notes.clearVault",
  "notes.ensureDailyNote",
  "notes.exportHighlights",
  "notes.list",
  "notes.open",
  "notes.quickCapture",
  "notes.read",
  "notes.reindex",
  "notes.search",
  "notes.selectVault",
  "notes.status",
  "notes.uri",
  "reading.addHighlight",
  "reading.deleteHighlight",
  "reading.endSession",
  "reading.exportMarkdown",
  "reading.highlights",
  "reading.import",
  "reading.list",
  "reading.pickBook",
  "reading.reportVisible",
  "reading.savePosition",
  "reading.saveSettings",
  "reading.setPageCount",
  "reading.startSession",
  "reading.turnPage",
  "reading.updateNote",
  "salah.clear",
  "salah.day",
  "salah.history",
  "salah.log",
  "salah.markers",
  "salah.repayQada",
  "sites.categorize",
  "sites.day",
  "sites.ingest",
  "sites.lastIngest",
  "sites.pages",
  "sites.uncategorized",
  "system.checkIntegrity",
  "system.health",
  "system.pauseTracking",
  "system.theme",
  "system.autostart",
  "system.setAutostart",
  "system.settings",
  "system.setSettings",
  "system.rebuildAll",
  "time.rebuild",
  "time.timeline",
  "time.topApps",
] as const satisfies readonly ApiName[];

/**
 * Compile-time proof that every `ApiName` appears in `API_CHANNELS`.
 *
 * `satisfies readonly ApiName[]` only proves the listed strings are valid names —
 * a missing channel would compile fine and then be refused at runtime by the
 * preload guard. This resolves to `true` only when the set of listed names is a
 * superset of every key in `Api`, and `never` (an error at the declaration) when
 * one is missing.
 */
type MissingChannel = Exclude<ApiName, (typeof API_CHANNELS)[number]>;
const _ChannelsAreComplete: MissingChannel extends never ? true : MissingChannel = true;

/** Runtime guard for the preload bridge. */
export function isApiChannel(name: unknown): name is ApiName {
  return typeof name === "string" && (API_CHANNELS as readonly string[]).includes(name);
}

/** Every event main may push, as a runtime list (see `Events`). */
export const EVENT_NAMES = ["theme-changed", "collector-status"] as const satisfies readonly EventName[];

type MissingEvent = Exclude<EventName, (typeof EVENT_NAMES)[number]>;
const _EventsAreComplete: MissingEvent extends never ? true : MissingEvent = true;

/** Runtime guard for `bridge.on`, which is otherwise an untyped channel join. */
export function isEventName(name: unknown): name is EventName {
  return typeof name === "string" && (EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * Convert a transport rejection into the result union the UI expects.
 *
 * `invoke` can reject even though every handler catches: the channel may be
 * unregistered, the main process may throw before the handler runs, or the
 * window may be torn down mid-call. Callers are `Promise.all` loaders, where one
 * rejection discards the sibling results and skips the `setBusy(false)` /
 * `setError` that follows the await, so the bridge applies this to every call.
 * Lives here rather than in the preload so the conversion is unit-testable.
 */
export function transportFailure<T>(err: unknown): Result<T> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message || "IPC call failed" };
}

/**
 * Events pushed from main to renderer.
 *
 * Every member here must have both a sender and a subscriber. `tracking-tick`
 * used to be declared with neither; it was removed rather than left as a
 * contract that nothing honours.
 */
export interface Events {
  "theme-changed": ThemeTokens;
  "collector-status": { running: boolean; paused: boolean };
}

export type EventName = keyof Events;

/**
 * Runtime shape check for a pushed event payload.
 *
 * `bridge.on` hands the payload straight to the subscriber after an unchecked
 * `payload as Events[E]` cast. Unlike `invoke`, there is no result union to
 * absorb a bad value, and a malformed one is rendered directly: a
 * `theme-changed` push whose `palette` is missing or null makes `themeVars()`
 * (`App.tsx:67`) throw inside `App`'s own render — verified, `TypeError:
 * Cannot convert undefined or null to object`. That is a throw in the shell
 * itself, above the module boundary.
 *
 * A payload that fails this check is dropped and logged rather than handed on:
 * a missing theme push is a cosmetic loss, a crash is not. Deliberately shallow
 * — it checks the fields the renderer dereferences, not every token, so adding
 * a field to `ThemeTokens` does not silently start dropping events.
 */
export function isValidEventPayload<E extends EventName>(event: E, payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (event === "theme-changed") {
    return (
      typeof p.name === "string" &&
      (p.mode === "dark" || p.mode === "light") &&
      !!p.palette &&
      typeof p.palette === "object" &&
      ["background", "sunken", "raised", "foreground", "muted", "selection", "accent"].every(
        (k) => typeof p[k] === "string",
      )
    );
  }
  if (event === "collector-status") {
    return typeof p.running === "boolean" && typeof p.paused === "boolean";
  }
  return true;
}

/**
 * The shape exposed on `window.selfos` by the preload bridge.
 * Deliberately narrow: no generic invoke, no filesystem, no process access.
 */
export interface SelfOSBridge {
  invoke<K extends ApiName>(name: K, params: ApiParams<K>): Promise<Result<ApiResult<K>>>;
  on<E extends EventName>(event: E, handler: (payload: Events[E]) => void): () => void;
}
