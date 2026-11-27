import { useCallback, useEffect, useRef, useState } from "react";
import type { IngestSummaryView, PageUsageView, SitesView as SitesData } from "../../../shared/api";
import { formatDuration } from "../../../shared/format";

const CATEGORIES = [
  "Work",
  "Learning",
  "Reference",
  "Communication",
  "Entertainment",
  "Social",
  "Shopping",
  "News",
  "Uncategorized",
];

/** Provenance is part of the number, not a footnote (F-TIME-05, D-05). */
function sourceLabel(s: "history" | "window-title" | "mixed"): string {
  if (s === "history") return "history";
  if (s === "window-title") return "window title";
  return "history + title";
}

function SiteRow({
  site,
  max,
  onOpen,
  onCategorize,
}: {
  site: SitesData["sites"][number];
  max: number;
  onOpen: () => void;
  onCategorize: (category: string) => void;
}) {
  return (
    <div className="site-row">
      {/* The row button and the category <select> are siblings: a control
          cannot be nested inside a button (invalid HTML, and keyboard
          activation of the select would also fire the row's onClick). */}
      <button type="button" className="site-main" onClick={onOpen}>
        <span className="site-domain">{site.domain}</span>
        <span className="site-bar">
          <span
            style={{ width: `${max > 0 ? (site.seconds / max) * 100 : 0}%` }}
            className={site.distracting ? "distracting" : ""}
          />
        </span>
        <span className="site-time">{formatDuration(site.seconds)}</span>
        <span className={`pill source-${site.source}`} title={`seconds from ${sourceLabel(site.source)}`}>
          {sourceLabel(site.source)}
        </span>
      </button>
      <select
        className="input site-category"
        value={site.category}
        onChange={(e) => onCategorize(e.target.value)}
        aria-label={`Category for ${site.domain}`}
      >
        {[...new Set([site.category, ...CATEGORIES])].map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SitesView({ localDate }: { localDate: string }) {
  const [data, setData] = useState<SitesData | null>(null);
  const [pages, setPages] = useState<PageUsageView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [ingest, setIngest] = useState<IngestSummaryView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, last] = await Promise.all([
      window.selfos.invoke("sites.day", { localDate }),
      window.selfos.invoke("sites.lastIngest", undefined),
    ]);
    // One message per load, committed once: setting on failure and never
    // clearing left the banner up after a later load succeeded.
    const failure = !s.ok ? s.error : !last.ok ? `ingest status: ${last.error}` : null;
    if (s.ok) setData(s.data);
    if (last.ok) setIngest(last.data);
    setError(failure);
  }, [localDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSeq = useRef(0);
  const openDomain = async (domain: string) => {
    // Two quick clicks can resolve out of order; only the newest selection may
    // write the page list, or domain A's pages render under domain B's header.
    const seq = ++openSeq.current;
    setSelected(domain);
    const res = await window.selfos.invoke("sites.pages", { domain, localDate });
    if (seq !== openSeq.current) return;
    setPages(res.ok ? res.data : []);
    if (res.ok) setError(null);
    else setError(res.error);
  };

  // Category writes and the reload they trigger are serialized. Two quick
  // changes used to overlap: both `sites.categorize` calls ran, then both
  // `sites.day` reads ran, and whichever read resolved last won. The `<select>`
  // is driven by the server value, so an out-of-order read could leave the
  // dropdown showing a category the database no longer holds, with no later
  // load to correct it.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const categorize = (domain: string, category: string) => {
    writeChain.current = writeChain.current
      .then(async () => {
        const res = await window.selfos.invoke("sites.categorize", { domain, category });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        await load();
      })
      // A rejected link would poison the chain and skip every later write.
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const runIngest = async () => {
    setBusy(true);
    const res = await window.selfos.invoke("sites.ingest", undefined);
    setBusy(false);
    if (res.ok) {
      setIngest(res.data);
      await load();
    } else setError(res.error);
  };

  const sites = data?.sites ?? [];
  const max = Math.max(1, ...sites.map((s) => s.seconds));
  // Browser-open time, not the sum of the rows below it: several tabs can be
  // open at once, so the rows overlap by design.
  const totalSiteSeconds = data?.totals.webSeconds ?? 0;

  return (
    <div className="sites">
      <div className="habits-head">
        <div>
          <div className="page-sub">
            {data
              ? `${sites.length} sites · ${formatDuration(totalSiteSeconds)} web time · ${formatDuration(data.watch.seconds)} watch`
              : "loading…"}
          </div>
        </div>
        <button type="button" className="ghost" onClick={() => void runIngest()} disabled={busy}>
          {busy ? "Reading history…" : "Ingest history now"}
        </button>
      </div>

      {error ? <div className="error">Sites error: {error}</div> : null}

      {ingest.length > 0 ? (
        <div className="ingest-line">
          {ingest.map((i) => (
            <span key={i.profileDir} className="muted">
              {i.profileDir}: {i.error ? `error — ${i.error}` : `${i.rowsNew} new`} ({i.strategy})
            </span>
          ))}
        </div>
      ) : null}

      {sites.length === 0 ? (
        <div className="empty">
          No browser history for this day yet. Site time comes from a read-only snapshot of the browser's
          history database; nothing is copied into the app.
        </div>
      ) : (
        <section className="panel">
          <h2>Site time</h2>
          <p className="panel-note">
            Times can overlap: a background tab still counts, so the rows below may add up to more than the
            browser-open total.
          </p>
          <div className="site-list">
            {sites.map((s) => (
              <SiteRow
                key={s.domain}
                site={s}
                max={max}
                onOpen={() => void openDomain(s.domain)}
                onCategorize={(c) => void categorize(s.domain, c)}
              />
            ))}
          </div>
        </section>
      )}

      {data && data.categories.length > 0 ? (
        <section className="panel">
          <h2>Categories</h2>
          <p className="panel-note">
            Share of browser-open time. Categories can overlap for the same reason.
          </p>
          <div className="category-list">
            {data.categories.map((c) => (
              <div key={c.category} className="category-row">
                <span className={c.distracting ? "category-name distracting" : "category-name"}>
                  {c.category}
                </span>
                <span className="app-bar">
                  <span
                    style={{
                      width: `${c.share * 100}%`,
                      background: c.distracting ? "var(--c-red, #ea6962)" : "var(--accent)",
                    }}
                  />
                </span>
                <span className="app-time">{formatDuration(c.seconds)}</span>
                <span className="app-share">{Math.round(c.share * 100)}%</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {data && data.watch.bySite.length > 0 ? (
        <section className="panel">
          <h2>Watch time</h2>
          <div className="top-apps">
            {data.watch.bySite.map((w) => (
              <div key={w.domain} className="app-row">
                <span className="app-dot" style={{ background: "var(--c-red, #ea6962)" }} />
                <span className="app-name">{w.domain}</span>
                <span className="app-bar">
                  <span
                    style={{
                      width: `${(w.seconds / Math.max(1, data.watch.seconds)) * 100}%`,
                      background: "var(--c-red, #ea6962)",
                    }}
                  />
                </span>
                <span className="app-time">{formatDuration(w.seconds)}</span>
                <span className="app-share">{w.visits}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {selected ? (
        <section className="panel">
          <div className="panel-head">
            <h2>{selected}</h2>
            <button type="button" className="ghost" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          {pages && pages.length > 0 ? (
            <table>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.url}>
                    <td className="page-cell">
                      <span className="page-title">{p.title || p.url}</span>
                      <span className="muted page-url">{p.url}</span>
                    </td>
                    <td>{formatDuration(p.seconds)}</td>
                    <td>{p.visits}×</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted">No pages recorded for {selected} on this day.</div>
          )}
        </section>
      ) : null}
    </div>
  );
}
