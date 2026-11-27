// SP-5: do highlight anchors survive zoom / rotation / re-render?
//
// The mechanism under test is the one R1 depends on: store a highlight as
// rects NORMALIZED to the page viewport, then re-derive screen rects at any
// scale. If normalized rects agree across scales, anchors are stable.
//
// Run: npm run spike:anchors
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".pdf": "application/pdf" };

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "spike.html";
    const file = path.join(__dirname, rel);
    if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const win = new BrowserWindow({
    width: 1200, height: 900, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`http://127.0.0.1:${port}/spike.html`);

  const result = await win.webContents.executeJavaScript(`
  (async () => {
    const pdfjs = await import("/pdfjs/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";
    const doc = await pdfjs.getDocument("/fixtures/sample-40p.pdf").promise;
    const page = await doc.getPage(1);

    // Build the text layer the way a reader does: one span per text item,
    // positioned from the item transform, scaled by the viewport.
    async function layerAt(scale, rotation) {
      const vp = page.getViewport({ scale, rotation });
      const tc = await page.getTextContent();
      const items = tc.items.filter((i) => i.str && i.str.trim());
      return {
        vp: { width: vp.width, height: vp.height, scale, rotation },
        items: items.map((i) => {
          const tx = pdfjs.Util.transform(vp.transform, i.transform);
          const x = tx[4], y = tx[5];
          const h = Math.hypot(tx[2], tx[3]);
          const w = i.width * scale;
          return {
            str: i.str,
            // screen-space rect, PDF y grows up so flip against viewport height
            x, y: vp.height - y - h, w, h,
            // normalized to the viewport: this is what we persist
            nx: x / vp.width, ny: (vp.height - y - h) / vp.height,
            nw: w / vp.width, nh: h / vp.height,
          };
        }),
      };
    }

    const scales = [1.0, 1.25, 1.5, 2.0, 3.0];
    const layers = {};
    for (const s of scales) layers[s] = await layerAt(s, 0);

    const marker = "unique-marker-1-abc";
    const find = (layer) => layer.items.find((i) => i.str.includes(marker));

    // 1. Normalized-rect stability across zoom
    const norm = scales.map((s) => {
      const it = find(layers[s]);
      return it ? { scale: s, nx: +it.nx.toFixed(6), ny: +it.ny.toFixed(6), nw: +it.nw.toFixed(6), nh: +it.nh.toFixed(6) } : { scale: s, missing: true };
    });
    const base = norm[0];
    const maxDrift = Math.max(...norm.filter((n) => !n.missing).map((n) =>
      Math.max(Math.abs(n.nx - base.nx), Math.abs(n.ny - base.ny), Math.abs(n.nw - base.nw), Math.abs(n.nh - base.nh))));

    // 2. Round-trip: normalized -> screen rect at each scale, compare to fresh extraction
    const roundTrip = scales.map((s) => {
      const layer = layers[s];
      const fresh = find(layer);
      const rebuilt = { x: base.nx * layer.vp.width, y: base.ny * layer.vp.height, w: base.nw * layer.vp.width, h: base.nh * layer.vp.height };
      if (!fresh) return { scale: s, missing: true };
      const err = Math.max(Math.abs(rebuilt.x - fresh.x), Math.abs(rebuilt.y - fresh.y), Math.abs(rebuilt.w - fresh.w), Math.abs(rebuilt.h - fresh.h));
      return { scale: s, errorPx: +err.toFixed(3), errorPct: +((err / layer.vp.width) * 100).toFixed(4) };
    });

    // 3. Rotation. Rotation is NOT scale-invariant, so the reader must store the
    // rotation it was captured at. Verify that (a) rotation changes normalized
    // rects, and (b) a rotation-tagged anchor re-derives correctly at that rotation.
    const rotLayer = await layerAt(1.5, 90);
    const rotItem = rotLayer.items.find((i) => i.str.includes(marker));
    const rotNorm = rotItem ? { nx: rotItem.nx, ny: rotItem.ny, nw: rotItem.nw, nh: rotItem.nh } : null;
    const rotChanged = rotNorm ? Math.max(
      Math.abs(rotNorm.nx - base.nx), Math.abs(rotNorm.ny - base.ny),
      Math.abs(rotNorm.nw - base.nw), Math.abs(rotNorm.nh - base.nh)) > 1e-6 : null;
    // re-derive the rotation-0 anchor onto the rotated page: expected to be WRONG
    const rotRebuiltFrom0 = rotItem
      ? Math.max(Math.abs(base.nx * rotLayer.vp.width - rotItem.x), Math.abs(base.ny * rotLayer.vp.height - rotItem.y))
      : null;
    // re-derive the rotation-90 anchor onto the rotated page: expected to be CORRECT
    const rotRebuiltFrom90 = rotItem && rotNorm
      ? Math.max(Math.abs(rotNorm.nx * rotLayer.vp.width - rotItem.x), Math.abs(rotNorm.ny * rotLayer.vp.height - rotItem.y))
      : null;
    // and back to rotation 0 with the rotation-90 anchor: expected to be WRONG
    const backTo0 = rotNorm
      ? Math.max(Math.abs(rotNorm.nx * layers[1.5].vp.width - find(layers[1.5]).x), Math.abs(rotNorm.ny * layers[1.5].vp.height - find(layers[1.5]).y))
      : null;

    // 4. Text-search re-anchor fallback (when rects are unusable)
    const searchAt = (layer, needle) => {
      const hits = layer.items.filter((i) => i.str.includes(needle));
      return hits.length;
    };
    const searchHits = scales.map((s) => ({ scale: s, hits: searchAt(layers[s], marker) }));
    const ambiguous = scales.map((s) => ({ scale: s, hits: searchAt(layers[s], "Lorem ipsum") }));

    // 5. Two different text items must not collide (a real risk with coarse rects)
    const distinct = layers[1.5].items.length;
    const uniqueRects = new Set(layers[1.5].items.map((i) => i.nx.toFixed(4) + "," + i.ny.toFixed(4))).size;

    return {
      page: 1, rotationTested: 90,
      itemCountAt1_5: distinct, uniqueRectCount: uniqueRects,
      normalizedRects: norm,
      maxNormalizedDrift: +maxDrift.toFixed(8),
      roundTrip,
      rotation: {
        found: !!rotItem,
        normalizedRectsChangeWithRotation: rotChanged,
        rotation0AnchorOnRotatedPage_errorPx: rotRebuiltFrom0,
        rotation90AnchorOnRotatedPage_errorPx: rotRebuiltFrom90,
        rotation90AnchorBackOnRotation0_errorPx: backTo0,
      },
      searchFallback: { markerHits: searchHits, ambiguousPhraseHits: ambiguous },
      sampleItem: find(layers[1.5]) ? { str: find(layers[1.5]).str.slice(0, 60), nx: +find(layers[1.5]).nx.toFixed(5), ny: +find(layers[1.5]).ny.toFixed(5) } : null,
    };
  })()
  `);

  fs.writeFileSync(path.join(OUT, "SP-5.json"), JSON.stringify(result, null, 2));
  console.log("SP-5_RESULT " + JSON.stringify(result));
  win.destroy();
  server.close();
  app.quit();
});
