// SP-3: Hyprland socket2 event stream — parse, focus transitions, reconnect.
// Usage: node spikes/sp3-hyprland.cjs --seconds=25
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const secArg = process.argv.find((a) => a.startsWith("--seconds="));
const SECONDS = secArg ? Number(secArg.split("=")[1]) : 25;

const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
const sock = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, "hypr", sig, ".socket2.sock");

const report = {
  spike: "SP-3", signature: sig, socketPath: sock, socketExists: fs.existsSync(sock),
  durationSeconds: SECONDS, connects: 0, reconnects: 0, bytes: 0,
  events: {}, focusSegments: [], errors: [], startedAt: new Date().toISOString(),
};

const hypr = (args) => { try { return execFileSync("hyprctl", args, { encoding: "utf8" }); } catch (e) { return ""; } };
const reconcile = () => {
  try {
    const j = JSON.parse(hypr(["-j", "activewindow"]));
    return { class: j.class, title: j.title, pid: j.pid, workspace: j.workspace && j.workspace.id };
  } catch { return { error: "parse failed" }; }
};

let current = reconcile();
let segmentStart = Date.now();
report.initialWindow = current;

function closeSegment(reason) {
  if (!current) return;
  const end = Date.now();
  if (end - segmentStart >= 50) {
    report.focusSegments.push({
      class: current.class, title: (current.title || "").slice(0, 60),
      workspace: current.workspace, ms: end - segmentStart, closedBy: reason,
    });
  }
}

function openSegment(cls, title) {
  segmentStart = Date.now();
  current = { ...current, class: cls, title };
}

let socket, buffer = "", dropped = false;

function connect() {
  socket = net.createConnection({ path: sock });
  report.connects++;
  socket.setEncoding("utf8");
  socket.on("connect", () => { report.connectedAt = new Date().toISOString(); });
  socket.on("data", (chunk) => {
    report.bytes += Buffer.byteLength(chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const i = line.indexOf(">>");
      if (i < 0) continue;
      const name = line.slice(0, i), data = line.slice(i + 2);
      report.events[name] = (report.events[name] || 0) + 1;
      if (name === "activewindow") {
        const c = data.indexOf(",");
        const cls = c > -1 ? data.slice(0, c) : data;
        const title = c > -1 ? data.slice(c + 1) : "";
        closeSegment("activewindow");
        openSegment(cls, title);
        report.focusTransitions = (report.focusTransitions || 0) + 1;
      } else if (name === "activewindowv2" && (!current || !current.class)) {
        closeSegment("activewindowv2");
        const j = reconcile();
        openSegment(j.class, j.title);
      } else if (name === "workspace") {
        current = { ...current, workspace: data.trim() };
      }
    }
  });
  socket.on("error", (e) => report.errors.push({ at: new Date().toISOString(), message: e.message }));
  socket.on("close", () => {
    closeSegment("socket-close");
    if (!dropped && Date.now() - t0 < SECONDS * 1000) {
      report.reconnects++;
      dropped = true;
      setTimeout(connect, 300);
    }
  });
}

const t0 = Date.now();
connect();

// Force real focus changes so the stream is exercised end-to-end.
setTimeout(() => { hypr(["repl", 'return hl.dispatch(hl.dsp.window.bring_to_top({class="helium"}))']); }, 1500);
setTimeout(() => { hypr(["repl", 'return hl.dispatch(hl.dsp.exec_cmd("foot"))']); }, 4000);
setTimeout(() => { hypr(["repl", 'return hl.dispatch(hl.dsp.window.bring_to_top({class="helium"}))']); }, 7000);
setTimeout(() => { report.simulatedDrop = true; if (socket && !socket.destroyed) socket.destroy(); }, 10000);
setTimeout(() => { hypr(["repl", 'return hl.dispatch(hl.dsp.window.bring_to_top({class="foot"}))']); }, 11500);

setTimeout(() => {
  closeSegment("end");
  report.reconcileAtEnd = reconcile();
  report.totalEvents = Object.values(report.events).reduce((a, b) => a + b, 0);
  report.eventNames = Object.keys(report.events);
  report.reconnectWorked = report.reconnects > 0 && report.connects > 1;
  report.eventsAfterReconnect = report.connects > 1 ? report.totalEvents > 0 : null;
  fs.writeFileSync(path.join(OUT, "SP-3.json"), JSON.stringify(report, null, 2));
  console.log("SP-3_RESULT " + JSON.stringify(report));
  if (socket) socket.destroy();
  process.exit(0);
}, SECONDS * 1000);
