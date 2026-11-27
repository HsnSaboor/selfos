import { useCallback, useEffect, useState } from "react";
import type { BackupStatusView as BackupStatus, HealthReport, SystemSettingsView } from "../../../shared/api";
import { DELETE_MODULES } from "../../../shared/api";
import { formatBytes, formatDateTime } from "../../../shared/format";

/**
 * A `Result` that may also carry a success message.
 *
 * The message only exists on the success branch, so a failure cannot be given
 * one by mistake.
 */
type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export function DataPage() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  /** Needed only for `restoredFrom`; see the banner below. */
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [tables, setTables] = useState<Array<{ name: string; rows: number }>>([]);
  const [table, setTable] = useState("day_aggregate");
  const [settings, setSettings] = useState<SystemSettingsView | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [libraryDir, setLibraryDir] = useState("");
  const [backupDir, setBackupDir] = useState("");
  const [excluded, setExcluded] = useState("");
  const [delModule, setDelModule] = useState("time");
  const [delFrom, setDelFrom] = useState("");
  const [delTo, setDelTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [b, t, h, s, a] = await Promise.all([
      window.selfos.invoke("backup.status", undefined),
      window.selfos.invoke("data.tables", undefined),
      window.selfos.invoke("system.health", undefined),
      window.selfos.invoke("system.settings", undefined),
      window.selfos.invoke("system.autostart", undefined),
    ]);
    // One message per load, committed once: setting on failure and never
    // clearing left the banner up after a later load succeeded.
    const failure = !b.ok ? b.error : !t.ok ? `tables: ${t.error}` : null;
    if (b.ok) setStatus(b.data);
    if (t.ok) setTables(t.data);
    // A failed health read is not worth a second banner: the page's own data
    // loaded, and the restore notice simply does not appear.
    if (h.ok) setHealth(h.data);
    if (s.ok) {
      setSettings(s.data);
      setLibraryDir(s.data.libraryDir);
      setBackupDir(s.data.backupDir);
      setExcluded(s.data.excludedApps.join(", "));
    }
    if (a.ok) setAutostart(a.data.enabled);
    setError(failure);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run an action and show its outcome.
   *
   * The outcome is the bridge's `Result` (so `ok: true` cannot carry an error)
   * plus an optional message: some actions produce a value (the integrity check
   * returns `{ integrity, at }`) rather than a fixed confirmation, and the
   * previous signature silently overwrote it with the static label.
   */
  const run = async (label: string, fn: () => Promise<ActionResult>) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.ok) {
      setMessage(res.message ?? label);
      setError(null);
      await load();
    } else setError(res.error);
  };

  return (
    <div className="data-view">
      {/* A staged restore is applied on the *next* launch, so by the time this
          page can be shown it has already replaced the database. Without this
          notice the first sign was missing history and no way to tell what
          happened or where the previous contents went. */}
      {health?.restoredFrom ? (
        <div className="notice">
          A backup was restored on this launch. The database it replaced was kept at{" "}
          <code>{health.restoredFrom}</code>.
        </div>
      ) : null}
      <div className="habits-head">
        <div>
          <div className="page-sub">
            {status ? status.directory : ""}
            {status?.lastBackupAt ? ` · last backup ${formatDateTime(status.lastBackupAt)}` : ""}
          </div>
        </div>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() =>
            void run("Backup created", () => window.selfos.invoke("backup.create", { kind: "manual" }))
          }
        >
          Back up now
        </button>
      </div>

      {error ? <div className="error">Data error: {error}</div> : null}
      {message ? <div className="toast">{message}</div> : null}

      {/* F-SET-07 requires a health page with a rebuild action and an on-demand
          integrity check. Both channels existed but nothing in the UI reached
          them, so a corrupt aggregate could only be repaired by restarting. */}
      <section className="panel">
        <h2>Maintenance</h2>
        <p className="muted panel-note">
          Derived data (daily aggregates) can always be rebuilt from the raw events. The integrity check is
          skipped on the dashboard poll because it takes seconds on a large database.
        </p>
        <div className="form-row">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void run("Derived data rebuilt", () => window.selfos.invoke("time.rebuild", {}))}
          >
            Rebuild today
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Derived data rebuilt", () => window.selfos.invoke("system.rebuildAll", undefined))
            }
          >
            Rebuild every day
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Integrity check finished", async () => {
                const res = await window.selfos.invoke("system.checkIntegrity", undefined);
                return res.ok
                  ? { ok: true, message: `integrity: ${res.data.integrity}` }
                  : { ok: false, error: res.error };
              })
            }
          >
            Check integrity
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Settings</h2>
        <p className="muted panel-note">
          Folders and the excluded-app list apply immediately. The data folder is chosen by the system at
          launch and cannot be moved here.
        </p>
        <div className="form-row">
          <label className="check">
            <input
              type="checkbox"
              checked={autostart}
              onChange={(e) => {
                const enabled = e.target.checked;
                void run(enabled ? "Start on login enabled" : "Start on login disabled", () =>
                  window.selfos.invoke("system.setAutostart", { enabled }),
                );
              }}
            />
            Start SelfOS on login (to the tray)
          </label>
        </div>
        <div className="form-row">
          <input
            className="input"
            value={libraryDir}
            onChange={(e) => setLibraryDir(e.target.value)}
            aria-label="Library folder"
          />
          <input
            className="input"
            value={backupDir}
            onChange={(e) => setBackupDir(e.target.value)}
            aria-label="Backup folder"
          />
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Settings saved", () =>
                window.selfos.invoke("system.setSettings", { libraryDir, backupDir }),
              )
            }
          >
            Save folders
          </button>
        </div>
        <div className="form-row">
          <input
            className="input"
            value={excluded}
            onChange={(e) => setExcluded(e.target.value)}
            aria-label="Excluded app classes"
            placeholder="comma-separated app classes"
          />
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Excluded apps saved", () =>
                window.selfos.invoke("system.setSettings", {
                  excludedApps: excluded
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              )
            }
          >
            Save excluded apps
          </button>
        </div>
        {settings ? (
          <p className="muted panel-note">
            Data folder: <code>{settings.dataDir}</code>
            {settings.vaultDir ? (
              <>
                {" · "}Vault: <code>{settings.vaultDir}</code>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Delete data</h2>
        <p className="muted panel-note">
          Deletes one module's rows in a date range. Notes are never touched: the vault holds your own files.
          This cannot be undone.
        </p>
        <div className="form-row">
          <select
            className="input"
            value={delModule}
            onChange={(e) => setDelModule(e.target.value)}
            aria-label="Module to delete"
          >
            {Object.keys(DELETE_MODULES).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="date"
            value={delFrom}
            onChange={(e) => setDelFrom(e.target.value)}
            aria-label="From date"
          />
          <input
            className="input"
            type="date"
            value={delTo}
            onChange={(e) => setDelTo(e.target.value)}
            aria-label="To date"
          />
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Delete all ${delModule} data from ${delFrom || "the beginning"} to ${delTo || "now"}?`,
                )
              )
                return;
              void run(`${delModule} data deleted`, () =>
                window.selfos.invoke("data.deleteRange", {
                  module: delModule,
                  from: delFrom || null,
                  to: delTo || null,
                  confirm: true,
                }),
              );
            }}
          >
            Delete range
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Backups</h2>
        <p className="muted panel-note">
          Daily copies are kept for 14 days and weekly copies for 8 weeks. Manual backups are never pruned.
        </p>
        {status && status.files.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Kind</th>
                <th>Size</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {status.files.map((f) => (
                <tr key={f.name}>
                  <td>{f.name}</td>
                  <td>
                    <span className={`pill ${f.kind}`}>{f.kind}</span>
                  </td>
                  <td>{formatBytes(f.bytes)}</td>
                  <td>{formatDateTime(f.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm(`Restore ${f.name}? The current database is copied aside first.`))
                          return;
                        void run(`${f.name} staged — restart SelfOS to apply`, () =>
                          window.selfos.invoke("backup.restore", { name: f.name }),
                        );
                      }}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No backups yet.</div>
        )}
      </section>

      <section className="panel">
        <h2>Export</h2>
        <div className="form-row">
          <select
            className="input"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            aria-label="Table to export"
          >
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.rows} rows)
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run(`Exported ${table}.csv`, () => window.selfos.invoke("data.exportCsv", { table }))
            }
          >
            Export table as CSV
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() =>
              void run("Exported full database as JSON", () =>
                window.selfos.invoke("data.exportJson", undefined),
              )
            }
          >
            Export everything as JSON
          </button>
        </div>
        <p className="muted panel-note">
          Exports are written next to the backups, under <code>exports/</code>.
        </p>
      </section>

      <section className="panel">
        <h2>Tables</h2>
        <table>
          <tbody>
            {tables.map((t) => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td>{t.rows.toLocaleString()} rows</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
