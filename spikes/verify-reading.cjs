// M4 verification: import a real PDF, render it, highlight, annotate, restart.
// Run: just verify-reading
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M4-reading", "m4-reading.json", "M4");

/** Poll the renderer until `expr` is truthy, or give up after `timeout` ms. */
async function waitFor(win, expr, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const ok = await win.webContents.executeJavaScript(`Boolean(${expr})`).catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

require("../out/main/index.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "sample-40p.pdf");

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);

  // ── library import ────────────────────────────────────────────────────
  const imp = await call("reading.import", { path: FIXTURE });
  step("import-pdf", imp.ok, imp.ok ? `id ${imp.data.id}` : imp.error);
  const bookId = imp.ok ? imp.data.id : null;

  const dup = await call("reading.import", { path: FIXTURE });
  step("import-dedupes", dup.ok && dup.data.created === false, "same content hash");

  step("import-rejects-missing", (await call("reading.import", { path: "/nope/none.pdf" })).ok === false);

  const list = await call("reading.list", undefined);
  step("library-lists", list.ok && list.data.length >= 1, list.ok ? `${list.data.length} books` : list.error);
  const book = list.ok ? list.data.find((b) => b.id === bookId) : null;
  step("library-metadata", Boolean(book), book ? `${book.title} · ${book.pageCount} pages` : "");

  // ── open in the real UI ───────────────────────────────────────────────
  // Earlier runs leave a saved position, so reset it. Without this the reader
  // opens mid-book and every "next page" assertion is off by that offset.
  await call("reading.savePosition", { bookId, page: 1, scrollOffset: 0, zoom: 1 });
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Reading")?.click()
  `);
  // The library grid comes from an IPC round-trip, so wait for a card rather
  // than sleeping and hoping the click has a target.
  await waitFor(win, 'document.querySelectorAll(".book-card").length > 0', 8000);

  // Ready = the text layer populated, which is the last thing the render effect
  // does. Retry the open once: if the card was not yet mounted the first click
  // is a no-op, and that is a harness race, not a product failure.
  let readyOk = false;
  for (let attempt = 0; attempt < 2 && !readyOk; attempt++) {
    await win.webContents.executeJavaScript(`document.querySelector(".book-card")?.click()`);
    readyOk = await waitFor(win, 'document.querySelectorAll(".text-layer span").length > 0', 15000);
  }
  step("reader-ready", readyOk, "text layer populated");

  const reader = await win.webContents.executeJavaScript(`({
    canvas: !!document.querySelector(".reader-page canvas"),
    canvasW: document.querySelector(".reader-page canvas")?.width ?? 0,
    canvasH: document.querySelector(".reader-page canvas")?.height ?? 0,
    toolbar: !!document.querySelector(".reader-toolbar"),
    pageIndicator: document.querySelector(".page-indicator")?.textContent ?? "",
    annotations: !!document.querySelector(".annotations"),
    error: document.querySelector(".error")?.textContent ?? null,
    textSpans: document.querySelectorAll(".reader-canvas-wrap span[data-text]").length,
  })`);
  step("reader-renders-canvas", reader.canvas && reader.canvasW > 100, `${reader.canvasW}×${reader.canvasH}`);
  step("reader-toolbar", reader.toolbar);
  step("reader-text-layer", reader.textSpans > 0, `${reader.textSpans} text spans`);
  step("reader-page-indicator", reader.pageIndicator.includes("/"), reader.pageIndicator);
  step("reader-no-error", reader.error === null, reader.error ?? "");

  // ── page count discovered from the PDF ────────────────────────────────
  const afterRender = await call("reading.list", undefined);
  const updated = afterRender.ok ? afterRender.data.find((b) => b.id === bookId) : null;
  step("page-count-discovered", updated?.pageCount === 40, `pageCount=${updated?.pageCount}`);

  // ── navigation + position persistence ─────────────────────────────────
  await win.webContents.executeJavaScript(`
    document.querySelectorAll(".reader-nav .mini")[1]?.click()
  `);
  await waitFor(win, 'document.querySelector(".page-indicator")?.textContent?.trim().startsWith("2")');
  const afterNav = await win.webContents.executeJavaScript(`document.querySelector(".page-indicator")?.textContent ?? ""`);
  step("page-navigation", afterNav.trim().startsWith("2"), afterNav.trim());

  const pos = await call("reading.list", undefined);
  const posBook = pos.ok ? pos.data.find((b) => b.id === bookId) : null;
  step("position-saved", (posBook?.page ?? 0) === 2, `saved page ${posBook?.page}`);

  // ── highlights ────────────────────────────────────────────────────────
  // The reader is on page 2 after the navigation step; the highlight must land
  // on the page being displayed for the overlay assertion to mean anything.
  const currentPage = Number(
    (await win.webContents.executeJavaScript(`document.querySelector(".page-indicator")?.textContent ?? ""`))
      .split("/")[0]
      .trim(),
  );
  step("reader-on-expected-page", currentPage === 2, `page ${currentPage}`);

  const add = await call("reading.addHighlight", {
    bookId,
    page: currentPage,
    color: "yellow",
    text: "unique-marker-2-abc",
    anchor: {
      page: currentPage,
      rects: [{ x: 0.1, y: 0.7, w: 0.4, h: 0.02 }],
      text: "unique-marker-2-abc",
      rotation: 0,
      anchorVersion: 1,
    },
  });
  step("add-highlight", add.ok, add.ok ? `id ${add.data.id}` : add.error);
  const hId = add.ok ? add.data.id : null;

  /**
   * A malformed anchor must be refused at the boundary, not stored.
   *
   * The anchor is persisted as JSON and re-read on every open, where the reader
   * calls `resolveAnchor` — which runs `anchor.rects.every(...)` and
   * `normalizeText(anchor.text)`. A string `rects` throws `TypeError` and a
   * missing `text` throws inside `findByText`. Before the guard existed there
   * was no error boundary either, so the whole renderer unmounted and re-crashed
   * on every open of the book, with the delete control inside the panel that
   * could no longer render. Both shapes were verified as accepted and persisted.
   * The renderer now has boundaries (module + root) and the read path normalises
   * a bad anchor, so the guard is the first of three defences rather than the
   * only one — it still matters because it is the one that prevents the write.
   */
  const badAnchors = [
    { label: "rects-as-string", anchor: { page: 1, rects: "nope", text: "hi", rotation: 0, anchorVersion: 1 } },
    { label: "text-missing", anchor: { page: 1, rects: [], rotation: 0, anchorVersion: 1 } },
    { label: "rect-not-object", anchor: { page: 1, rects: [1], text: "hi", rotation: 0, anchorVersion: 1 } },
    { label: "rotation-missing", anchor: { page: 1, rects: [], text: "hi", anchorVersion: 1 } },
  ];
  const acceptedAnchors = [];
  for (const b of badAnchors) {
    const r = await call("reading.addHighlight", {
      bookId,
      page: 1,
      color: "yellow",
      text: "probe",
      anchor: b.anchor,
    });
    if (r.ok) acceptedAnchors.push(b.label);
  }
  step(
    "anchor-validation",
    acceptedAnchors.length === 0,
    acceptedAnchors.length === 0
      ? `${badAnchors.length} malformed anchors refused`
      : `accepted: ${acceptedAnchors.join(", ")}`,
  );

  await call("reading.updateNote", { highlightId: hId, body: "A note about this passage." });
  const hs = await call("reading.highlights", { bookId });
  const h = hs.ok ? hs.data.find((x) => x.id === hId) : null;
  step("highlight-persisted", Boolean(h), h ? `page ${h.page}` : "");
  step("highlight-note", h?.note === "A note about this passage.", h?.note ?? "");

  // Overlay must appear in the DOM on the highlighted page. The reader polls,
  // so give it a beat to pick up the out-of-band insert.
  await waitFor(win, 'document.querySelectorAll(".highlight-rect").length >= 1');
  const overlay = await win.webContents.executeJavaScript(`document.querySelectorAll(".highlight-rect").length`);
  step("highlight-overlay-rendered", overlay >= 1, `${overlay} rects`);

  // ── annotations panel + markdown export ───────────────────────────────
  const md = await call("reading.exportMarkdown", { bookId });
  step("export-markdown", md.ok && md.data.markdown.includes("unique-marker-2-abc"),
    md.ok ? `${md.data.markdown.length} chars` : md.error);
  step("export-includes-note", md.ok && md.data.markdown.includes("A note about this passage."));

  // ── display overrides persist ─────────────────────────────────────────
  await call("reading.saveSettings", {
    bookId,
    settings: {
      pageBackground: "sepia", invert: true, brightness: 1.2, contrast: 1.1,
      zoomMode: "fit-page", zoom: 1, layout: "scroll", cropMargins: 0, hideHeaders: false,
    },
  });
  const afterSettings = await call("reading.list", undefined);
  const sBook = afterSettings.ok ? afterSettings.data.find((b) => b.id === bookId) : null;
  step("settings-persist", sBook?.settings?.pageBackground === "sepia" && sBook?.settings?.invert === true,
    `${sBook?.settings?.pageBackground}, invert=${sBook?.settings?.invert}`);

  // ── reading session feeds the time module ─────────────────────────────
  const ended = await call("reading.endSession", { bookId });
  // `activeSeconds >= 0` was always true for a duration, so this could not fail
  // on the case it looks like it guards. The verifier never calls
  // `reading.reportVisible`, so zero is the *correct* value here and a positive
  // assertion would be wrong. Assert the shape instead: the call succeeds and
  // both counters are present integers — which is what caught the contract drift
  // if either field is ever dropped.
  step(
    "session-closes",
    ended.ok && Number.isInteger(ended.data.activeSeconds) && Number.isInteger(ended.data.pagesTurned),
    ended.ok ? `${ended.data.activeSeconds}s active, ${ended.data.pagesTurned} pages` : ended.error,
  );

  const dayAfter = await call("dashboard.day", {});
  step("reading-time-in-dashboard", dayAfter.ok, `reading ${dayAfter.data?.readingSeconds}s`);

  // ── highlight survives a page revisit (anchor resolution) ─────────────
  await win.webContents.executeJavaScript(`
    document.querySelectorAll(".reader-nav .mini")[0]?.click()
  `);
  await sleep(1000);
  await win.webContents.executeJavaScript(`
    document.querySelectorAll(".reader-nav .mini")[1]?.click()
  `);
  await waitFor(win, 'document.querySelectorAll(".highlight-rect").length >= 1');
  const overlayAgain = await win.webContents.executeJavaScript(`document.querySelectorAll(".highlight-rect").length`);
  step("highlight-survives-navigation", overlayAgain >= 1, `${overlayAgain} rects after navigating away and back`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m4-reading.png"), img.toPNG());
  // F-READ-02: `author` must be carried on every book and renderable by the
  // card. The bundled fixture has no /Author in its metadata, so the *capture*
  // path (pdf.js -> setPageCount -> DB) cannot be exercised here; it is pinned
  // by `tests/review-regressions.test.ts` instead. What this asserts is that the
  // field survives the contract to the renderer, which is where it was dead.
  const booksAfter = await call("reading.list", undefined);
  step(
    "book-carries-author-field",
    booksAfter.ok && booksAfter.data.every((b) => "author" in b),
    booksAfter.ok ? `author key present on ${booksAfter.data.length} book(s)` : booksAfter.error,
  );

  // F-READ-02's author capture, exercised for real. The bundled sample-40p.pdf
  // has no /Author, so the main flow cannot test this; author-sample.pdf does.
  // Import stores author NULL, and opening the book must back-fill it — this is
  // the path that was gated behind a stale page count and therefore never ran
  // for an already-opened book.
  const AUTH_FIXTURE = path.join(__dirname, "fixtures", "author-sample.pdf");
  const authImp = await call("reading.import", { path: AUTH_FIXTURE });
  const authId = authImp.ok ? authImp.data.id : null;
  const preOpen = await call("reading.list", undefined);
  const preRow = preOpen.ok ? preOpen.data.find((b) => b.id === authId) : null;
  step("author-null-on-import", !!preRow && preRow.author === null, `author=${preRow?.author}`);

  // Re-enter the Reading module. The import above went through IPC directly, so
  // the UI's own list never refetched (its import path calls `load()` after
  // importing, which this bypasses) and the new card would never appear. Leaving
  // and re-entering remounts the view and refetches — the same thing a user sees
  // after importing from the UI.
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Habits")?.click()
  `);
  await sleep(300);
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Reading")?.click()
  `);
  const cardReady = await waitFor(
    win,
    `[...document.querySelectorAll(".book-card")].some(c => c.textContent.includes("author-sample"))`,
    8000,
  );
  step("author-card-present", cardReady, "card rendered before click");
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".book-card")]
      .find(c => c.textContent.includes("author-sample"))?.click()
  `);
  await waitFor(win, 'document.querySelectorAll(".text-layer span").length > 0', 12000);
  // The author back-fill rides on the page-count report, which is a separate
  // async IPC after the text layer appears; poll for it instead of racing it.
  let postOpen = await call("reading.list", undefined);
  for (let i = 0; i < 12; i++) {
    const row = postOpen.ok ? postOpen.data.find((b) => b.id === authId) : null;
    if (row && row.author) break;
    await new Promise((r) => setTimeout(r, 500));
    postOpen = await call("reading.list", undefined);
  }
  const postRow = postOpen.ok ? postOpen.data.find((b) => b.id === authId) : null;
  step(
    "author-backfilled-on-open",
    postRow?.author === "Ada Lovelace",
    `author=${JSON.stringify(postRow?.author)}`,
  );

  step("screenshot", true, "spikes/out/m4-reading.png");

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m4-reading.json"), JSON.stringify(report, null, 2));
  console.log("M4_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

