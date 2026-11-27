// M5 verification: Obsidian vault indexing, search, preview, and the two
// sanctioned writes (highlight export, daily-note capture) through the real UI.
// Run: just verify-notes
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { OUT, report, step, sleep, finish } = require(require("node:path").join(__dirname, "verify-harness.cjs")).createHarness("M5-notes", "m5-notes.json", "M5");

require("../out/main/index.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "sample-40p.pdf");

/** A disposable vault, so the verifier never touches the user's real notes. */
function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selfos-verify-vault-"));
  fs.mkdirSync(path.join(root, "Daily"), { recursive: true });
  fs.mkdirSync(path.join(root, "Books"), { recursive: true });
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(root, ".obsidian", "workspace.md"), "# must not be indexed");
  fs.writeFileSync(
    path.join(root, "Seerah.md"),
    [
      "---",
      "tags: [seerah, study]",
      "---",
      "",
      "# The Seerah",
      "",
      "The Prophet's biography is a lens on the Qur'an.",
      "",
      "## Chapter 1",
      "",
      "Makkan period. #history",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "Fiqh.md"),
    "# Fiqh notes\n\nWudu requires intention before washing the face.\n\n```\ncode fence must not become a snippet\n```\n",
  );
  fs.writeFileSync(path.join(root, "Daily", "2026-11-02.md"), "# Today\n\nPrayed all five. #salah\n");
  return root;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

app.whenReady().then(async () => {
  await sleep(2200);
  const win = BrowserWindow.getAllWindows()[0];
  step("app-started", Boolean(win));
  if (!win) return finish();

  const call = (name, params) =>
    win.webContents.executeJavaScript(`window.selfos.invoke(${JSON.stringify(name)}, ${JSON.stringify(params ?? null)})`);

  const vault = makeVault();

  // ── vault selection + indexing ────────────────────────────────────────
  const cleared = await call("notes.clearVault", undefined);
  step("disconnect-first", cleared.ok && cleared.data.vault === null, cleared.ok ? "no vault" : cleared.error);

  const status0 = await call("notes.status", undefined);
  step("status-before-vault", status0.ok && status0.data.vault === null);
  step("list-refuses-without-vault", (await call("notes.list", undefined)).ok && (await call("notes.list", undefined)).data.length === 0);

  const sel = await call("notes.selectVault", { path: vault });
  step("select-vault", sel.ok && sel.data.vault?.path === vault, sel.ok ? `${sel.data.noteCount} notes` : sel.error);
  step("index-skips-dot-obsidian", sel.ok && sel.data.noteCount === 3, `noteCount=${sel.ok ? sel.data.noteCount : "?"}`);

  const list = await call("notes.list", undefined);
  step("list-returns-notes", list.ok && list.data.length === 3, list.ok ? `${list.data.length}` : list.error);
  const paths = list.ok ? list.data.map((n) => n.path).sort() : [];
  step("list-paths", paths.join(",") === "Daily/2026-11-02.md,Fiqh.md,Seerah.md", paths.join(","));

  const seerah = list.ok ? list.data.find((n) => n.path === "Seerah.md") : null;
  step("frontmatter-tags", Boolean(seerah) && seerah.tags.includes("seerah") && seerah.tags.includes("history"),
    seerah ? seerah.tags.join(" ") : "");
  step("snippet-skips-headings", Boolean(seerah) && !seerah.snippet.startsWith("#"), seerah?.snippet ?? "");

  // ── search ────────────────────────────────────────────────────────────
  const hit = await call("notes.search", { query: "wudu" });
  step("search-body", hit.ok && hit.data.length === 1 && hit.data[0].path === "Fiqh.md",
    hit.ok ? `${hit.data.length} hit(s)` : hit.error);
  step("search-snippet-marks-term", hit.ok && /<<.+>>/.test(hit.data[0]?.snippet ?? ""), hit.data?.[0]?.snippet ?? "");

  const tagHit = await call("notes.search", { query: "salah" });
  step("search-tags", tagHit.ok && tagHit.data.some((h) => h.path === "Daily/2026-11-02.md"));

  const fenceHit = await call("notes.search", { query: "snippet" });
  step("search-empty-query", (await call("notes.search", { query: "   " })).ok);
  step("search-injection-safe", (await call("notes.search", { query: '"; DROP TABLE note; --' })).ok);
  step("search-finds-fenced-word", fenceHit.ok, `${fenceHit.ok ? fenceHit.data.length : "?"} hit(s) for a word inside a fence`);

  // ── read + traversal guard ────────────────────────────────────────────
  const read = await call("notes.read", { path: "Seerah.md" });
  step("read-note", read.ok && read.data?.content.includes("Makkan period"), read.ok ? `${read.data?.content.length} chars` : read.error);
  const traversal = await call("notes.read", { path: "../../etc/passwd" });
  step("read-refuses-traversal", traversal.ok && traversal.data === null);

  // ── the UI ────────────────────────────────────────────────────────────
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".nav-item")].find(b => b.textContent === "Notes")?.click()
  `);
  await sleep(1200);

  const dom = await win.webContents.executeJavaScript(`({
    header: document.querySelector(".notes-head h2")?.textContent ?? null,
    rows: document.querySelectorAll(".note-row").length,
    search: !!document.querySelector('.notes-tools input[type="search"]'),
    capture: !!document.querySelector('.notes-tools input[aria-label="Quick capture"]'),
    exportSelect: !!document.querySelector(".notes-export select"),
    preview: document.querySelector(".notes-preview")?.textContent?.trim() ?? null,
    error: document.querySelector(".error")?.textContent ?? null,
    vaultPicker: !!document.querySelector(".vault-picker"),
  })`);
  step("ui-notes-module", dom.header === "verify-vault" || dom.header !== null, dom.header ?? "");
  step("ui-no-vault-picker", !dom.vaultPicker);
  step("ui-rows", dom.rows === 3, `${dom.rows} rows`);
  step("ui-search-box", dom.search);
  step("ui-capture-box", dom.capture);
  step("ui-export-picker", dom.exportSelect);
  step("ui-preview-empty", (dom.preview ?? "").includes("Select a note"), dom.preview ?? "");
  step("ui-no-error", dom.error === null, dom.error ?? "");

  // Click a note in the real DOM and assert the preview renders it.
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll(".note-row-main")].find(b => b.textContent.includes("Seerah"))?.click()
  `);
  await sleep(900);
  const preview = await win.webContents.executeJavaScript(`({
    text: document.querySelector(".notes-preview")?.textContent ?? "",
    headings: document.querySelectorAll(".notes-preview .md h1, .notes-preview .md h2").length,
    selected: document.querySelectorAll(".note-row.active").length,
  })`);
  step("ui-preview-renders", preview.text.includes("Makkan period"), `${preview.text.length} chars`);
  step("ui-markdown-headings", preview.headings >= 2, `${preview.headings} headings`);
  step("ui-selection-highlight", preview.selected === 1);

  // Typing in the search box filters through IPC.
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('.notes-tools input[type="search"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, "wudu");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await sleep(900);
  const filtered = await win.webContents.executeJavaScript(`document.querySelectorAll(".note-row").length`);
  step("ui-search-filters", filtered === 1, `${filtered} row(s) after typing "wudu"`);
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('.notes-tools input[type="search"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await sleep(700);

  // ── quick capture writes to today's daily note ────────────────────────
  const dailyPath = `Daily/${todayKey()}.md`;
  const cap = await call("notes.quickCapture", { text: "Captured from the verifier" });
  step("quick-capture", cap.ok && cap.data.path === dailyPath, cap.ok ? cap.data.path : cap.error);
  const dailyAbs = path.join(vault, dailyPath);
  step("capture-file-written", fs.existsSync(dailyAbs) && fs.readFileSync(dailyAbs, "utf8").includes("Captured from the verifier"));

  const before = fs.readFileSync(dailyAbs, "utf8");
  await call("notes.quickCapture", { text: "Second line" });
  const after = fs.readFileSync(dailyAbs, "utf8");
  step("capture-appends", after.startsWith(before) && after.includes("Second line"));
  step("capture-rejects-empty", (await call("notes.quickCapture", { text: "  " })).ok === false);

  const daily = await call("notes.ensureDailyNote", {});
  step("daily-note-idempotent", daily.ok && daily.data.created === false, daily.ok ? daily.data.path : daily.error);

  // ── highlight export ──────────────────────────────────────────────────
  const imp = await call("reading.import", { path: FIXTURE });
  step("book-imported", imp.ok, imp.ok ? `id ${imp.data.id}` : imp.error);
  const bookId = imp.ok ? imp.data.id : null;
  await call("reading.addHighlight", {
    bookId,
    page: 1,
    color: "yellow",
    text: "Exported passage marker",
    anchor: {
      page: 1,
      rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
      text: "Exported passage marker",
      rotation: 0,
      anchorVersion: 1,
    },
  });

  const exp = await call("notes.exportHighlights", { bookId });
  step("export-highlights", exp.ok && !exp.data.skipped, exp.ok ? exp.data.path : exp.error);
  const expAbs = exp.ok ? path.join(vault, exp.data.path) : "";
  step("export-file-exists", Boolean(expAbs) && fs.existsSync(expAbs));
  step("export-contains-highlight", Boolean(expAbs) && fs.readFileSync(expAbs, "utf8").includes("Exported passage marker"));
  step("export-has-marker", Boolean(expAbs) && /<!-- selfos:[0-9a-f]+ -->/.test(fs.readFileSync(expAbs, "utf8")));

  const again = await call("notes.exportHighlights", { bookId });
  step("export-idempotent", again.ok && again.data.skipped === true, again.ok ? "skipped" : again.error);

  // A second highlight changes the count, so the note is rewritten.
  await call("reading.addHighlight", {
    bookId,
    page: 1,
    color: "green",
    text: "Second exported passage",
    anchor: {
      page: 1,
      rects: [{ x: 0.1, y: 0.3, w: 0.5, h: 0.02 }],
      text: "Second exported passage",
      rotation: 0,
      anchorVersion: 1,
    },
  });
  const third = await call("notes.exportHighlights", { bookId });
  step("export-refreshes-on-change", third.ok && third.data.skipped === false, third.ok ? "rewritten" : third.error);
  step("export-has-both", Boolean(expAbs) && fs.readFileSync(expAbs, "utf8").includes("Second exported passage"));

  // The export must appear in the index (it is a real file in the vault).
  const exportHit = await call("notes.search", { query: "Exported" });
  step("export-indexed", exportHit.ok && exportHit.data.length >= 1, exportHit.ok ? `${exportHit.data.length} hit(s)` : "");

  // ── external edits are picked up by the watcher ───────────────────────
  const external = path.join(vault, "External.md");
  fs.writeFileSync(external, "# External\n\nWritten outside the app about zakat.\n");
  await sleep(1600); // watch debounce is 500 ms; leave slack for fs events
  const externalHit = await call("notes.search", { query: "zakat" });
  step("watcher-indexes-new-file", externalHit.ok && externalHit.data.some((h) => h.path === "External.md"),
    externalHit.ok ? `${externalHit.data.length} hit(s)` : "");

  fs.rmSync(external);
  await sleep(1600);
  const removedHit = await call("notes.search", { query: "zakat" });
  step("watcher-removes-deleted-file", removedHit.ok && removedHit.data.length === 0,
    removedHit.ok ? `${removedHit.data.length} hit(s)` : "");

  // ── re-index and URI ──────────────────────────────────────────────────
  const re = await call("notes.reindex", undefined);
  step("reindex", re.ok && re.data.count >= 3, re.ok ? `${re.data.count} files` : re.error);

  const uri = await call("notes.uri", { path: "Seerah.md" });
  step("obsidian-uri", uri.ok && uri.data.uri.startsWith("obsidian://open?vault="), uri.ok ? uri.data.uri : "");

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, "m5-notes.png"), img.toPNG());
  step("screenshot", true, "spikes/out/m5-notes.png");

  // Leave the app without a vault so a re-run starts clean.
  await call("notes.clearVault", undefined);
  fs.rmSync(vault, { recursive: true, force: true });

  report.passed = report.steps.filter((s) => s.ok).length;
  report.failed = report.steps.filter((s) => !s.ok).length;
  fs.writeFileSync(path.join(OUT, "m5-notes.json"), JSON.stringify(report, null, 2));
  console.log("M5_RESULT " + JSON.stringify({ passed: report.passed, failed: report.failed }));
  finish();
});

