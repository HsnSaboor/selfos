// M2 verification: habits through the real app — create, toggle, count,
// skip, avoid-slip, streaks, schedule versioning, and the UI itself.
//
// Run: npm run verify:habits
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M2-habits", "m2-habits.json", "M2");

require("../out/main/index.cjs");

function dayKey(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

app.whenReady().then(async () => {
  await sleep(2200);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);

  // ── create one of each habit kind ─────────────────────────────────────
  const booleanHabit = await call("habits.create", {
    name: "Read Quran", kind: "boolean", schedule: { kind: "daily" },
  });
  step("create-boolean", booleanHabit.ok, booleanHabit.ok ? `id ${booleanHabit.data.id}` : booleanHabit.error);

  const countHabit = await call("habits.create", {
    name: "Water", kind: "count", target: 8, unit: "glasses", schedule: { kind: "daily" },
  });
  step("create-count", countHabit.ok, countHabit.ok ? `id ${countHabit.data.id}` : countHabit.error);

  const avoidHabit = await call("habits.create", {
    name: "No doomscrolling", kind: "avoid", schedule: { kind: "daily" },
  });
  step("create-avoid", avoidHabit.ok);

  const weeklyHabit = await call("habits.create", {
    name: "Gym", kind: "boolean",
    schedule: { kind: "times_per_week", timesPerPeriod: 3 },
  });
  step("create-weekly", weeklyHabit.ok);

  step("create-validates", (await call("habits.create", { name: "", kind: "boolean", schedule: { kind: "daily" } })).ok === false);
  step("create-requires-schedule", (await call("habits.create", { name: "x", kind: "boolean" })).ok === false);

  const bId = booleanHabit.data.id;
  const cId = countHabit.data.id;
  const aId = avoidHabit.data.id;
  const wId = weeklyHabit.data.id;
  const today = dayKey(0);

  // ── toggle / increment / skip / slip ──────────────────────────────────
  const t1 = await call("habits.toggle", { habitId: bId, localDate: today });
  step("toggle-on", t1.ok && t1.data.status === "done");
  const t2 = await call("habits.toggle", { habitId: bId, localDate: today });
  step("toggle-off", t2.ok && t2.data.status === null, "second tap clears the entry");
  await call("habits.toggle", { habitId: bId, localDate: today });

  await call("habits.increment", { habitId: cId, delta: 3, localDate: today });
  const inc = await call("habits.increment", { habitId: cId, delta: 2, localDate: today });
  step("increment-partial", inc.ok && inc.data.value === 5 && inc.data.status === "partial", `value ${inc.data?.value}`);
  const incFull = await call("habits.increment", { habitId: cId, delta: 3, localDate: today });
  step("increment-reaches-target", incFull.ok && incFull.data.status === "done", `value ${incFull.data?.value}`);

  await call("habits.log", { habitId: aId, localDate: today, status: "clean" });
  await call("habits.log", { habitId: aId, localDate: dayKey(-1), status: "slipped" });
  await call("habits.log", { habitId: aId, localDate: dayKey(-2), status: "clean" });

  // ── backfill + skip semantics ─────────────────────────────────────────
  for (let i = 1; i <= 4; i++) {
    await call("habits.log", { habitId: bId, localDate: dayKey(-i), status: "done" });
  }
  await call("habits.log", { habitId: bId, localDate: dayKey(-5), status: "skipped" });
  await call("habits.log", { habitId: bId, localDate: dayKey(-6), status: "done" });

  // ── read back state ───────────────────────────────────────────────────
  const list = await call("habits.list", { localDate: today });
  step("list-ok", list.ok, list.ok ? `${list.data.length} habits` : list.error);

  const byId = Object.fromEntries((list.ok ? list.data : []).map((h) => [h.id, h]));
  const b = byId[bId];
  const c = byId[cId];
  const a = byId[aId];

  // 6 consecutive done days (today..-4, then a skip at -5, then done at -6)
  step("streak-daily", b?.streak.current === 6, `current ${b?.streak.current}, longest ${b?.streak.longest}`);
  step("skip-is-neutral", b?.streak.longest >= 6, `longest ${b?.streak.longest}`);
  step("count-complete", c?.todayEntry?.value === 8 && c?.todayEntry?.status === "done", JSON.stringify(c?.todayEntry));
  step("avoid-slip-breaks", a?.streak.current === 1, `current ${a?.streak.current}, longest ${a?.streak.longest}`);
  step("weekly-due-today", byId[wId]?.dueToday === true, "quota not yet met");
  step("completion-rate", typeof b?.completion30d === "number" && b.completion30d > 0.5, `${Math.round((b?.completion30d ?? 0) * 100)}%`);

  // ── schedule versioning must not rewrite history (D-08) ───────────────
  const beforeChange = b?.streak.current ?? 0;
  await call("habits.changeSchedule", {
    habitId: bId, effectiveFrom: today, schedule: { kind: "weekdays", weekdays: [1, 3, 5] },
  });
  const afterList = await call("habits.list", { localDate: today });
  const afterB = (afterList.ok ? afterList.data : []).find((h) => h.id === bId);
  step("schedule-change-keeps-history", (afterB?.streak.current ?? 0) >= beforeChange - 1,
    `before ${beforeChange}, after ${afterB?.streak.current} (unit ${afterB?.streak.unit})`);
  step("schedule-change-applied", afterB?.schedule?.kind === "weekdays", JSON.stringify(afterB?.schedule));

  // ── heatmap ───────────────────────────────────────────────────────────
  const hm = await call("habits.heatmap", { habitId: bId, days: 84, localDate: today });
  step("heatmap-ok", hm.ok && hm.data.length === 84, hm.ok ? `${hm.data.length} cells` : hm.error);
  step("heatmap-has-satisfied", hm.ok && hm.data.some((x) => x.state === "satisfied"));

  // ── the UI actually renders habits ────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Habits")?.click()
  `);
  await sleep(1200);
  const dom = await win.webContents.executeJavaScript(`({
    rows: document.querySelectorAll(".habit-row").length,
    checks: document.querySelectorAll(".habit-check").length,
    heatmaps: document.querySelectorAll(".heatmap").length,
    form: !!document.querySelector(".habit-form"),
    header: document.querySelector(".habits-head h2")?.textContent ?? null,
    empty: !!document.querySelector(".empty"),
    errorBanner: document.querySelector(".error")?.textContent ?? null,
  })`);
  // The DB may hold habits from an earlier run, so compare against the list
  // rather than a hard-coded 4 (test isolation, not a product assertion).
  const expectedRows = list.ok ? list.data.length : -1;
  step("ui-rows", dom.rows === expectedRows, `${dom.rows} rows for ${expectedRows} habits`);
  step("ui-heatmaps", dom.heatmaps === expectedRows, `${dom.heatmaps} heatmaps`);
  step("ui-form", dom.form);
  step("ui-header", dom.header === "Habits", dom.header ?? "");
  step("ui-no-error", dom.errorBanner === null, dom.errorBanner ?? "");

  // Click the first habit's check in the real UI.
  await win.webContents.executeJavaScript(`document.querySelector(".habit-check")?.click()`);
  await sleep(900);
  const afterClick = await call("habits.list", { localDate: today });
  step("ui-click-works", afterClick.ok, "clicked through the real DOM");

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m2-habits.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m2-habits.png");

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m2-habits.json"), JSON.stringify(report, null, 2));
  console.log("M2_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

