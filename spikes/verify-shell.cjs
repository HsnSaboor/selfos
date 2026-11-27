// M0 verification: launch the built app, exercise IPC, screenshot, exit.
// This is the app entrypoint for the verification run; it loads the real
// built main process from out/main/index.cjs and then asserts against it.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M0-shell", "m0-shell.json", "M0");

// Boot the real app.
require("../out/main/index.cjs");

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 4000));
  const wins = BrowserWindow.getAllWindows();
  step("window-created", wins.length > 0, `${wins.length} window(s)`);
  const win = wins[0];
  if (!win) return finish();

  // A verifier deliberately keeps its window unmapped: mapping it would steal
  // focus and let the workspace-5 window rule move the user's workspace.
  step("window-unmapped-by-design", !win.isVisible(), `visible=${win.isVisible()}`);
  const url = win.webContents.getURL();
  // M4 moved the renderer onto its own scheme so custom-protocol fetches share
  // an origin with the page (a file:// origin cannot do that).
  step("renderer-loaded", url.startsWith("selfos-app://"), url);

  const dom = await win.webContents.executeJavaScript(`({
    rootChildren: document.getElementById("root")?.children.length ?? 0,
    hasBridge: typeof window.selfos === "object",
    navItems: document.querySelectorAll(".nav-item").length,
    navLabels: [...document.querySelectorAll(".nav-item")].map((b) => b.textContent.trim()),
    kpis: document.querySelectorAll(".kpi").length,
    kpiLabels: [...document.querySelectorAll(".kpi-label")].map(e => e.textContent.trim()),
    kpiClickable: [...document.querySelectorAll(".kpi")].filter(e => e.tagName === "BUTTON").length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    errorBanner: document.querySelector(".error")?.textContent ?? null,
    title: document.querySelector("h1")?.textContent ?? null,
  })`);
  step("react-mounted", dom.rootChildren > 0, `root children: ${dom.rootChildren}`);
  step("preload-bridge", dom.hasBridge);
  // Assert the nav covers every module, rather than pinning a count that has
  // to be edited on every milestone.
  const EXPECTED_NAV = [
    "Dashboard", "Reading", "Habits", "Time", "Analytics", "Sites", "Salah", "Notes", "Goals", "Data",
  ];
  step(
    "nav-rendered",
    EXPECTED_NAV.every((m) => dom.navLabels.includes(m)) && dom.navItems === EXPECTED_NAV.length,
    `${dom.navItems} items`,
  );
  // F-DASH-03 names the measures and requires each tile to be clickable, so
  // assert the set rather than a count that silently accepted a missing one.
  const EXPECTED_KPIS = ["Focused", "Screen time", "Watch time", "Reading", "Habits", "Prayers", "Best streak"];
  step(
    "kpis-rendered",
    EXPECTED_KPIS.every((k) => dom.kpiLabels.includes(k)) && dom.kpis === EXPECTED_KPIS.length,
    `${dom.kpis} kpis: ${dom.kpiLabels.join(", ")}`,
  );
  step("kpis-clickable", dom.kpiClickable === dom.kpis, `${dom.kpiClickable}/${dom.kpis} are buttons`);
  step("no-ipc-error", dom.errorBanner === null, dom.errorBanner ?? "");
  report.dom = dom;

  const ipc = await win.webContents.executeJavaScript(`(async () => {
    const h = await window.selfos.invoke("system.health", undefined);
    const t = await window.selfos.invoke("system.theme", undefined);
    const d = await window.selfos.invoke("dashboard.day", {});
    const bad = await window.selfos.invoke("system.pauseTracking", { paused: "yes" });
    return {
      healthOk: h.ok, schema: h.ok ? h.data.schemaVersion : null,
      integrity: h.ok ? h.data.integrity : null,
      earlyoom: h.ok ? h.data.earlyoomPreference : null,
      profiles: h.ok ? h.data.browserProfiles.map(p => p.profileDir + ":" + p.strategy) : null,
      themeOk: t.ok, themeName: t.ok ? t.data.name : null, accent: t.ok ? t.data.accent : null,
      dayOk: d.ok, hijri: d.ok ? d.data.hijri : null,
      badOk: bad.ok, badError: bad.ok ? null : bad.error,
    };
  })()`);
  step("ipc-health", ipc.healthOk, `schema v${ipc.schema}, integrity ${ipc.integrity}`);
  step("ipc-theme", ipc.themeOk, `${ipc.themeName} accent=${ipc.accent}`);
  step("ipc-dashboard", ipc.dayOk, `hijri: ${ipc.hijri}`);
  step("ipc-validation", ipc.badOk === false, ipc.badError ?? "");
  // Host state, not app behaviour: report the shape and note the host value.
  step("earlyoom-shape", typeof ipc.earlyoom === "boolean", `host earlyoom=${ipc.earlyoom}`);
  step("browser-profiles-shape", Array.isArray(ipc.profiles), (ipc.profiles ?? []).length + " configured");
  report.ipc = ipc;

  /**
   * Every channel that takes a date must reject a malformed one.
   *
   * `local_date` is the key every table is bucketed by, and nothing in main
   * validated it: a probed `salah.log {localDate: "junk"}` stored the row, and
   * the day then reported zero logged. The row is invisible to the dashboard,
   * the streak, the heatmap and the day aggregate at once, with no error shown.
   * `"2026-13-45"` is included because a shape-only check would accept it.
   */
  const dates = await win.webContents.executeJavaScript(`(async () => {
    const junk = ["junk", "2026-13-45", "", "2026-11-03T00:00:00Z"];
    const tries = [];
    for (const value of junk) {
      tries.push(["dashboard.day", (await window.selfos.invoke("dashboard.day", { localDate: value })).ok]);
      tries.push(["time.timeline", (await window.selfos.invoke("time.timeline", { localDate: value })).ok]);
      tries.push(["time.rebuild", (await window.selfos.invoke("time.rebuild", { localDate: value })).ok]);
      tries.push(["analytics.hourly", (await window.selfos.invoke("analytics.hourly", { localDate: value })).ok]);
      tries.push(["sites.day", (await window.selfos.invoke("sites.day", { localDate: value })).ok]);
      tries.push(["salah.day", (await window.selfos.invoke("salah.day", { localDate: value })).ok]);
      tries.push(["salah.clear", (await window.selfos.invoke("salah.clear", { prayer: "fajr", localDate: value })).ok]);
      tries.push(["habits.list", (await window.selfos.invoke("habits.list", { localDate: value })).ok]);
      tries.push(["habits.log", (await window.selfos.invoke("habits.log", { habitId: 1, localDate: value, status: "done" })).ok]);
      tries.push(["goals.addMilestone", (await window.selfos.invoke("goals.addMilestone", { goalId: 1, title: "x", dueDate: value })).ok]);
      tries.push(["data.exportCsv", (await window.selfos.invoke("data.exportCsv", { table: "habit", from: value })).ok]);
    }
    // A valid date must still be accepted, or the guard would be a wall.
    const good = await window.selfos.invoke("dashboard.day", { localDate: "2026-11-03" });
    // An omitted date must still default to today.
    const omitted = await window.selfos.invoke("dashboard.day", {});
    // An empty string is a value the caller *sent*, not an omitted field, and
    // coercing it to today was the same silent substitution one layer up.
    const empty = await window.selfos.invoke("dashboard.day", { localDate: "" });

    /**
     * Every range-taking channel must refuse a non-finite range by name.
     *
     * A NaN used to reach the date walk, which threw "Invalid time value" from
     * inside Date — a message naming neither the channel nor the field — while
     * the habit channels refused the same input properly.
     */
    const ranges = [];
    for (const days of [NaN, Infinity, -Infinity]) {
      ranges.push(["analytics.range", (await window.selfos.invoke("analytics.range", { days })).ok]);
      ranges.push(["analytics.domains", (await window.selfos.invoke("analytics.domains", { days })).ok]);
    }
    // A negative page limit is not clamped by slice: slice(0, -1) counts
    // from the end, so limit -1 returned every domain but the last.
    const negativeLimit = await window.selfos.invoke("sites.uncategorized", { limit: -1 });
    // The ceiling is still a clamp, not a refusal: an absurd-but-real range must
    // work, bounded, rather than erroring.
    const clamped = await window.selfos.invoke("salah.history", { days: 1e9 });
    return {
      acceptedJunk: tries.filter(([, ok]) => ok).map(([name]) => name),
      attempts: tries.length,
      goodOk: good.ok,
      omittedOk: omitted.ok,
      emptyOk: empty.ok,
      acceptedRanges: ranges.filter(([, ok]) => ok).map(([name]) => name),
      rangeAttempts: ranges.length,
      negativeLimitOk: negativeLimit.ok,
      clampedOk: clamped.ok,
      clampedLength: clamped.ok ? clamped.data.length : null,
    };
  })()`);
  step(
    "date-validation",
    dates.acceptedJunk.length === 0,
    dates.acceptedJunk.length === 0
      ? `${dates.attempts} malformed dates refused`
      : `accepted: ${dates.acceptedJunk.join(", ")}`,
  );
  step("date-validation-valid-passes", dates.goodOk && dates.omittedOk, `valid=${dates.goodOk} omitted=${dates.omittedOk}`);
  step(
    "date-validation-empty-string-refused",
    dates.emptyOk === false,
    dates.emptyOk === false ? "" : "an empty localDate was coerced to today",
  );
  step(
    "range-validation",
    dates.acceptedRanges.length === 0 && dates.negativeLimitOk === false,
    dates.acceptedRanges.length === 0 && dates.negativeLimitOk === false
      ? `${dates.rangeAttempts} non-finite ranges and a negative limit refused`
      : `accepted: ${dates.acceptedRanges.join(", ")}${dates.negativeLimitOk ? ", negative limit" : ""}`,
  );
  step(
    "range-clamped-not-refused",
    dates.clampedOk && dates.clampedLength === 366,
    `salah.history 1e9 -> ${dates.clampedLength} days`,
  );
  report.dates = dates;

  /**
   * Every closed-union field the renderer supplies must be checked at the
   * boundary, not trusted.
   *
   * `habits.create` checked only that `kind` was a *string*, so
   * `{kind: "bogus", schedule: {kind: "bogus"}}` was stored. `daySatisfies`
   * switches on `habit.kind` with no `default`, so the habit could never be
   * satisfied: its streak and 30-day completion read 0 forever, with no error
   * shown anywhere and no UI way to repair the row. The `habits.log` guard two
   * handlers away already stated this exact rationale for `status`; it simply
   * was not carried across. `reading.addHighlight` validated `page`/`color`
   * but persisted an anchor the reader later calls `.every()` and
   * `normalizeText()` on, which throws. At the time, with no error boundary, the
   * whole renderer went blank and re-crashed on every open of that book; the
   * renderer now has module- and root-level boundaries plus a read-side
   * normaliser, so the guard is the outermost of three defences.
   */
  const enums = await win.webContents.executeJavaScript(`(async () => {
    const try_ = async (name, params) => ({ name, res: await window.selfos.invoke(name, params) });
    const bad = [];
    bad.push(await try_("habits.create", { name: "p", kind: "bogus", schedule: { kind: "daily" } }));
    bad.push(await try_("habits.create", { name: "p", kind: "boolean", schedule: { kind: "bogus" } }));
    bad.push(await try_("habits.create", { name: "p", kind: "boolean", schedule: { kind: "weekdays", weekdays: [0, 9] } }));
    bad.push(await try_("habits.create", { name: "p", kind: "boolean", schedule: { kind: "times_per_week", timesPerPeriod: 0 } }));
    bad.push(await try_("backup.create", { kind: "bogus" }));
    bad.push(await try_("goals.create", { title: "g", kind: "numeric", startDate: "2026-13-45", targetDate: null }));

    // A valid schedule must still be accepted, or the guard is a wall.
    const good = await window.selfos.invoke("habits.create", {
      name: "enum-ok", kind: "count", target: 2, schedule: { kind: "weekdays", weekdays: [1, 3, 5] },
    });
    return {
      accepted: bad.filter((b) => b.res.ok).map((b) => b.name),
      attempts: bad.length,
      named: bad.every((b) => typeof b.res.error === "string" && b.res.error.length > 0),
      goodOk: good.ok,
    };
  })()`);
  step(
    "enum-validation",
    enums.accepted.length === 0 && enums.named,
    enums.accepted.length === 0
      ? `${enums.attempts} malformed enums/values refused, each with a named message`
      : `accepted: ${enums.accepted.join(", ")}`,
  );
  step("enum-validation-valid-passes", enums.goodOk, `valid schedule accepted=${enums.goodOk}`);
  report.enums = enums;

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m0-shell.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m0-shell.png");

  // Round 11: the tray icon is a real asset, the new settings/delete channels
  // exist, and the app protocol honours byte ranges.
  const icon = path.join(__dirname, "..", "resources", "tray.png");
  step("tray-icon-present", fs.existsSync(icon), icon);

  const extra = await win.webContents.executeJavaScript(`(async () => {
    const s = await window.selfos.invoke("system.settings", undefined);
    const a = await window.selfos.invoke("system.autostart", undefined);
    const r = await window.selfos.invoke("system.rebuildAll", undefined);
    const d0 = await window.selfos.invoke("data.deleteRange", { module: "time" });
    const d1 = await window.selfos.invoke("data.deleteRange", { module: "time", confirm: true });
    const day = await window.selfos.invoke("dashboard.day", undefined);
    const res = await fetch("selfos-app://app/index.html", { headers: { Range: "bytes=0-9" } });
    const buf = await res.arrayBuffer();
    return {
      settingsOk: s.ok && typeof s.data.libraryDir === "string" && Array.isArray(s.data.excludedApps),
      autostartOk: a.ok && typeof a.data.enabled === "boolean",
      rebuildOk: r.ok && typeof r.data.rebuilt === "number",
      confirmRefused: !d0.ok,
      confirmAccepted: d1.ok && typeof d1.data.deleted === "number",
      watchNumber: day.ok && typeof day.data.watchSeconds === "number",
      rangeStatus: res.status,
      rangeBytes: buf.byteLength,
      rangeHeader: res.headers.get("content-range"),
    };
  })()`);
  step("settings-channel", extra.settingsOk);
  step("autostart-channel", extra.autostartOk);
  step("rebuild-all-channel", extra.rebuildOk);
  step("delete-needs-confirmation", extra.confirmRefused);
  step("delete-range-channel", extra.confirmAccepted);
  step("watch-seconds-present", extra.watchNumber);
  step(
    "protocol-range",
    extra.rangeStatus === 206 && extra.rangeBytes === 10 && /bytes 0-9\//.test(extra.rangeHeader ?? ""),
    `${extra.rangeStatus} ${extra.rangeBytes}B ${extra.rangeHeader}`,
  );
  report.extra = extra;

  const dbFile = path.join(app.getPath("userData"), "selfos.sqlite");
  step("db-created", fs.existsSync(dbFile), dbFile);

  finish();
});

