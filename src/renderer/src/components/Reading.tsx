import { useCallback, useEffect, useState } from "react";
import type { BookView } from "../../../shared/api";
import { formatRelative } from "../../../shared/format";
import { Reader } from "./Reader";

export function ReadingView() {
  const [books, setBooks] = useState<BookView[]>([]);
  const [openBook, setOpenBook] = useState<BookView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  /** Returns the fetched rows so callers that just imported do not re-fetch. */
  const load = useCallback(async (): Promise<BookView[]> => {
    const res = await window.selfos.invoke("reading.list", undefined);
    if (res.ok) {
      setBooks(res.data);
      setError(null);
      return res.data;
    }
    setError(res.error);
    return [];
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const importBook = async () => {
    setImporting(true);
    // The picker lives in the main process; only the chosen path crosses IPC.
    const picked = await window.selfos.invoke("reading.pickBook", undefined);
    setImporting(false);
    if (!picked.ok) {
      setError(picked.error);
      return;
    }
    if (!picked.data) return;
    const res = await window.selfos.invoke("reading.import", { path: picked.data });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const rows = await load();
    const created = rows.find((b) => b.id === res.data.id);
    if (created) setOpenBook(created);
  };

  if (openBook) {
    return (
      <Reader
        book={openBook}
        onBack={() => {
          setOpenBook(null);
          void load();
        }}
      />
    );
  }

  // `percent` is page/pageCount, so only the last page counts as finished —
  // 999/1000 used to land in the finished group with a page still unread.
  const reading = books.filter((b) => b.percent > 0 && b.percent < 1);
  const unread = books.filter((b) => b.percent === 0);
  const finished = books.filter((b) => b.percent >= 1);

  const card = (b: BookView) => (
    <button type="button" key={b.id} className="book-card" onClick={() => setOpenBook(b)}>
      <div className="book-spine" aria-hidden="true">
        {b.title.slice(0, 1).toUpperCase()}
      </div>
      <div className="book-body">
        <div className="book-title" title={b.title}>
          {b.title}
        </div>
        {/* F-READ-02 requires the library to show the author when the file's
            metadata has one. It was carried through the whole contract and
            never rendered — and, worse, never captured: the import path wrote
            NULL. Both halves are now wired (see BookStore.setPageCount). */}
        {b.author ? <div className="book-author">{b.author}</div> : null}
        <div className="book-meta">
          {b.pageCount > 0 ? `${b.pageCount} pages` : "page count pending"} · {b.highlightCount} highlights
        </div>
        <div className="book-progress">
          <div className="book-progress-bar" style={{ width: `${Math.round(b.percent * 100)}%` }} />
        </div>
        <div className="book-meta">
          {b.percent > 0 ? `${Math.round(b.percent * 100)}%` : "not started"} · last read{" "}
          {formatRelative(b.lastReadAt, { coarse: true })}
        </div>
      </div>
    </button>
  );

  return (
    <div className="reading">
      <div className="reading-head">
        <div>
          <h2>Library</h2>
          <div className="muted">
            {books.length} book{books.length === 1 ? "" : "s"}
          </div>
        </div>
        <button type="button" className="primary" onClick={() => void importBook()} disabled={importing}>
          {importing ? "Choosing…" : "Import PDF"}
        </button>
      </div>

      {error ? <div className="error">Library error: {error}</div> : null}

      {books.length === 0 ? (
        <div className="empty">
          No books yet. Import a PDF to start reading, highlighting, and tracking your progress.
        </div>
      ) : null}

      {reading.length > 0 ? (
        <>
          <h3 className="section-label">Continue reading</h3>
          <div className="book-grid">{reading.map(card)}</div>
        </>
      ) : null}

      {unread.length > 0 ? (
        <>
          <h3 className="section-label">Unread</h3>
          <div className="book-grid">{unread.map(card)}</div>
        </>
      ) : null}

      {finished.length > 0 ? (
        <>
          <h3 className="section-label">Finished</h3>
          <div className="book-grid">{finished.map(card)}</div>
        </>
      ) : null}
    </div>
  );
}
