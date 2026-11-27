// M6 verification: goals end to end — all three kinds, pace projection,
// nesting roll-up, close/reopen, and the real UI.
// Run: just verify-goals
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M6-goals", "m6-goals.json", "M6");

require("../out/main/index.cjs");

function dayKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PREFIX = `M6-${Date.now().toString(36)}`;
const created = [];

app.whenReady().then(async () => {
  await sleep(2200);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);

  const mk = async (title, extra) => {
    const res = await call("goals.create", { title: `${PREFIX} ${title}`, startDate: dayKey(-30), ...extra });
    if (res.ok) created.push(res.data.id);
    return res;
  };

  // ── schema + creation ─────────────────────────────────────────────────
  const empty = await call("goals.list", { includeClosed: true });
  step("list-works", empty.ok, empty.ok ? `${empty.data.length} existing` : empty.error);

  const numeric = await mk("Read books", {
    kind: "numeric", targetValue: 12, unit: "books", targetDate: dayKey(60),
  });
  step("create-numeric", numeric.ok, numeric.ok ? `id ${numeric.data.id}` : numeric.error);
  const numericId = numeric.ok ? numeric.data.id : null;

  const milestone = await mk("Ship release", { kind: "milestone", targetDate: dayKey(30) });
  step("create-milestone", milestone.ok, milestone.ok ? `id ${milestone.data.id}` : milestone.error);
  const milestoneId = milestone.ok ? milestone.data.id : null;

  const quota = await mk("Qur'an khatm", { kind: "quota", targetValue: 30, unit: "juz", targetDate: dayKey(45) });
  step("create-quota", quota.ok);

  step("create-validates-title", (await call("goals.create", { title: "", kind: "numeric", startDate: dayKey() })).ok === false);
  step("create-validates-kind", (await call("goals.create", { title: "x", kind: "weekly", startDate: dayKey() })).ok === false);
  step("create-validates-dates",
    (await call("goals.create", {
      title: "x", kind: "numeric", startDate: dayKey(), targetDate: dayKey(-10),
    })).ok === false);

  // ── numeric progress + pace ──────────────────────────────────────────
  const rec1 = await call("goals.record", { goalId: numericId, value: 3, note: "January" });
  step("record-reading", rec1.ok, rec1.ok ? "3/12" : rec1.error);
  step("record-rejects-negative", (await call("goals.record", { goalId: numericId, value: -2 })).ok === false);

  const g1 = await call("goals.get", { goalId: numericId });
  step("value-read-back", g1.ok && g1.data.value === 3, `value=${g1.ok ? g1.data.value : "?"}`);
  step("pace-fraction", g1.ok && Math.abs(g1.data.pace.fraction - 0.25) < 0.001,
    `${g1.ok ? (g1.data.pace.fraction * 100).toFixed(1) : "?"}%`);
  step("pace-projects-date", g1.ok && typeof g1.data.pace.projectedDate === "string",
    g1.ok ? `projected ${g1.data.pace.projectedDate}` : "");
  // 3 books in 30 days = 0.1/day; 9 left = 90 days, deadline is 60 days out.
  step("pace-flags-at-risk", g1.ok && g1.data.pace.offPace === true,
    g1.ok ? `delta ${g1.data.pace.deltaDays}d` : "");
  step("contribution-recorded", g1.ok && g1.data.contributions[0]?.note === "January");

  // Reading past the deadline check: enough progress should clear the warning.
  await call("goals.record", { goalId: numericId, value: 9 });
  const g2 = await call("goals.get", { goalId: numericId });
  step("pace-clears-when-caught-up", g2.ok && g2.data.pace.offPace === false,
    g2.ok ? `projected ${g2.data.pace.projectedDate}` : "");

  const auto = await call("goals.record", { goalId: numericId, value: 12 });
  step("auto-complete-at-target", auto.ok);
  const g3 = await call("goals.get", { goalId: numericId });
  step("status-completed", g3.ok && g3.data.status === "completed", g3.ok ? g3.data.status : "");
  step("record-rejects-closed", (await call("goals.record", { goalId: numericId, value: 13 })).ok === false);

  const reopened = await call("goals.reopen", { goalId: numericId });
  step("reopen", reopened.ok && (await call("goals.get", { goalId: numericId })).data.status === "active");

  // ── milestones ───────────────────────────────────────────────────────
  const m1 = await call("goals.addMilestone", { goalId: milestoneId, title: "Design", dueDate: dayKey(-2) });
  const m2 = await call("goals.addMilestone", { goalId: milestoneId, title: "Build", dueDate: dayKey(10) });
  step("add-milestones", m1.ok && m2.ok, `${m1.ok ? m1.data.id : "?"}, ${m2.ok ? m2.data.id : "?"}`);

  const ms = await call("goals.get", { goalId: milestoneId });
  step("milestone-target-from-checklist", ms.ok && ms.data.target === 2, `target=${ms.ok ? ms.data.target : "?"}`);
  step("milestone-overdue-flag", ms.ok && ms.data.milestones.find((m) => m.id === m1.data.id)?.overdue === true);

  await call("goals.setMilestone", { milestoneId: m1.data.id, done: true });
  const ms2 = await call("goals.get", { goalId: milestoneId });
  step("milestone-progress", ms2.ok && ms2.data.value === 1 && Math.abs(ms2.data.pace.fraction - 0.5) < 0.001,
    `${ms2.ok ? ms2.data.value : "?"}/2`);

  await call("goals.setMilestone", { milestoneId: m2.data.id, done: true });
  step("all-milestones-completes", (await call("goals.get", { goalId: milestoneId })).data.status === "completed");
  await call("goals.setMilestone", { milestoneId: m2.data.id, done: false });
  step("untick-reopens", (await call("goals.get", { goalId: milestoneId })).data.status === "active");
  step("milestone-rejects-manual-value",
    (await call("goals.record", { goalId: milestoneId, value: 1 })).ok === false);

  // ── quota + nesting roll-up ──────────────────────────────────────────
  const parent = await mk("Year of Qur'an", { kind: "quota", targetValue: 1, targetDate: dayKey(300) });
  const parentId = parent.ok ? parent.data.id : null;
  const childA = await mk("First half", {
    kind: "quota", targetValue: 15, unit: "juz", startDate: dayKey(-20), targetDate: dayKey(40), parentId,
  });
  const childB = await mk("Second half", {
    kind: "quota", targetValue: 15, unit: "juz", startDate: dayKey(-20), targetDate: dayKey(90), parentId,
  });
  step("create-nested", childA.ok && childB.ok, childA.ok ? `parent ${parentId}` : childA.error);
  await call("goals.record", { goalId: childA.data.id, value: 15 });

  const pv = await call("goals.get", { goalId: parentId });
  step("rollup-counts-children", pv.ok && pv.data.childCount === 2, `children=${pv.ok ? pv.data.childCount : "?"}`);
  // A is at 100%, B at 0% -> mean 0.5. A completed, so this also proves a
  // finished child still counts.
  step("rollup-average", pv.ok && Math.abs(pv.data.rollup - 0.5) < 0.001,
    `rollup=${pv.ok ? pv.data.rollup : "?"}`);

  // ── close / abandon keeps history ────────────────────────────────────
  const close = await call("goals.close", { goalId: childB.data.id, status: "abandoned", reason: "replanned" });
  step("close-abandoned", close.ok);
  const cv = await call("goals.get", { goalId: childB.data.id });
  step("close-reason-kept", cv.ok && cv.data.closeReason === "replanned", cv.ok ? cv.data.closeReason : "");
  step("close-rejects-twice", (await call("goals.close", { goalId: childB.data.id, status: "completed" })).ok === false);
  const pv2 = await call("goals.get", { goalId: parentId });
  step("abandoned-child-excluded-from-rollup", pv2.ok && pv2.data.childCount === 1 && pv2.data.rollup === 1,
    `children=${pv2.ok ? pv2.data.childCount : "?"} rollup=${pv2.ok ? pv2.data.rollup : "?"}`);

  const active = await call("goals.list", { includeClosed: false });
  step("closed-hidden-from-active", active.ok && !active.data.some((g) => g.id === childB.data.id));
  const withClosed = await call("goals.list", { includeClosed: true });
  step("closed-listed-on-request", withClosed.ok && withClosed.data.some((g) => g.id === childB.data.id));

  step("update-title", (await call("goals.update", { goalId: numericId, patch: { title: `${PREFIX} Read 12 books` } })).ok);

  // ── the UI ───────────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Goals")?.click()
  `);
  await sleep(1200);

  const dom = await win.webContents.executeJavaScript(`({
    header: document.querySelector(".habits-head h2")?.textContent ?? null,
    cards: document.querySelectorAll(".goal-card").length,
    rings: document.querySelectorAll(".goal-ring").length,
    atRisk: document.querySelectorAll(".goal-card.at-risk").length,
    form: !!document.querySelector(".habit-form"),
    kindSelect: document.querySelectorAll(".habit-form select").length,
    closedToggle: !!document.querySelector(".habits-head .toggle input"),
    error: document.querySelector(".error")?.textContent ?? null,
    empty: document.querySelector(".goals .empty")?.textContent ?? null,
  })`);
  step("ui-goals-module", dom.header === "Goals", dom.header ?? "");
  step("ui-cards-rendered", dom.cards >= 3, `${dom.cards} cards`);
  step("ui-rings", dom.rings === dom.cards, `${dom.rings} rings for ${dom.cards} cards`);
  step("ui-new-goal-form", dom.form && dom.kindSelect >= 1);
  step("ui-closed-toggle", dom.closedToggle);
  step("ui-no-error", dom.error === null, dom.error ?? "");

  // Record a reading through the real form. `numericId` is still active (it was
  // reopened earlier) and its target is untouched, so a fresh reading of 5 is
  // unambiguous.
  const targetTitle = `${PREFIX} Read 12 books`;
  const preUi = await call("goals.get", { goalId: numericId });
  step("ui-precondition-active", preUi.ok && preUi.data.status === "active", preUi.ok ? preUi.data.status : "");
  const filled = await win.webContents.executeJavaScript(`
    (() => {
      const cards = [...document.querySelectorAll(".goal-card")];
      const card = cards.find(c => c.querySelector("h3")?.textContent === ${JSON.stringify(targetTitle)});
      if (!card) return { ok: false, reason: "card not found" };
      const input = card.querySelector('.goal-record input[type="number"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, "5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    })()
  `);
  step("ui-reading-input", filled.ok, filled.reason ?? "");
  await sleep(300);
  const clicked = await win.webContents.executeJavaScript(`
    (() => {
      const cards = [...document.querySelectorAll(".goal-card")];
      const card = cards.find(c => c.querySelector("h3")?.textContent === ${JSON.stringify(targetTitle)});
      const btn = [...card.querySelectorAll("button")].find(b => b.textContent === "Update");
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  await sleep(1200);
  const afterUi = await call("goals.get", { goalId: numericId });
  step("ui-update-writes", clicked && afterUi.ok && afterUi.data.value === 5,
    `value=${afterUi.ok ? afterUi.data.value : "?"}`);

  // Tick an unchecked milestone in the UI. The first checkbox is already ticked
  // by an earlier step, so target the unchecked one; clicking it must raise the
  // goal's value by exactly one.
  const beforeTick = await call("goals.get", { goalId: milestoneId });
  const ticked = await win.webContents.executeJavaScript(`
    (() => {
      const box = [...document.querySelectorAll('.goal-card .goal-milestones input[type="checkbox"]')]
        .find(b => !b.checked);
      if (!box) return false;
      box.click();
      return true;
    })()
  `);
  await sleep(1200);
  const afterTick = await call("goals.get", { goalId: milestoneId });
  const expected = (beforeTick.ok ? beforeTick.data.value : 0) + 1;
  step("ui-milestone-tick", ticked && afterTick.ok && afterTick.data.value === expected,
    `value ${beforeTick.ok ? beforeTick.data.value : "?"} -> ${afterTick.ok ? afterTick.data.value : "?"}`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m6-goals.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m6-goals.png");

  // Clean up only the goals this run created.
  for (const id of created) {
    await call("goals.close", { goalId: id, status: "abandoned", reason: "verifier cleanup" });
  }

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m6-goals.json"), JSON.stringify(report, null, 2));
  console.log("M6_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

