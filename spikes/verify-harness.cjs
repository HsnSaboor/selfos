// Shared verifier harness (round 17).
//
// Every verify-*.cjs used to re-declare the same ~20 lines: the output dir,
// the report object, step(), sleep() and finish(). Keep one copy here; a
// verifier keeps only its assertions.
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

function createHarness(spike, resultFile, resultTag) {
  const report = { spike, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    console.log(`STEP ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const finish = () => {
    report.passed = report.steps.filter((s) => s.ok).length;
    report.failed = report.steps.filter((s) => !s.ok).length;
    fs.writeFileSync(path.join(OUT, resultFile), JSON.stringify(report, null, 2));
    console.log(`${resultTag}_RESULT ` + JSON.stringify({ passed: report.passed, failed: report.failed }));
    console.log(`${resultTag}_EXIT failed=${report.failed}`);
    process.exit(report.failed ? 1 : 0);
  };
  return { OUT, report, step, sleep, finish };
}

module.exports = { OUT, createHarness };