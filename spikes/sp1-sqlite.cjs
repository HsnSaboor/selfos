// SP-1: node:sqlite against the live 454 MB Helium history DB, plus WAL
// multi-process writes. Run as Electron main:
//   env -u ELECTRON_RUN_AS_NODE electron spikes/sp1-sqlite.cjs
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
const HIST = path.join(os.homedir(), ".config/net.imput.helium/Default/History");
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000n;

function time(fn) {
  const t = process.hrtime.bigint();
  const v = fn();
  return { value: v, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

app.whenReady().then(async () => {
  const report = { spike: "SP-1", node: process.versions.node, electron: process.versions.electron };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
    report.moduleAvailable = true;
  } catch (e) {
    report.moduleAvailable = false;
    report.moduleError = String(e);
    console.log("SP-1_RESULT " + JSON.stringify(report));
    return app.quit();
  }

  // 1. Read-only open of the live DB while Helium is running
  try {
    const open = time(() => new DatabaseSync(HIST, { readOnly: true }));
    report.openMs = Math.round(open.ms * 100) / 100;
    const db = open.value;
    db.exec("PRAGMA busy_timeout = 3000;");

    const count = time(() => db.prepare("SELECT COUNT(*) AS n FROM visits").get());
    report.visitCount = count.value.n;
    report.countMs = Math.round(count.ms * 100) / 100;

    // 2. BigInt precision: the real trap from STACK.md §5.3
    const stmt = db.prepare("SELECT visit_time FROM visits ORDER BY visit_time DESC LIMIT 1");
    stmt.setReadBigInts(true);
    const raw = stmt.get();
    report.latestVisitTimeBigInt = String(raw.visit_time);
    report.exceedsMaxSafe = raw.visit_time > BigInt(Number.MAX_SAFE_INTEGER);
    report.asNumberRounded = Number(raw.visit_time);
    report.roundTripLossless = BigInt(Number(raw.visit_time)) === raw.visit_time;
    report.convertedMs = Number(raw.visit_time / 1000n) - Number(CHROME_EPOCH_OFFSET_MS);
    report.convertedIso = new Date(report.convertedMs).toISOString();

    // 3. The real ingest query, timed
    const ingest = time(() => {
      const s = db.prepare(`
        SELECT u.url, u.title, v.visit_time, v.visit_duration, v.transition
        FROM visits v JOIN urls u ON u.id = v.url
        WHERE v.visit_time > ? ORDER BY v.visit_time LIMIT 5000`);
      s.setReadBigInts(true);
      return s.all(0n);
    });
    report.ingestRows = ingest.value.length;
    report.ingestMs = Math.round(ingest.ms);
    report.ingestSample = ingest.value.slice(0, 2).map((r) => ({
      url: r.url, title: r.title && r.title.slice(0, 40),
      visitTime: String(r.visit_time), durationUs: String(r.visit_duration),
    }));
    db.close();
    report.liveReadOk = true;
  } catch (e) {
    report.liveReadOk = false;
    report.liveReadError = String(e && e.message || e);
  }

  // 4. Immutable fallback on the same live file
  try {
    const imm = new DatabaseSync(`file:${HIST}?immutable=1`, { readOnly: true });
    const immCount = imm.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    report.immutableVisitCount = immCount;
    report.immutableReadOk = immCount > 0;
    imm.close();
  } catch (e) { report.immutableReadOk = false; report.immutableError = String(e && e.message || e); }

  // 5. WAL: two OS processes writing the same DB concurrently
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "selfos-wal-"));
  const dbPath = path.join(tmp, "wal.sqlite");
  const writerSrc = path.join(tmp, "writer.cjs");
  fs.writeFileSync(writerSrc, `
    const { DatabaseSync } = require("node:sqlite");
    const [dbPath, id, n] = process.argv.slice(2);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    const ins = db.prepare("INSERT INTO ev(pid, n) VALUES (?, ?)");
    let ok = 0, busy = 0, lastErr = null;
    // node:sqlite has no db.transaction() helper — explicit BEGIN/COMMIT/ROLLBACK.
    for (let i = 0; i < Number(n); i++) {
      try {
        db.exec("BEGIN IMMEDIATE");
        for (let k = 0; k < 10; k++) ins.run(id, i * 10 + k);
        db.exec("COMMIT");
        ok++;
      } catch (e) { try { db.exec("ROLLBACK"); } catch {} busy++; lastErr = e.message; }
    }
    console.log(JSON.stringify({ id, ok, busy, lastErr }));
    db.close();
  `);
  {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ev (id INTEGER PRIMARY KEY, pid TEXT, n INTEGER);");
    db.close();
  }
  const run = (id) => new Promise((res) => {
    const p = spawn(process.execPath, [writerSrc, dbPath, id, "400"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out: out.trim() }));
  });
  const t = process.hrtime.bigint();
  const runs = await Promise.all([run("a"), run("b"), run("c")]);
  report.walConcurrentMs = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
  report.walWriters = runs.map((r) => { try { return JSON.parse(r.out.split("\n").pop()); } catch { return { raw: r.out, code: r.code }; } });
  {
    const db = new DatabaseSync(dbPath);
    report.walTotalRows = db.prepare("SELECT COUNT(*) AS n FROM ev").get().n;
    report.walIntegrity = db.prepare("PRAGMA integrity_check").get();
    db.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  fs.writeFileSync(path.join(OUT, "SP-1.json"), JSON.stringify(report, null, 2));
  console.log("SP-1_RESULT " + JSON.stringify(report));
  app.quit();
});
