// SP-2b: per-process memory breakdown for an idle Electron app.
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path");

const OUT = path.join(__dirname, "out");
const snap = () => {
  const out = execFileSync("ps", ["-eo", "pid,rss,comm,args"], { encoding: "utf8" }).split("\n");
  const rows = [];
  const own = new Set();
  for (const l of out) {
    if (!/electron/i.test(l) || /ps -eo|earlyoom|t3code|\/usr\/lib\//.test(l)) continue;
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const args = m[4];
    const type = /--type=renderer/.test(args) ? "renderer"
      : /--type=gpu-process/.test(args) ? "gpu"
      : /--type=utility/.test(args) ? "utility"
      : /--type=zygote/.test(args) ? "zygote"
      : "main";
    rows.push({ pid: +m[1], rssMB: Math.round(+m[2] / 1024), type });
  }
  return rows;
};
const sum = (rows) => rows.reduce((a, r) => a + r.rssMB, 0);

app.whenReady().then(async () => {
  // Unmapped on purpose. This spike measures idle memory, and Electron spawns the
  // renderer/gpu/utility processes on `new BrowserWindow` regardless of
  // visibility, so nothing is lost. Showing it would activate the window and a
  // Hyprland rule matching class `^(selfos|electron)$` would drag the user to
  // workspace 5 — a measurement run must never interrupt live work.
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL("data:text/html,<html><body style='background:%23282828;color:%23d4be98;font:14px sans-serif'>SelfOS shell stub</body></html>");
  await new Promise((r) => setTimeout(r, 2500));

  const idle = snap();
  const report = {
    spike: "SP-2b",
    idleTotalMB: sum(idle),
    byType: idle.reduce((a, r) => { a[r.type] = (a[r.type] || 0) + r.rssMB; return a; }, {}),
    processes: idle,
    note: "RSS sums double-count shared pages; PSS from smaps_rollup is the honest number.",
  };
  // PSS across all electron processes (shared pages divided fairly)
  let pss = 0;
  for (const r of idle) {
    try {
      const s = fs.readFileSync(`/proc/${r.pid}/smaps_rollup`, "utf8");
      const m = s.match(/^Pss:\s+(\d+) kB/m);
      if (m) pss += +m[1];
    } catch {}
  }
  report.pssTotalMB = Math.round(pss / 1024);

  fs.writeFileSync(path.join(OUT, "SP-2b.json"), JSON.stringify(report, null, 2));
  console.log("SP-2B_RESULT " + JSON.stringify(report));
  win.destroy();
  app.quit();
});
