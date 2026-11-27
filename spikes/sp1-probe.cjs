// Focused probe: can we read the live Helium History DB with node:sqlite?
// Tests open modes, busy_timeout placement, retries, and immutable URIs.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const HIST = path.join(os.homedir(), ".config/net.imput.helium/Default/History");

function attempt(label, fn) {
  const t = process.hrtime.bigint();
  try {
    const v = fn();
    return { label, ok: true, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e6 * 100) / 100, value: v };
  } catch (e) {
    return { label, ok: false, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e6 * 100) / 100, error: e.message, code: e.code };
  }
}

app.whenReady().then(() => {
  const results = [];
  const stat = fs.statSync(HIST);
  results.push({ fileSizeMB: Math.round(stat.size / 1048576), journalFiles: fs.readdirSync(path.dirname(HIST)).filter((f) => /^History-(journal|wal|shm)$/.test(f)) });

  // A: plain readOnly
  results.push(attempt("A: readOnly open + count", () => {
    const db = new DatabaseSync(HIST, { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    db.close();
    return n;
  }));

  // B: readOnly + busy_timeout set immediately after open, then retry count
  results.push(attempt("B: readOnly + busy_timeout then count", () => {
    const db = new DatabaseSync(HIST, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    db.close();
    return n;
  }));

  // C: readOnly + busy_timeout + retry loop
  results.push(attempt("C: readOnly + busy_timeout + retries", () => {
    const db = new DatabaseSync(HIST, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM visits");
    for (let i = 0; i < 5; i++) {
      try { const n = stmt.get().n; db.close(); return { n, tries: i + 1 }; }
      catch (e) { if (i === 4) { db.close(); throw e; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
    }
  }));

  // D: immutable URI (what the sqlite3 CLI used successfully)
  results.push(attempt("D: immutable URI", () => {
    const db = new DatabaseSync(`file:${HIST}?immutable=1`, { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    db.close();
    return n;
  }));

  // E: plain open (read-write) — does node:sqlite bypass the lock differently?
  results.push(attempt("E: default open + count", () => {
    const db = new DatabaseSync(HIST);
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    db.close();
    return n;
  }));

  // F: copy to tmp then read (baseline: proves it is a locking issue, not a format issue)
  results.push(attempt("F: copy then readOnly", () => {
    const tmp = path.join(os.tmpdir(), `hist-${process.pid}.sqlite`);
    fs.copyFileSync(HIST, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const n = db.prepare("SELECT COUNT(*) AS n FROM visits").get().n;
    db.close();
    fs.rmSync(tmp, { force: true });
    return n;
  }));

  // G: BigInt precision on the copy path
  results.push(attempt("G: BigInt precision", () => {
    const tmp = path.join(os.tmpdir(), `hist2-${process.pid}.sqlite`);
    fs.copyFileSync(HIST, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const s = db.prepare("SELECT visit_time FROM visits ORDER BY visit_time DESC LIMIT 1");
    s.setReadBigInts(true);
    const raw = s.get().visit_time;
    const asNum = Number(raw);
    db.close();
    fs.rmSync(tmp, { force: true });
    return {
      bigint: String(raw),
      exceedsMaxSafe: raw > BigInt(Number.MAX_SAFE_INTEGER),
      numberValue: asNum,
      lossy: BigInt(asNum) !== raw,
    };
  }));

  console.log("PROBE_RESULT " + JSON.stringify(results, null, 2));
  app.quit();
});
