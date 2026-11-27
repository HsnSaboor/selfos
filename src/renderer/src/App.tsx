import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AppUsage,
  type BookView,
  type DaySummary,
  type HabitView,
  type HealthReport,
  MODULE_IDS,
  type ModuleId,
  PRAYER_COUNT,
  type PrayerMarker,
  type ThemeTokens,
  type TimelineSegment,
} from "../../shared/api";
import { todayKey } from "../../shared/dates";
import { formatBytes, formatClock, formatDateTime, formatDuration } from "../../shared/format";
import { AnalyticsView } from "./components/Analytics";
import { type Command, CommandPalette } from "./components/CommandPalette";
import { DataPage } from "./components/Data";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GoalsView } from "./components/Goals";
import { HabitsView } from "./components/Habits";
import { Kpi } from "./components/Kpi";
import { NotesView } from "./components/Notes";
import { ReadingView } from "./components/Reading";
import { SalahView } from "./components/Salah";
import { SitesView } from "./components/Sites";
import { colorFor, Timeline, TopApps } from "./components/Timeline";

/**
 * Sidebar labels, keyed by the shared module id.
 *
 * `as const satisfies Record<ModuleId, string>` keeps two properties that a
 * computed `capitalize()` map lost: adding a module without a label fails the
 * build, and `ModuleName` stays a literal union instead of collapsing to
 * `string` (which made every `active === "…"` comparison unchecked).
 */
const MODULE_LABELS = {
  dashboard: "Dashboard",
  reading: "Reading",
  habits: "Habits",
  time: "Time",
  analytics: "Analytics",
  sites: "Sites",
  salah: "Salah",
  notes: "Notes",
  goals: "Goals",
  data: "Data",
} as const satisfies Record<ModuleId, string>;

type ModuleName = (typeof MODULE_LABELS)[ModuleId];
const MODULES: readonly ModuleName[] = MODULE_IDS.map((id) => MODULE_LABELS[id]);

declare global {
  interface Window {
    selfos: import("../../shared/api").SelfOSBridge;
  }
}

function themeVars(t: ThemeTokens): React.CSSProperties {
  const vars: Record<string, string> = {
    "--bg": t.background,
    "--bg-sunken": t.sunken,
    "--bg-raised": t.raised,
    "--fg": t.foreground,
    "--fg-muted": t.muted,
    "--selection": t.selection,
    "--accent": t.accent,
  };
  for (const [k, v] of Object.entries(t.palette)) vars[`--c-${k}`] = v;
  return vars as React.CSSProperties;
}

function App() {
  const [active, setActive] = useState<ModuleName>("Dashboard");
  const [theme, setTheme] = useState<ThemeTokens | null>(null);
  const [day, setDay] = useState<DaySummary | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [prayers, setPrayers] = useState<PrayerMarker[]>([]);
  const [apps, setApps] = useState<AppUsage[]>([]);
  const [habits, setHabits] = useState<HabitView[]>([]);
  const [books, setBooks] = useState<BookView[]>([]);
  /** F-SET-08 manual override, persisted locally (auto follows Omarchy). */
  const [themeOverride, setThemeOverride] = useState<"auto" | "light" | "dark">(() => {
    const saved = localStorage.getItem("selfos.theme.override");
    return saved === "light" || saved === "dark" ? saved : "auto";
  });
  /**
   * Errors keyed by source.
   *
   * One shared string forced a bad trade: clearing it on success erased
   * unrelated failures, and not clearing it made any failure permanent. Keying
   * by source lets each operation clear only its own entry.
   */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const setErrorFor = useCallback((source: string, message: string | null) => {
    setErrors((prev) => {
      if (message === null) {
        if (!(source in prev)) return prev;
        const next = { ...prev };
        delete next[source];
        return next;
      }
      return prev[source] === message ? prev : { ...prev, [source]: message };
    });
  }, []);
  const error = Object.values(errors).join("; ") || null;
  const [paletteOpen, setPaletteOpen] = useState(false);

  /**
   * Fetch the dashboard snapshot.
   *
   * Failures are collected per call and reported together with the operation
   * that failed: the previous version overwrote one shared string, so only the
   * last failure survived and the message never named what broke.
   */
  const refreshDashboard = useCallback(async () => {
    const [d, h, tl, ta, pm, hb, bk] = await Promise.all([
      window.selfos.invoke("dashboard.day", {}),
      window.selfos.invoke("system.health", undefined),
      window.selfos.invoke("time.timeline", {}),
      window.selfos.invoke("time.topApps", {}),
      window.selfos.invoke("salah.markers", {}),
      window.selfos.invoke("habits.list", {}),
      window.selfos.invoke("reading.list", undefined),
    ]);
    const failures: string[] = [];
    if (d.ok) setDay(d.data);
    else failures.push(`day: ${d.error}`);
    if (h.ok) setHealth(h.data);
    else failures.push(`health: ${h.error}`);
    if (tl.ok) setSegments(tl.data);
    else failures.push(`timeline: ${tl.error}`);
    if (ta.ok) setApps(ta.data);
    else failures.push(`apps: ${ta.error}`);
    if (pm.ok) setPrayers(pm.data);
    else failures.push(`prayers: ${pm.error}`);
    if (hb.ok) setHabits(hb.data);
    else failures.push(`habits: ${hb.error}`);
    if (bk.ok) setBooks(bk.data);
    else failures.push(`reading: ${bk.error}`);
    // Clears only this source's entry, so a recovered dashboard stops showing
    // its own error without erasing an unrelated theme or command failure.
    setErrorFor("dashboard", failures.length ? failures.join("; ") : null);
  }, [setErrorFor]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await window.selfos.invoke("system.theme", undefined);
      if (!alive) return;
      if (t.ok) setTheme(t.data);
      else setErrorFor("theme", t.error);
      if (!alive) return;
      await refreshDashboard();
    })();
    const offTheme = window.selfos.on("theme-changed", (t) => {
      setTheme(t);
      setErrorFor("theme", null);
    });
    // Tracking can be paused from the tray while this window is hidden, so the
    // health state is updated from the pushed event rather than waiting for the
    // next dashboard poll. Note: this feeds the dashboard's System-health panel,
    // NOT the F-SHELL-08 status strip — that strip is not implemented (see the
    // "Still open" section of the review report). The push is the data half.
    const offCollector = window.selfos.on("collector-status", (state) => {
      setHealth((prev) =>
        prev
          ? {
              ...prev,
              collector: {
                ...prev.collector,
                ...state,
                // The payload carries no reason; keeping the last one made a
                // manual resume still display "paused (idle)".
                pauseReason: state.paused ? prev.collector.pauseReason : null,
              },
            }
          : prev,
      );
    });
    return () => {
      alive = false;
      offTheme();
      offCollector();
    };
  }, [refreshDashboard, setErrorFor]);

  /**
   * Refresh the live numbers only while the dashboard is actually visible.
   *
   * This used to run every 5 s for the whole app lifetime: it kept re-fetching
   * the day's segments and the health snapshot while the user was reading, and
   * while the window sat hidden in the tray (close-to-tray is the normal
   * steady state). Four IPC calls every tick is real work on the process
   * `earlyoom` prefers (STACK S1), so the poll is gated on both the route and
   * window visibility.
   */
  useEffect(() => {
    if (active !== "Dashboard") return;
    const tick = () => {
      if (document.hidden) return;
      void refreshDashboard();
    };
    const refresh = setInterval(tick, 5000);
    return () => clearInterval(refresh);
  }, [active, refreshDashboard]);

  // Ctrl+K opens the palette from anywhere, including while a note or reader is
  // focused; the palette's own handler owns every key while it is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // F-SHELL-06: Ctrl/Cmd+1…7 jump straight to a module.
      const index = Number(e.key) - 1;
      if ((e.ctrlKey || e.metaKey) && index >= 0 && index < MODULES.length) {
        e.preventDefault();
        setActive(MODULES[index] as ModuleName);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = MODULES.map((m) => ({
      id: `nav-${m}`,
      label: m,
      hint: "Go to",
      run: () => setActive(m),
    }));
    return [
      ...nav,
      {
        id: "toggle-tracking",
        label: health?.collector.paused ? "Resume tracking" : "Pause tracking",
        hint: "Time",
        run: async () => {
          // Keyed by command id, not a shared "command": a successful backup
          // used to clear a still-relevant daily-note failure and vice versa,
          // which is exactly what the per-source keying exists to prevent.
          const res = await window.selfos.invoke("system.pauseTracking", {
            paused: !health?.collector.paused,
          });
          if (!res.ok) {
            setErrorFor("command:toggle-tracking", res.error);
            return;
          }
          setErrorFor("command:toggle-tracking", null);
          // The `collector-status` push also updates this; the refetch covers the
          // case where the push is unavailable.
          const h = await window.selfos.invoke("system.health", undefined);
          if (h.ok) setHealth(h.data);
        },
      },
      {
        id: "backup-now",
        label: "Back up the database now",
        hint: "Data",
        run: async () => {
          const res = await window.selfos.invoke("backup.create", { kind: "manual" });
          if (res.ok) setErrorFor("command:backup-now", null);
          else setErrorFor("command:backup-now", res.error);
        },
      },
      {
        id: "daily-note",
        label: "Open today's daily note",
        hint: "Notes",
        run: async () => {
          const res = await window.selfos.invoke("notes.ensureDailyNote", {});
          setActive("Notes");
          if (res.ok) setErrorFor("command:daily-note", null);
          else setErrorFor("command:daily-note", res.error);
        },
      },
    ];
  }, [health?.collector.paused, setErrorFor]);

  const style = useMemo(() => (theme ? themeVars(theme) : undefined), [theme]);

  /**
   * Today's local date, kept current without relying on the dashboard poll.
   *
   * The poll is gated to the Dashboard route, so `day.localDate` can be a day
   * old on every other screen. Anything that *writes* (habit toggles, prayer
   * logs, site categorising) must use the real date, or a 00:05 action lands on
   * yesterday. Re-checked on a timer so a window left open across midnight
   * rolls over on its own.
   */
  const [today, setToday] = useState(() => todayKey());
  useEffect(() => {
    const tick = () =>
      setToday((prev) => {
        const next = todayKey();
        return prev === next ? prev : next;
      });
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);

  // Local midnight, used to place segments on the 24 h axis.
  // Derived from the selected day rather than "now", so the timeline stays on
  // the right axis and the dependency is honest.
  const dayStart = useMemo(() => {
    const key = day?.localDate;
    if (key) {
      const [y, m, d] = key.split("-").map(Number) as [number, number, number];
      return new Date(y, m - 1, d).getTime();
    }
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.getTime();
  }, [day?.localDate]);

  const effectiveMode = themeOverride === "auto" ? (theme?.mode ?? "dark") : themeOverride;
  // A manual light override needs light tokens, not only `color-scheme`: the
  // Omarchy palette is dark, and the inline vars would otherwise win.
  const LIGHT_TOKENS: Record<string, string> = {
    "--bg": "#f7f3ea",
    "--bg-sunken": "#efe9dd",
    "--bg-raised": "#e6dfd2",
    "--fg": "#2b2b2b",
    "--fg-muted": "#6b6357",
    "--selection": "#d8cfbf",
    "--accent": "#2f6f63",
  };
  const effectiveStyle =
    effectiveMode === "light" && theme?.mode !== "light"
      ? ({ ...style, ...LIGHT_TOKENS } as React.CSSProperties)
      : style;
  const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const nextPrayer =
    prayers.find((p) => {
      const [h, m] = p.time.split(":").map(Number);
      return (h ?? 0) * 60 + (m ?? 0) > nowMinutes;
    }) ?? null;
  const currentlyReading = books.find((b) => b.percent > 0 && b.lastReadAt !== null) ?? null;
  const [busyPrayer, setBusyPrayer] = useState<string | null>(null);

  return (
    <div className="app" style={effectiveStyle} data-theme={effectiveMode}>
      <aside className="sidebar">
        <div className="brand">SelfOS</div>
        <nav>
          {MODULES.map((m) => (
            <button
              key={m}
              type="button"
              className={`nav-item${m === active ? " active" : ""}`}
              onClick={() => setActive(m)}
              aria-current={m === active ? "page" : undefined}
            >
              {m}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {health ? (
            <>
              <div>schema v{health.schemaVersion}</div>
              <div>integrity: {health.integrity}</div>
            </>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{active === "Dashboard" ? "Today" : active}</h1>
            {/* `?? "—"` alone was not enough: the bridge can hand back an
                empty string, which rendered as a blank line. `hijriSource`
                says which calendar produced the date, so a value the salah
                stack supplied can be told apart from a computed one. */}
            <div className="muted" title={day ? `Hijri date from ${day.hijriSource}` : undefined}>
              {day?.hijri || "—"}
              <span className="sep"> · </span>
              {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            </div>
          </div>
          <div className="topbar-right">
            <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)}>
              <span>Search</span>
              <kbd>Ctrl K</kbd>
            </button>
            <span className="muted">{theme?.name ?? ""}</span>
          </div>
        </header>

        {/* F-SHELL-08: a persistent strip — tracking state, current activity,
            next prayer and DB health — visible from every module. */}
        <div className="status-strip" role="status">
          <span className={`dot ${health?.collector.running && !health.collector.paused ? "on" : ""}`} />
          <span>
            {health?.collector.paused ? "paused" : health?.collector.running ? "tracking" : "stopped"}
          </span>
          <span className="sep">·</span>
          <span className="truncate">{apps[0]?.appClass ?? "no activity"}</span>
          <span className="sep">·</span>
          <span>{nextPrayer ? `${nextPrayer.prayer} ${nextPrayer.time}` : "no prayer times"}</span>
          <span className="sep">·</span>
          <span>{health ? `db ${formatBytes(health.dbSizeBytes)} · ${health.integrity}` : "db …"}</span>
          <span className="grow" />
          <select
            className="input narrow"
            value={themeOverride}
            onChange={(e) => {
              const v = e.target.value as "auto" | "light" | "dark";
              setThemeOverride(v);
              localStorage.setItem("selfos.theme.override", v);
            }}
            aria-label="Theme override"
          >
            <option value="auto">theme: auto</option>
            <option value="light">theme: light</option>
            <option value="dark">theme: dark</option>
          </select>
        </div>

        {error ? <div className="error">IPC error: {error}</div> : null}

        {/* One boundary around the module area, keyed by `active`: a throw in
            any screen leaves the sidebar usable, and switching modules clears
            the error (in `componentDidUpdate` — the instance is not remounted,
            having no React `key`). Previously a render throw unmounted the whole
            root and the app could not recover without editing SQLite by hand. */}
        <ErrorBoundary resetKey={active}>
          {active === "Habits" ? <HabitsView localDate={today} /> : null}
          {active === "Salah" ? <SalahView localDate={today} /> : null}
          {active === "Reading" ? <ReadingView /> : null}
          {active === "Notes" ? <NotesView /> : null}
          {active === "Goals" ? <GoalsView localDate={today} /> : null}
          {active === "Analytics" || active === "Time" ? <AnalyticsView /> : null}
          {active === "Sites" ? <SitesView localDate={today} /> : null}
          {active === "Data" ? <DataPage /> : null}
          {active !== "Dashboard" ? null : (
            <>
              <section className="kpis">
                {/* F-DASH-03: focused time, screen time, watch time, reading
                  time, habits, prayers and best streak, each clickable to its
                  module. "Focused" is screen time minus sub-15s switch noise,
                  NOT screen time minus media — media segments are long enough to
                  count in both, and `mediaSeconds` is accumulated separately (see
                  the header of modules/time/aggregate.ts). The row previously
                  showed only screen time, with no streak and no tile that did
                  anything. */}
                <Kpi
                  label="Focused"
                  value={formatDuration(day?.focusedSeconds ?? 0)}
                  sub="active work"
                  onClick={() => setActive("Analytics")}
                />
                <Kpi
                  label="Screen time"
                  value={formatDuration(day?.screenSeconds ?? 0)}
                  sub="all time at the screen"
                  onClick={() => setActive("Analytics")}
                />
                <Kpi
                  label="Watch time"
                  value={formatDuration(day?.watchSeconds ?? 0)}
                  sub="local + browser"
                  onClick={() => setActive("Analytics")}
                />
                <Kpi
                  label="Reading"
                  value={formatDuration(day?.readingSeconds ?? 0)}
                  onClick={() => setActive("Reading")}
                />
                <Kpi
                  label="Habits"
                  value={`${day?.habitsDone ?? 0}/${day?.habitsTotal ?? 0}`}
                  onClick={() => setActive("Habits")}
                />
                <Kpi
                  label="Prayers"
                  value={`${day?.prayersLogged ?? 0}/${PRAYER_COUNT}`}
                  onClick={() => setActive("Salah")}
                />
                <Kpi
                  label="Best streak"
                  value={`${day?.bestStreak ?? 0}d`}
                  sub="habits"
                  onClick={() => setActive("Habits")}
                />
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>Today</h2>
                  <span className="muted">
                    {day ? `${formatClock(day.firstActivity)} – ${formatClock(day.lastActivity)}` : ""}
                  </span>
                </div>
                <Timeline segments={segments} dayStart={dayStart} prayers={prayers} />
                {/* F-DASH-04: next prayer + today's checklist with one-tap logging. */}
                <section className="panel">
                  <h2>Prayers</h2>
                  {nextPrayer ? (
                    <p className="muted panel-note">
                      Next: {nextPrayer.prayer} at {nextPrayer.time}
                    </p>
                  ) : null}
                  <div className="prayer-row">
                    {prayers.map((p) => (
                      <button
                        key={p.prayer}
                        type="button"
                        className={`mini${p.status ? " done" : ""}`}
                        disabled={busyPrayer === p.prayer}
                        onClick={async () => {
                          setBusyPrayer(p.prayer);
                          const res = await window.selfos.invoke("salah.log", { prayer: p.prayer });
                          setBusyPrayer(null);
                          if (!res.ok) setErrorFor("dashboard-prayer", res.error);
                          else await refreshDashboard();
                        }}
                      >
                        {p.prayer}
                        {p.status ? ` · ${p.status}` : ""}
                      </button>
                    ))}
                  </div>
                </section>

                {/* F-DASH-05: today's habits, one tap each. */}
                <section className="panel">
                  <h2>Habits</h2>
                  {habits.filter((h) => h.archivedAt === null).length === 0 ? (
                    <div className="empty">No habits yet.</div>
                  ) : (
                    <div className="habit-row">
                      {habits
                        .filter((h) => h.archivedAt === null)
                        .map((h) => (
                          <button
                            key={h.id}
                            type="button"
                            className={`mini${h.todayEntry?.status === "done" || h.todayEntry?.status === "clean" ? " done" : ""}`}
                            onClick={async () => {
                              const res = await window.selfos.invoke("habits.toggle", { habitId: h.id });
                              if (!res.ok) setErrorFor("dashboard-habit", res.error);
                              else await refreshDashboard();
                            }}
                          >
                            {h.name}
                          </button>
                        ))}
                    </div>
                  )}
                </section>

                {/* F-DASH-06: currently reading, with progress and resume. */}
                {currentlyReading ? (
                  <section className="panel">
                    <h2>Currently reading</h2>
                    <p className="muted panel-note">
                      {currentlyReading.title} · {Math.round(currentlyReading.percent * 100)}%
                    </p>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setActive("Reading");
                      }}
                    >
                      Resume
                    </button>
                  </section>
                ) : null}

                <div className="legend">
                  {apps.slice(0, 5).map((a) => (
                    <span key={a.appClass} className="legend-item">
                      <span className="app-dot" style={{ background: colorFor(a.appClass) }} />
                      {a.appClass}
                    </span>
                  ))}
                </div>
              </section>

              <section className="panel">
                <h2>Top apps</h2>
                <TopApps apps={apps} />
              </section>

              <section className="panel">
                <h2>System health</h2>
                {health ? (
                  <table>
                    <tbody>
                      <tr>
                        <td>Database</td>
                        <td>{health.dbPath}</td>
                      </tr>
                      <tr>
                        <td>Size</td>
                        <td>{formatBytes(health.dbSizeBytes)}</td>
                      </tr>
                      <tr>
                        <td>Integrity</td>
                        <td>{health.integrity}</td>
                      </tr>
                      <tr>
                        <td>Tracking</td>
                        <td>
                          {health.collector.paused
                            ? `paused (${health.collector.pauseReason ?? "manual"})`
                            : "active"}
                          {" · "}
                          {health.collector.connected ? "socket connected" : "socket disconnected"}
                          {" · "}
                          {health.collector.segmentsWritten} segments
                        </td>
                      </tr>
                      <tr>
                        <td>Events</td>
                        <td>
                          {Object.entries(health.collector.eventCounts)
                            .map(([k, v]) => `${k}:${v}`)
                            .join("  ") || "none yet"}
                        </td>
                      </tr>
                      <tr>
                        {/* F-SET-07 requires the health page to show "last
                            ingest time". The value was already computed per
                            browser profile and carried in the contract, but
                            nothing rendered it, so the MUST read as unmet while
                            the data sat unused one field away. */}
                        <td>Last ingest</td>
                        <td>
                          {(() => {
                            const times = health.browserProfiles
                              .map((p) => p.lastIngestAt)
                              .filter((t): t is number => typeof t === "number");
                            // `formatDateTime`, not `formatClock`: a clock-only
                            // time renders an ingest from days ago as if it were
                            // today. This matches how the Data screen renders
                            // `lastBackupAt` (`Data.tsx`) — it is not a sibling
                            // row of this table, which has no backup row.
                            return times.length ? formatDateTime(Math.max(...times)) : "never";
                          })()}
                        </td>
                      </tr>
                      <tr>
                        <td>earlyoom prefers Electron</td>
                        <td>{health.earlyoomPreference ? "yes — memory is watched" : "no"}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <div className="muted">loading…</div>
                )}

                <h3>Browser profiles</h3>
                {health?.browserProfiles.map((p) => (
                  <div key={p.profileDir} className="profile-row">
                    <strong>{p.profileDir}</strong>
                    <span className={`pill ${p.strategy}`}>{p.strategy}</span>
                    <span className="muted">{p.exists ? "history found" : "history missing"}</span>
                  </div>
                ))}
              </section>
            </>
          )}
        </ErrorBoundary>
      </main>

      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export default App;
