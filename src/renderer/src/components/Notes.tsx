import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BookView, NoteHitView, NotesStatusView } from "../../../shared/api";
import { formatRelative } from "../../../shared/format";
import { stripFrontmatter } from "../../../shared/frontmatter";
import {
  type InlineToken,
  isExternalHref,
  isSafeHref,
  tokenizeInline,
} from "../../../shared/inline-markdown";

/**
 * Render one line's inline markdown.
 *
 * The tokenizer lives in `shared/inline-markdown.ts` so it is unit-testable.
 * Tokens become React elements — never HTML — so there is no injection surface,
 * and a link whose scheme is not allowed renders as plain text.
 */
function Inline({ text }: { text: string }) {
  const tokens = useMemo(() => tokenizeInline(text), [text]);
  return (
    <>
      {tokens.map((t: InlineToken, i: number) => {
        const key = `${i}-${t.kind}`;
        switch (t.kind) {
          case "code":
            return (
              <code key={key} className="md-code">
                {t.text}
              </code>
            );
          case "strong":
            return <strong key={key}>{t.text}</strong>;
          case "em":
            return <em key={key}>{t.text}</em>;
          case "strike":
            return <s key={key}>{t.text}</s>;
          case "link":
            if (!isSafeHref(t.href)) return <span key={key}>{t.text}</span>;
            // A plain `<a href>` is inert: the main process blocks
            // `will-navigate` outside the app origin, so a click did nothing.
            // `target="_blank"` routes through `setWindowOpenHandler`, which is
            // the existing guarded path — it re-checks the scheme and hands the
            // URL to the OS, and always denies creating a window. That avoids a
            // new IPC channel for opening a link.
            return isExternalHref(t.href) ? (
              <a key={key} href={t.href} target="_blank" rel="noreferrer">
                {t.text}
              </a>
            ) : (
              // A relative or in-page link has no page to open from a preview.
              <a
                key={key}
                href={t.href}
                onClick={(e) => e.preventDefault()}
                title="Relative link — not opened from the preview"
              >
                {t.text}
              </a>
            );
          default:
            return <span key={key}>{t.text}</span>;
        }
      })}
    </>
  );
}

/** Minimal markdown renderer: headings, quotes, lists, code, and paragraphs. */
function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => {
    const out: Array<{ kind: string; text: string; level?: number }> = [];
    let fence = false;
    for (const raw of stripFrontmatter(source).split("\n")) {
      if (raw.trim().startsWith("```")) {
        fence = !fence;
        out.push({ kind: "code-line", text: raw.trim() === "```" ? "" : raw });
        continue;
      }
      if (fence) {
        out.push({ kind: "code", text: raw });
        continue;
      }
      const line = raw.trimEnd();
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        out.push({ kind: "heading", text: heading[2] ?? "", level: heading[1]?.length ?? 1 });
        continue;
      }
      if (!line.trim()) {
        out.push({ kind: "gap", text: "" });
        continue;
      }
      if (/^>\s?/.test(line)) {
        out.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
        continue;
      }
      const item = line.match(/^[-*]\s+(.*)$/);
      if (item) {
        out.push({ kind: "item", text: item[1] ?? "" });
        continue;
      }
      out.push({ kind: "para", text: line });
    }
    return out;
  }, [source]);

  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `${i}-${b.kind}`;
        if (b.kind === "heading") {
          return b.level === 1 ? (
            <h1 key={key}>
              <Inline text={b.text} />
            </h1>
          ) : b.level === 2 ? (
            <h2 key={key}>
              <Inline text={b.text} />
            </h2>
          ) : (
            <h3 key={key}>
              <Inline text={b.text} />
            </h3>
          );
        }
        if (b.kind === "quote")
          return (
            <blockquote key={key}>
              <Inline text={b.text} />
            </blockquote>
          );
        if (b.kind === "item")
          return (
            <div key={key} className="md-item">
              • <Inline text={b.text} />
            </div>
          );
        if (b.kind === "code") return <pre key={key}>{b.text}</pre>;
        if (b.kind === "code-line") return null;
        if (b.kind === "gap") return <div key={key} className="md-gap" />;
        return (
          <p key={key}>
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}

function NoteRow({
  hit,
  active,
  onSelect,
  onOpen,
}: {
  hit: NoteHitView;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <div className={`note-row${active ? " active" : ""}`}>
      <button type="button" className="note-row-main" onClick={onSelect}>
        <span className="note-title">{hit.title}</span>
        <span className="note-snippet">{hit.snippet || hit.path}</span>
        <span className="note-meta">
          {hit.path}
          {" · "}
          {formatRelative(hit.modifiedAt)}
        </span>
        {/* F-NOTES-02 requires browsing "by title, tag, and full text". Tags are
            extracted and FTS-indexed, and were carried on every hit, but no row
            ever rendered them — so tag browsing existed only as search text. */}
        {hit.tags.length ? (
          <span className="note-tags">
            {hit.tags.slice(0, 6).map((t) => (
              <span key={t} className="note-tag">
                #{t}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <button type="button" className="note-open" onClick={onOpen} title="Open in Obsidian">
        ↗
      </button>
    </div>
  );
}

function VaultPicker({ status, onPicked }: { status: NotesStatusView; onPicked: () => void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (chosen: string) => {
    if (!chosen) return;
    setBusy(true);
    const res = await window.selfos.invoke("notes.selectVault", { path: chosen });
    setBusy(false);
    if (res.ok) onPicked();
    else setError(res.error);
  };

  return (
    <div className="vault-picker">
      <h2>Notes</h2>
      <p className="muted">
        SelfOS indexes your Obsidian vault for search and links. It never rewrites your notes; the only writes
        are the ones you trigger here.
      </p>
      {status.discovered.length > 0 ? (
        <div className="form-row">
          <span className="muted">Discovered:</span>
          {status.discovered.map((v) => (
            <button key={v.path} type="button" className="primary" onClick={() => void pick(v.path)}>
              {v.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">No vault found in Obsidian's config. Enter the path manually.</p>
      )}
      <div className="form-row">
        <input
          className="input grow"
          placeholder="/home/you/notes"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          aria-label="Vault path"
        />
        <button type="button" className="primary" onClick={() => void pick(path)} disabled={busy || !path}>
          Use this vault
        </button>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
    </div>
  );
}

export function NotesView() {
  const [status, setStatus] = useState<NotesStatusView | null>(null);
  const [hits, setHits] = useState<NoteHitView[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [books, setBooks] = useState<BookView[]>([]);
  const [exportBook, setExportBook] = useState<number | "">("");
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchSeq = useRef(0);

  const loadStatus = useCallback(async () => {
    const res = await window.selfos.invoke("notes.status", undefined);
    // Clear on success: the banner used to survive every later successful
    // capture, export, reindex and selection for the rest of the session.
    if (res.ok) {
      setStatus(res.data);
      setError(null);
    } else setError(res.error);
    return res.ok ? res.data : null;
  }, []);

  const loadList = useCallback(async () => {
    const res = await window.selfos.invoke("notes.list", undefined);
    if (res.ok) {
      setHits(res.data);
      setError(null);
    } else setError(res.error);
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await loadStatus();
      if (s?.vault) await loadList();
      const b = await window.selfos.invoke("reading.list", undefined);
      if (b.ok) setBooks(b.data);
      else setError((prev) => prev ?? `books: ${b.error}`);
    })();
  }, [loadStatus, loadList]);

  // Debounced search; the sequence guard drops responses that arrive out of order.
  useEffect(() => {
    if (!status?.vault) return;
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      if (!query.trim()) {
        await loadList();
        // Share the guard: a slow `notes.list` must not land after a newer
        // search and replace its hits with the full list.
        if (seq !== searchSeq.current) return;
        return;
      }
      const res = await window.selfos.invoke("notes.search", { query });
      if (seq !== searchSeq.current) return;
      if (res.ok) {
        setHits(res.data);
        setError(null);
      } else setError(res.error);
    }, 180);
    return () => clearTimeout(t);
  }, [query, status?.vault, loadList]);

  const openSeq = useRef(0);
  const open = useCallback(async (path: string) => {
    // Two quick selections can land out of order; only the newest may write the
    // body, otherwise note A's content renders under note B's header.
    const seq = ++openSeq.current;
    setSelected(path);
    const res = await window.selfos.invoke("notes.read", { path });
    if (seq !== openSeq.current) return; // a newer selection won
    setContent(res.ok ? (res.data?.content ?? null) : null);
    if (res.ok) setError(null);
    else setError(res.error);
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  };

  const doCapture = async () => {
    if (!capture.trim()) return;
    setBusy(true);
    const res = await window.selfos.invoke("notes.quickCapture", { text: capture });
    setBusy(false);
    if (res.ok) {
      setCapture("");
      flash(`Captured to ${res.data.path}`);
      await loadStatus();
      await loadList();
    } else setError(res.error);
  };

  const doExport = async () => {
    if (exportBook === "") return;
    setBusy(true);
    const res = await window.selfos.invoke("notes.exportHighlights", { bookId: Number(exportBook) });
    setBusy(false);
    if (res.ok) {
      flash(res.data.skipped ? `Already up to date: ${res.data.path}` : `Exported to ${res.data.path}`);
      await loadStatus();
      await loadList();
    } else setError(res.error);
  };

  const doDaily = async () => {
    setBusy(true);
    const res = await window.selfos.invoke("notes.ensureDailyNote", {});
    setBusy(false);
    if (res.ok) {
      flash(res.data.created ? `Created ${res.data.path}` : `Today's note: ${res.data.path}`);
      await loadStatus();
      await loadList();
      await open(res.data.path);
    } else setError(res.error);
  };

  const doReindex = async () => {
    setBusy(true);
    const res = await window.selfos.invoke("notes.reindex", undefined);
    setBusy(false);
    if (res.ok) {
      flash(`Re-indexed ${res.data.count} notes`);
      await loadStatus();
      await loadList();
    } else setError(res.error);
  };

  const disconnect = async () => {
    const res = await window.selfos.invoke("notes.clearVault", undefined);
    if (res.ok) {
      setSelected(null);
      setContent(null);
      setHits([]);
      setStatus(res.data);
      setError(null);
    } else setError(res.error);
  };

  const openInObsidian = async (path: string) => {
    const res = await window.selfos.invoke("notes.open", { path });
    if (res.ok) setError(null);
    else setError(res.error);
  };

  if (!status) {
    // A failed `notes.status` used to leave this on screen forever with the
    // real reason hidden behind it.
    return error ? (
      <div className="error">Notes error: {error}</div>
    ) : (
      <div className="muted">Loading notes…</div>
    );
  }
  if (!status.vault) return <VaultPicker status={status} onPicked={() => void loadStatus().then(loadList)} />;

  return (
    <div className="notes">
      <div className="notes-head">
        <div>
          <h2>{status.vault.name}</h2>
          <div className="muted">
            {status.noteCount} notes indexed
            {status.lastIndexAt ? ` · ${formatRelative(status.lastIndexAt)}` : ""}
            {" · "}
            {status.vault.path}
          </div>
        </div>
        <div className="form-row">
          <button type="button" className="ghost" onClick={() => void doReindex()} disabled={busy}>
            Re-index
          </button>
          <button type="button" className="ghost" onClick={() => void doDaily()} disabled={busy}>
            Today's note
          </button>
          <button type="button" className="ghost" onClick={() => void disconnect()} disabled={busy}>
            Disconnect
          </button>
        </div>
      </div>

      {error ? <div className="error">Notes error: {error}</div> : null}
      {toast ? <div className="toast">{toast}</div> : null}

      <div className="notes-tools">
        <input
          className="input grow"
          type="search"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search notes"
        />
        <input
          className="input grow"
          placeholder="Quick capture to today's note…"
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doCapture();
          }}
          aria-label="Quick capture"
        />
        <button
          type="button"
          className="primary"
          onClick={() => void doCapture()}
          disabled={busy || !capture.trim()}
        >
          Capture
        </button>
      </div>

      <div className="notes-export">
        <span className="muted">Export book highlights:</span>
        <select
          className="input"
          value={exportBook}
          onChange={(e) => setExportBook(e.target.value === "" ? "" : Number(e.target.value))}
          aria-label="Book to export"
        >
          <option value="">Choose a book…</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ghost"
          onClick={() => void doExport()}
          disabled={busy || exportBook === ""}
        >
          Export
        </button>
      </div>

      <div className="notes-body">
        <div className="notes-list">
          {hits.length === 0 ? (
            <div className="empty">
              {query ? "No notes match that search." : "This vault has no notes yet."}
            </div>
          ) : (
            hits.map((h) => (
              <NoteRow
                key={h.path}
                hit={h}
                active={h.path === selected}
                onSelect={() => void open(h.path)}
                onOpen={() => void openInObsidian(h.path)}
              />
            ))
          )}
        </div>

        <div className="notes-preview">
          {content === null ? (
            <div className="empty">Select a note to preview it.</div>
          ) : (
            <>
              <div className="notes-preview-head">
                <span className="muted">{selected}</span>
                {selected ? (
                  <button type="button" className="ghost" onClick={() => void openInObsidian(selected)}>
                    Open in Obsidian ↗
                  </button>
                ) : null}
              </div>
              <Markdown source={content} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
