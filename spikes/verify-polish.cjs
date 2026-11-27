// M7 verification: analytics, backups, exports, command palette, accessibility.
// Run: just verify-polish
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M7-polish", "m7-polish.json", "M7");

require("../out/main/index.cjs");

function dayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

app.whenReady().then(async () => {
  await sleep(2600);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);
  const press = (key, mods = {}) =>
    win.webContents.executeJavaScript(`
      window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ key, bubbles: true, ...mods })}))
    `);

  // ── analytics ─────────────────────────────────────────────────────────
  const range = await call("analytics.range", { days: 30 });
  step("analytics-range", range.ok && range.data.days.length === 30, range.ok ? `${range.data.days.length} days` : range.error);
  step("analytics-totals", range.ok && typeof range.data.totals.screenSeconds === "number",
    range.ok ? `${range.data.totals.screenSeconds}s total` : "");
  step("analytics-streaks", range.ok && Number.isInteger(range.data.longestStreak), `longest ${range.data?.longestStreak}d`);
  step("analytics-clamps-range", (await call("analytics.range", { days: 10_000 })).ok);

  const hourly = await call("analytics.hourly", {});
  step("analytics-hourly", hourly.ok && hourly.data.length === 24, hourly.ok ? `${hourly.data.length} buckets` : hourly.error);
  step("hourly-covers-the-day", hourly.ok && hourly.data[0].hour === 0 && hourly.data[23].hour === 23);

  const domains = await call("analytics.domains", { days: 30 });
  step("analytics-domains", domains.ok && Array.isArray(domains.data), domains.ok ? `${domains.data.length} domains` : domains.error);

  // ── backups ───────────────────────────────────────────────────────────
  const before = await call("backup.status", undefined);
  step("backup-status", before.ok, before.ok ? `${before.data.files.length} existing` : before.error);
  // The app takes today's backup at startup, deferred behind first paint so a
  // VACUUM INTO cannot block the window. Poll for it rather than assuming it
  // has already happened.
  let daily = before.ok && before.data.files.some((f) => f.kind === "daily");
  for (let i = 0; i < 20 && !daily; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const again = await call("backup.status", undefined);
    daily = again.ok && again.data.files.some((f) => f.kind === "daily");
  }
  step("startup-backup-ran", daily, "daily backup present after the deferred startup run");

  const made = await call("backup.create", { kind: "manual" });
  step("manual-backup", made.ok && made.data.bytes > 0, made.ok ? `${made.data.name} (${made.data.bytes} bytes)` : made.error);
  step("backup-file-on-disk", made.ok && fs.existsSync(made.data.path));

  const after = await call("backup.status", undefined);
  step("backup-listed", after.ok && after.data.files.some((f) => f.name === made.data.name));
  step("backup-records-time", after.ok && typeof after.data.lastBackupAt === "number");

  step("restore-rejects-unknown", (await call("backup.restore", { name: "../../etc/passwd" })).ok === false);
  step("restore-rejects-path", (await call("backup.restore", { name: "/etc/passwd" })).ok === false);

  // ── exports ───────────────────────────────────────────────────────────
  const tables = await call("data.tables", undefined);
  step("tables-listed", tables.ok && tables.data.length > 5, tables.ok ? `${tables.data.length} tables` : tables.error);

  const json = await call("data.exportJson", undefined);
  step("export-json", json.ok && json.data.bytes > 100, json.ok ? `${json.data.path} (${json.data.bytes})` : json.error);
  step("export-json-file", json.ok && fs.existsSync(json.data.path));
  const parsed = json.ok ? JSON.parse(fs.readFileSync(json.data.path, "utf8")) : null;
  step("export-json-valid", parsed !== null && typeof parsed.tables === "object", parsed ? Object.keys(parsed.tables).length + " tables" : "");

  const csv = await call("data.exportCsv", { table: "day_aggregate" });
  step("export-csv", csv.ok && fs.existsSync(csv.data.path), csv.ok ? csv.data.path : csv.error);
  const csvText = csv.ok ? fs.readFileSync(csv.data.path, "utf8") : "";
  step("export-csv-header", csvText.startsWith("local_date,"), csvText.split("\n")[0]?.slice(0, 60) ?? "");
  step("export-csv-rejects-unknown", (await call("data.exportCsv", { table: "nope" })).ok === false);

  // Exports land under userData/exports, never at a caller-chosen path.
  step("export-path-confined", csv.ok && csv.data.path.includes("/exports/"), csv.ok ? csv.data.path : "");

  // ── command palette ───────────────────────────────────────────────────
  await press("k", { ctrlKey: true });
  await sleep(500);
  const palette = await win.webContents.executeJavaScript(`({
    open: !!document.querySelector(".palette"),
    focused: document.activeElement?.className ?? "",
    items: document.querySelectorAll(".palette-item").length,
    hasModules: [...document.querySelectorAll(".palette-item")].some(b => b.textContent.includes("Goals")),
  })`);
  step("palette-opens-ctrl-k", palette.open, palette.open ? "" : "not rendered");
  step("palette-focuses-input", palette.focused === "palette-input", palette.focused);
  step("palette-lists-commands", palette.items >= 9 && palette.hasModules, `${palette.items} commands`);

  // Filter, then run the top result with Enter.
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector(".palette-input");
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, "analyt");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await sleep(400);
  const filtered = await win.webContents.executeJavaScript(`document.querySelectorAll(".palette-item").length`);
  step("palette-filters", filtered === 1, `${filtered} result(s) for "analyt"`);

  await win.webContents.executeJavaScript(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  `);
  await sleep(900);
  const navigated = await win.webContents.executeJavaScript(`({
    palette: !!document.querySelector(".palette"),
    header: document.querySelector(".topbar h1")?.textContent ?? "",
    chart: document.querySelectorAll(".chart-col").length,
  })`);
  step("palette-enter-runs", !navigated.palette && navigated.header === "Analytics", navigated.header);
  step("palette-navigated-ui", navigated.chart === 30, `${navigated.chart} columns`);

  // Escape closes without running anything.
  await press("k", { ctrlKey: true });
  await sleep(300);
  await win.webContents.executeJavaScript(`
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  `);
  await sleep(300);
  step("palette-escape-closes", !(await win.webContents.executeJavaScript(`!!document.querySelector(".palette")`)));

  // ── Escape over the reader (regression) ───────────────────────────────
  // The palette and the reader both listen for Escape on `window`. The reader
  // registers first, so a bubble-phase palette handler could not stop it, and
  // dismissing the palette also closed the book. The palette now listens in the
  // capture phase; this asserts the book survives.
  await call("reading.import", { path: path.join(__dirname, "fixtures", "sample-40p.pdf") });
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Reading")?.click()
  `);
  // Wait for the card, then retry the click once: the first click is a no-op if
  // the library grid has not mounted yet (same harness race verify-reading has).
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt++) {
    await win.webContents.executeJavaScript(`document.querySelector(".book-card")?.click()`);
    for (let i = 0; i < 20 && !opened; i++) {
      await sleep(250);
      opened = await win.webContents.executeJavaScript(`!!document.querySelector(".reader")`);
    }
  }
  if (opened) {
    await press("k", { ctrlKey: true });
    await sleep(400);
    await win.webContents.executeJavaScript(`
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    `);
    await sleep(500);
    const afterEscape = await win.webContents.executeJavaScript(`({
      palette: !!document.querySelector(".palette"),
      reader: !!document.querySelector(".reader"),
    })`);
    step("palette-escape-keeps-reader", !afterEscape.palette && afterEscape.reader,
      `palette=${afterEscape.palette} reader=${afterEscape.reader}`);
    // Leave the reader for the remaining steps.
    await win.webContents.executeJavaScript(`
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    `);
    await sleep(400);
  } else {
    step("palette-escape-keeps-reader", false, "reader did not open");
  }

  // ── accessibility pass ────────────────────────────────────────────────
  const a11y = await win.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    const noType = buttons.filter(b => !b.getAttribute("type")).length;
    const nav = [...document.querySelectorAll(".nav-item")];
    const current = nav.filter(b => b.getAttribute("aria-current") === "page").length;
    const imgs = [...document.querySelectorAll("img")].filter(i => !i.getAttribute("alt")).length;
    const iconOnly = buttons.filter(b => !b.textContent.trim() && !b.getAttribute("aria-label")).length;
    const headings = [...document.querySelectorAll("h1, h2, h3")].map(h => h.tagName);
    return { noType, current, imgs, iconOnly, headings, focusable: buttons.length };
  })()`);
  step("a11y-button-types", a11y.noType === 0, `${a11y.noType} buttons without type`);
  step("a11y-current-page", a11y.current === 1, `${a11y.current} aria-current`);
  step("a11y-images-labelled", a11y.imgs === 0);
  step("a11y-icon-buttons-labelled", a11y.iconOnly === 0, `${a11y.iconOnly} unlabelled icon buttons`);
  step("a11y-headings", a11y.headings.length >= 2, a11y.headings.join(" "));

  // Keyboard reachability: every nav item must be a real, tabbable button.
  const tabbable = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].every(b => b.tabIndex >= 0 && b.tagName === "BUTTON")
  `);
  step("a11y-nav-tabbable", tabbable);

  // ── data page in the UI ───────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Data")?.click()
  `);
  await sleep(900);
  const dataDom = await win.webContents.executeJavaScript(`({
    header: document.querySelector(".topbar h1")?.textContent ?? "",
    sub: document.querySelector(".data-view .page-sub")?.textContent ?? "",
    rows: document.querySelectorAll(".data-view tbody tr").length,
    backupButton: [...document.querySelectorAll("button")].some(b => b.textContent === "Back up now"),
    error: document.querySelector(".error")?.textContent ?? null,
  })`);
  step("ui-data-page", dataDom.header === "Data", dataDom.header);
  step("ui-data-subtitle", dataDom.sub.includes("backups"), dataDom.sub);
  step("ui-data-tables", dataDom.rows > 5, `${dataDom.rows} rows`);
  step("ui-data-backup-button", dataDom.backupButton);
  step("ui-data-no-error", dataDom.error === null, dataDom.error ?? "");

  // Back up from the real button.
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll("button")].find(b => b.textContent === "Back up now")?.click()
  `);
  await sleep(1600);
  const toast = await win.webContents.executeJavaScript(`document.querySelector(".toast")?.textContent ?? ""`);
  step("ui-backup-click", toast.includes("Backup created"), toast);

  // ── analytics page in the UI ──────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Analytics")?.click()
  `);
  await sleep(1100);
  const chartDom = await win.webContents.executeJavaScript(`({
    cols: document.querySelectorAll(".chart-col").length,
    ranges: document.querySelectorAll(".range-btn").length,
    table: !!document.querySelector(".chart-table"),
    hourly: document.querySelectorAll(".hourly-col").length,
    domainRows: document.querySelectorAll(".domain-row").length,
    emptyBars: document.querySelectorAll(".chart-col.empty").length,
    error: document.querySelector(".error")?.textContent ?? null,
  })`);
  step("ui-chart-columns", chartDom.cols === 30, `${chartDom.cols} columns`);
  step("ui-range-buttons", chartDom.ranges === 3, `${chartDom.ranges} ranges`);
  step("ui-data-table", chartDom.table);
  step("ui-hourly", chartDom.hourly === 24, `${chartDom.hourly} hours`);
  // A querySelectorAll length is never negative, so `>= 0` passed with zero
  // rows — the very case the step name implies it checks. Assert non-empty.
  step("ui-domains", chartDom.domainRows > 0, `${chartDom.domainRows} domains`);
  step("ui-no-error", chartDom.error === null, chartDom.error ?? "");

  // The range picker must re-query, not just restyle.
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".range-btn")].find(b => b.textContent === "7d")?.click()
  `);
  await sleep(1100);
  const afterRange = await win.webContents.executeJavaScript(`document.querySelectorAll(".chart-col").length`);
  step("ui-range-switch", afterRange === 7, `${afterRange} columns after 7d`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m7-analytics.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m7-analytics.png");

  // Clean up this run's manual backup and exports so re-runs stay tidy.
  if (made.ok) fs.rmSync(made.data.path, { force: true });
  for (const f of [json, csv]) if (f.ok) fs.rmSync(f.data.path, { force: true });

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m7-polish.json"), JSON.stringify(report, null, 2));
  console.log("M7_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

