/**
 * Browser-history ingest worker (STACK §4.1, §5.3 step 8, N-PERF-04).
 *
 * `DatabaseSync` and `copyFileSync` are synchronous. Running them in the main
 * process blocks the event loop that also serves every IPC call, so an hourly
 * ingest against a 433 MB history file froze the UI for seconds at a time —
 * including while the user was reading. STACK requires this work in a worker
 * thread.
 *
 * The worker opens its own connection to the same database. WAL mode makes
 * that safe: the worker is the only writer during ingest, and the main process
 * keeps reading. SQLite's busy_timeout absorbs the moments when the two
 * contend.
 *
 * Protocol: the parent posts `{ type: "ingest", dbPath, snapshotDir, profiles,
 * maxRows }`; the worker replies `{ type: "result", results }` or
 * `{ type: "error", message }`. One message in, one message out — the parent
 * serializes runs, so the worker never has to handle concurrency.
 */
import { parentPort } from "node:worker_threads";
import { Db } from "../../db/driver";
import { BrowserHistoryIngest, type IngestResult, type ProfileConfig } from "./ingest";

export interface IngestRequest {
  type: "ingest";
  dbPath: string;
  snapshotDir: string;
  profiles: ProfileConfig[];
}

export type IngestReply = { type: "result"; results: IngestResult[] } | { type: "error"; message: string };

function handle(req: IngestRequest): IngestReply {
  let db: Db | null = null;
  try {
    db = Db.open(req.dbPath);
    const ingest = new BrowserHistoryIngest({
      db,
      snapshotDir: req.snapshotDir,
    });
    return { type: "result", results: ingest.ingestAll(req.profiles) };
  } catch (err) {
    return { type: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    // The worker stays alive for the next run; closing here releases the file
    // handle so a backup or a schema change is not blocked between runs.
    db?.close();
  }
}

parentPort?.on("message", (req: IngestRequest) => {
  if (req?.type !== "ingest") {
    parentPort?.postMessage({ type: "error", message: "unknown request" } satisfies IngestReply);
    return;
  }
  parentPort?.postMessage(handle(req) satisfies IngestReply);
});
