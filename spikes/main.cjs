// SelfOS spike harness — exercises the five gating questions from STACK.md §16.
// Each spike is independent; run one with: electron spikes/main.cjs --spike=SP-2
const { app, BrowserWindow, Tray, Menu, nativeImage, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const url = require("node:url");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

const spikeArg = process.argv.find((a) => a.startsWith("--spike="));
const SPIKE = spikeArg ? spikeArg.split("=")[1] : "all";

// ── SP-2: memory + PDF render throughput ────────────────────────────────
async function runSP2(win) {
  const { execFileSync } = require("node:child_process");
  const rssMB = () => {
    const out = execFileSync("ps", ["-eo", "rss,comm"], { encoding: "utf8" });
    let total = 0;
    for (const line of out.split("\n")) {
      if (/electron/i.test(line)) total += parseInt(line.trim().split(/\s+/)[0], 10) || 0;
    }
    return Math.round(total / 1024);
  };

  const idle = rssMB();

  const result = await win.webContents.executeJavaScript(`
    (async () => {
      const pdfjs = await import("/pdfjs/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";
      const doc = await pdfjs.getDocument("/fixtures/sample-40p.pdf").promise;
      const times = [];
      const t0 = performance.now();
      for (let p = 1; p <= doc.numPages; p++) {
        const s = performance.now();
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 1.5 });
        const c = document.createElement("canvas");
        c.width = vp.width; c.height = vp.height;
        c.style.cssText = "position:absolute;left:0;top:0;width:" + vp.width + "px";
        document.body.appendChild(c);
        await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        times.push(performance.now() - s);
      }
      const total = performance.now() - t0;
      const text = await (await doc.getPage(1)).getTextContent();
      return {
        pages: doc.numPages,
        totalMs: Math.round(total),
        perPageMs: times.map((t) => Math.round(t)),
        medianMs: Math.round(times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)]),
        textItemsPage1: text.items.length,
        hasSelectableText: text.items.some((i) => (i.str || "").includes("unique-marker-1")),
        gpu: (() => {
          const c = document.createElement("canvas");
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          if (!gl) return "no-webgl";
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "webgl-ok (renderer hidden)";
        })(),
      };
    })()
  `);

  // Let rendering settle, then measure again
  await new Promise((r) => setTimeout(r, 1500));
  const withPdf = rssMB();

  const report = { spike: "SP-2", idleRssMB: idle, readerRssMB: withPdf, deltaMB: withPdf - idle, ...result };
  fs.writeFileSync(path.join(OUT, "SP-2.json"), JSON.stringify(report, null, 2));
  console.log("SP-2_RESULT " + JSON.stringify(report));
  return report;
}

// ── SP-4: Intl Islamic calendar support ─────────────────────────────────
async function runSP4(win) {
  const r = await win.webContents.executeJavaScript(`
    (() => {
      const out = { userAgent: navigator.userAgent, cases: {} };
      const d = new Date(Date.UTC(2026, 10, 2));
      for (const cal of ["islamic-umalqura", "islamic-civil", "islamic", "islamic-rgsa"]) {
        try {
          out.cases[cal] = new Intl.DateTimeFormat("en-u-ca-" + cal, {
            day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
          }).format(d);
        } catch (e) { out.cases[cal] = "ERROR: " + e.message; }
      }
      try {
        const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
          day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC",
        }).formatToParts(d);
        out.parts = parts.map((p) => p.type + "=" + p.value).join(",");
      } catch (e) { out.parts = "ERROR: " + e.message; }
      return out;
    })()
  `);
  fs.writeFileSync(path.join(OUT, "SP-4.json"), JSON.stringify(r, null, 2));
  console.log("SP-4_RESULT " + JSON.stringify(r));
  return r;
}

// ── SP-9: media codec support ───────────────────────────────────────────
async function runSP9(win, fixture) {
  const r = await win.webContents.executeJavaScript(`
    (async () => {
      const v = document.createElement("video");
      const codecs = ["video/mp4; codecs=\\"avc1.42E01E\\"", "video/mp4; codecs=\\"avc1.640028\\"",
        "audio/mp4; codecs=\\"mp4a.40.2\\"", "video/webm; codecs=\\"vp8\\"", "video/webm; codecs=\\"vp9\\"",
        "audio/webm; codecs=\\"opus\\"", "audio/mpeg", "video/mp2t; codecs=\\"avc1.42E01E\\"",
        "video/quicktime; codecs=\\"avc1.42E01E\\""];
      const support = {};
      for (const c of codecs) support[c] = v.canPlayType(c) || "no";
      let playback = null;
      const trySrc = async (label, src) => {
        const vv = document.createElement("video");
        vv.muted = true; vv.playsInline = true; vv.preload = "auto";
        try {
          vv.src = src;
          await new Promise((res, rej) => {
            vv.onloadeddata = res;
            vv.onerror = () => rej(new Error("code " + (vv.error && vv.error.code) + " " + (vv.error && vv.error.message)));
            setTimeout(() => rej(new Error("timeout")), 8000);
          });
          await vv.play();
          await new Promise((res) => setTimeout(res, 600));
          return { label, ok: true, w: vv.videoWidth, h: vv.videoHeight, duration: vv.duration, t: vv.currentTime };
        } catch (e) { return { label, ok: false, error: e.message }; }
      };
      const local = await trySrc("local-file", "file:///home/saboor/code/selfos/spikes/fixtures/media-h264.mp4");
      const remote = await trySrc("remote-webm", "https://upload.wikimedia.org/wikipedia/commons/2/22/Volcano_Lava_Sample.webm");
      const remoteMp4 = await trySrc("remote-mp4", "https://upload.wikimedia.org/wikipedia/commons/transcoded/8/87/Schlossbergbahn.webm/Schlossbergbahn.webm.480p.vp9.webm");
      return { canPlayType: support, playback: local, remote, remoteMp4, mse: typeof MediaSource !== "undefined" };
    })()
  `);
  fs.writeFileSync(path.join(OUT, "SP-9.json"), JSON.stringify(r, null, 2));
  console.log("SP-9_RESULT " + JSON.stringify(r));
  return r;
}

// ── SP-8: tray registration under StatusNotifierWatcher ─────────────────
async function runSP8() {
  const { execFileSync } = require("node:child_process");
  const iconPath = path.join(OUT, "tray-icon.png");
  // 32x32 solid accent square, written as PNG via Electron's nativeImage
  const img = nativeImage.createFromBuffer(
    Buffer.from(
      // tiny 1x1 PNG, scaled by nativeImage
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    )
  ).resize({ width: 32, height: 32 });
  fs.writeFileSync(iconPath, img.toPNG());

  const tray = new Tray(img);
  tray.setToolTip("SelfOS spike tray");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show/Hide", click() {} },
    { label: "Pause tracking", type: "checkbox", checked: false },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  await new Promise((r) => setTimeout(r, 2500));

  let registered = [];
  try {
    const out = execFileSync("dbus-send", [
      "--session", "--print-reply", "--dest=org.kde.StatusNotifierWatcher",
      "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties.Get",
      "string:org.kde.StatusNotifierWatcher", "string:RegisteredStatusNotifierItems",
    ], { encoding: "utf8" });
    registered = out.split("\n").filter((l) => l.includes("string ")).map((l) => l.trim());
  } catch (e) { registered = ["ERROR: " + e.message]; }

  const selfosVisible = registered.some((s) => /electron|selfos/i.test(s));
  const r = {
    spike: "SP-8",
    trayCreated: !tray.isDestroyed(),
    watcherItemCount: registered.length,
    items: registered.slice(0, 12),
    selfosRegistered: selfosVisible,
    note: selfosVisible
      ? "Tray item appeared in the watcher registry"
      : "Tray object created, but no Electron-owned item name matched (SNI item names are generic like :1.72/StatusNotifierItem)",
  };
  fs.writeFileSync(path.join(OUT, "SP-8.json"), JSON.stringify(r, null, 2));
  console.log("SP-8_RESULT " + JSON.stringify(r));
  tray.destroy();
  return r;
}

// ── SP-10: frameless window drag/resize support ─────────────────────────
async function runSP10() {
  const win = new BrowserWindow({
    width: 640, height: 420, frame: false, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL("data:text/html," + encodeURIComponent(`
    <html><body style="margin:0;background:#282828;color:#d4be98;font:14px sans-serif">
      <div style="-webkit-app-region:drag;height:48px;background:#3c3836;display:flex;align-items:center;padding:0 12px">
        SelfOS frameless titlebar (drag region)
      </div>
      <div style="padding:16px">Content area. Try dragging the bar and resizing edges.</div>
    </body></html>`));
  await new Promise((r) => setTimeout(r, 1200));
  const bounds = win.getBounds();
  const r = {
    spike: "SP-10",
    created: !win.isDestroyed(),
    framelessSupported: true,
    bounds,
    resizable: win.isResizable(),
    note: "Window created frameless and shown; drag region is CSS-only and cannot be asserted programmatically",
  };
  fs.writeFileSync(path.join(OUT, "SP-10.json"), JSON.stringify(r, null, 2));
  console.log("SP-10_RESULT " + JSON.stringify(r));
  win.destroy();
  return r;
}

// ── app bootstrap ───────────────────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: "selfos-book", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// VAAPI is left at defaults: the host's iHD driver is broken and enabling it only adds noise.

app.whenReady().then(async () => {
  // Static serving for spike assets (fixtures, pdf.js worker)
  protocol.handle("selfos-book", (req) => {
    const u = new URL(req.url);
    const file = path.join(ROOT, "spikes", "fixtures", path.basename(u.pathname));
    return net.fetch(url.pathToFileURL(file).toString());
  });

  const results = {};
  try {
    if (SPIKE === "SP-4") {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      await w.loadURL("about:blank");
      results["SP-4"] = await runSP4(w);
      w.destroy();
    } else if (SPIKE === "SP-8") {
      results["SP-8"] = await runSP8();
    } else if (SPIKE === "SP-10") {
      results["SP-10"] = await runSP10();
    } else if (SPIKE === "SP-2" || SPIKE === "SP-9") {
      const http = require("node:http");
      const mime = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".pdf": "application/pdf", ".mp4": "video/mp4" };
      const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "spike.html";
        const file = path.join(__dirname, rel);
        if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
        fs.readFile(file, (err, buf) => {
          if (err) { res.writeHead(404); return res.end("not found"); }
          res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
          res.end(buf);
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      const w = new BrowserWindow({
        width: 1000, height: 800, show: SPIKE === "SP-2",
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      await w.loadURL(`http://127.0.0.1:${port}/spike.html`);
      if (SPIKE === "SP-2") results["SP-2"] = await runSP2(w);
      if (SPIKE === "SP-9") results["SP-9"] = await runSP9(w);
      w.destroy();
      server.close();
    }
  } catch (e) {
    console.error("SPIKE_ERROR", e);
    fs.writeFileSync(path.join(OUT, `${SPIKE}-error.txt`), String(e && e.stack || e));
  }
  app.quit();
});
