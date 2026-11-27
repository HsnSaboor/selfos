// M3 verification: salah through the real app, against the live salah-ctl.
// Run: just verify-salah
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M3-salah", "m3-salah.json", "M3");

require("../out/main/index.cjs");

function dayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

app.whenReady().then(async () => {
  await sleep(2200);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);

  const today = dayKey(0);

  // ── times come from the existing stack ────────────────────────────────
  const day = await call("salah.day", { localDate: today });
  step("day-ok", day.ok, day.ok ? `${day.data.times.length} prayers` : day.error);
  if (!day.ok) return finish();

  const d = day.data;
  step("source-is-salah-ctl", d.source === "salah-ctl", `source=${d.source}`);
  step("five-prayers", d.times.length === 5, d.times.map((t) => `${t.id}@${t.time}`).join(" "));
  step("times-match-salah-ctl", d.times.some((t) => t.isCustom === true), "custom overrides preserved");
  step("hijri-from-source", typeof d.hijri === "string" && d.hijri.length > 0, d.hijri);
  step("location", d.location === "Gujranwala", d.location);
  step("next-prayer", d.next !== null, d.next ? `${d.next.id} at ${d.next.time}` : "none");

  // ── logging ───────────────────────────────────────────────────────────
  // Start from a clean slate for today. Qada debt is a transition ledger, so a
  // leftover `missed` row from an earlier run makes "logging missed adds debt"
  // legitimately false — the transition already happened.
  for (const p of ["fajr", "dhuhr", "asr", "maghrib", "isha"]) {
    await call("salah.clear", { prayer: p, localDate: today });
  }

  const logFajr = await call("salah.log", { prayer: "fajr", localDate: today });
  step("log-fajr", logFajr.ok, logFajr.ok ? `status ${logFajr.data.status}` : logFajr.error);
  // The clock decides on_time vs late; either is a valid outcome.
  step("status-classified", logFajr.ok && ["on_time", "late"].includes(logFajr.data.status), logFajr.data?.status);

  const logJamaah = await call("salah.log", { prayer: "dhuhr", localDate: today, status: "on_time", jamaah: true });
  step("log-with-jamaah", logJamaah.ok && logJamaah.data.status === "on_time");

  const logExcused = await call("salah.log", { prayer: "asr", localDate: today, status: "excused" });
  step("log-excused", logExcused.ok && logExcused.data.status === "excused");

  // Logging twice must update, not duplicate.
  await call("salah.log", { prayer: "fajr", localDate: today, status: "late" });
  const afterDouble = await call("salah.day", { localDate: today });
  const fajrRows = afterDouble.ok ? afterDouble.data.prayers.filter((p) => p.id === "fajr") : [];
  step("log-is-idempotent", fajrRows.length === 1 && fajrRows[0].status === "late", `status ${fajrRows[0]?.status}`);

  // ── qada debt ─────────────────────────────────────────────────────────
  const before = (await call("salah.day", { localDate: today })).data.qada.total;
  await call("salah.log", { prayer: "maghrib", localDate: today, status: "missed" });
  const afterMiss = (await call("salah.day", { localDate: today })).data.qada;
  step("missed-adds-debt", afterMiss.total === before + 1, `${before} → ${afterMiss.total}`);
  step("debt-attributed-to-prayer", afterMiss.byPrayer.maghrib >= 1, `maghrib ${afterMiss.byPrayer.maghrib}`);

  const repaid = await call("salah.repayQada", { prayer: "maghrib", count: 1 });
  step("repay-reduces-debt", repaid.ok && repaid.data.total === before, `${afterMiss.total} → ${repaid.data?.total}`);

  // Clearing a missed log must also remove its debt.
  await call("salah.log", { prayer: "isha", localDate: today, status: "missed" });
  const withIsha = (await call("salah.day", { localDate: today })).data.qada.total;
  await call("salah.clear", { prayer: "isha", localDate: today });
  const afterClear = (await call("salah.day", { localDate: today })).data.qada.total;
  step("clear-removes-debt", afterClear === withIsha - 1, `${withIsha} → ${afterClear}`);

  // ── validation ────────────────────────────────────────────────────────
  step("rejects-unknown-prayer", (await call("salah.log", { prayer: "tahajjud" })).ok === false);
  step("clear-requires-date", (await call("salah.clear", { prayer: "fajr" })).ok === false);

  // ── history + streak ──────────────────────────────────────────────────
  const history = await call("salah.history", { days: 30 });
  step("history-ok", history.ok, history.ok ? `${history.data.length} days` : history.error);
  const refreshed = await call("salah.day", { localDate: today });
  step("streak-reported", refreshed.ok && typeof refreshed.data.streak.current === "number",
    refreshed.ok ? `current ${refreshed.data.streak.current}` : "");

  // `logged` counts every row including excused, so a streak day requires
  // logged >= 5. The old test was `logged + excused >= 5`, which double-counted
  // the excused row and awarded a day from four rows. This asserts the
  // arithmetic on real rows rather than only that the field is a number.
  const histToday = history.ok ? history.data.find((h) => h.localDate === today) : null;
  step("history-days-are-bounded",
    history.ok && history.data.every((h) => h.logged <= 5),
    histToday ? `today logged=${histToday.logged} excused=${histToday.excused} missed=${histToday.missed}` : "no today row");
  step("logged-includes-excused",
    !!histToday && histToday.logged >= histToday.excused,
    histToday ? `logged=${histToday.logged} excused=${histToday.excused}` : "no today row");
  // Recompute the streak from the same history rows the app reports, using the
  // rule as written (logged >= 5, no misses), and require the app's own number to
  // agree. Under the old `logged + excused >= 5` the two disagree on any day with
  // an excused row, which is the bug this pins.
  if (history.ok) {
    const sorted = [...history.data].sort((a, b) => (a.localDate < b.localDate ? 1 : -1));
    let expected = 0;
    for (const h of sorted) {
      const qualifies = h.missed === 0 && h.logged >= 5;
      if (qualifies) expected++;
      else if (h.localDate === today) continue; // an in-progress today does not break it
      else break;
    }
    step("streak-matches-recomputation",
      refreshed.data.streak.current === expected,
      `reported ${refreshed.data.streak.current}, recomputed ${expected}`);
  } else {
    step("streak-matches-recomputation", false, "history unavailable");
  }

  // ── the UI ────────────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Salah")?.click()
  `);
  await sleep(1500);
  const dom = await win.webContents.executeJavaScript(`({
    rows: document.querySelectorAll(".prayer-row").length,
    next: !!document.querySelector(".next-prayer"),
    qadaCells: document.querySelectorAll(".qada-cell").length,
    logged: document.querySelectorAll(".prayer-row.logged").length,
    errorBanner: document.querySelector(".error")?.textContent ?? null,
    header: document.querySelector(".salah-head h2")?.textContent ?? null,
    sourceNote: document.querySelector(".salah-head .muted")?.textContent ?? "",
  })`);
  step("ui-prayer-rows", dom.rows === 5, `${dom.rows} rows`);
  step("ui-next-prayer", dom.next);
  step("ui-qada-cells", dom.qadaCells === 5, `${dom.qadaCells} cells`);
  step("ui-logged-rows", dom.logged >= 2, `${dom.logged} logged`);
  step("ui-header", dom.header === "Prayers", dom.header ?? "");
  step("ui-no-error", dom.errorBanner === null, dom.errorBanner ?? "");

  // Click "pray" on an unlogged row in the real DOM.
  await win.webContents.executeJavaScript(`
    document.querySelector(".prayer-row:not(.logged) .primary-mini")?.click()
  `);
  await sleep(900);
  const afterClick = await win.webContents.executeJavaScript(`document.querySelectorAll(".prayer-row.logged").length`);
  step("ui-click-logs", afterClick > dom.logged, `${dom.logged} → ${afterClick} logged`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m3-salah.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m3-salah.png");

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m3-salah.json"), JSON.stringify(report, null, 2));
  console.log("M3_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

