import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ANCHOR_VERSION,
  isOrphaned,
  resolveAnchor,
  type TextItem,
  toNormalized,
} from "../../../shared/anchors";
import {
  type BookSettingsView,
  type BookView,
  HIGHLIGHT_COLORS,
  type HighlightView,
} from "../../../shared/api";
import { scrollFraction as fractionOf, scrollTopFor } from "../../../shared/scroll";

/**
 * PDF reader.
 *
 * pdf.js is loaded as a module from the packaged `selfos-app://app/pdfjs/` assets so the
 * worker can be configured explicitly. Pages render on demand with a bounded
 * page list (F-READ-15); display overrides are applied as CSS/canvas filters on
 * the original page rather than reflowing text (PRD F-READ-04).
 */

type PdfDocument = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: { Title?: string; Author?: string } }>;
  destroy(): Promise<void>;
};
type PdfPage = {
  getViewport(p: { scale: number; rotation?: number }): {
    width: number;
    height: number;
    transform: number[];
    rotation: number;
  };
  render(p: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<{ str: string; transform: number[]; width: number }> }>;
  cleanup(): void;
};

interface PdfDocumentSource {
  url: string;
  /** Runtime asset directories pdf.js fetches codecs, cmaps, and fonts from. */
  wasmUrl?: string;
  cMapUrl?: string;
  standardFontDataUrl?: string;
  iccUrl?: string;
}

interface PdfJs {
  getDocument(src: string | PdfDocumentSource): { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
  Util: { transform(a: number[], b: number[]): number[] };
}

let pdfjsPromise: Promise<PdfJs> | null = null;

/**
 * One open document per book, shared across effect runs.
 *
 * React StrictMode invokes mount effects twice. Opening the same PDF twice
 * leaves two live documents against one pdf.js worker, and rendering while a
 * second document exists stalls indefinitely (measured). Caching the load
 * promise means the second run reuses the first document instead.
 */
const documentCache = new Map<number, Promise<PdfDocument>>();

/**
 * How many open documents to keep. Each live `PDFDocumentProxy` pins its page
 * operator lists and decoded images in the worker, and this process is the one
 * `earlyoom` prefers (STACK S1), so the cache is bounded rather than unbounded
 * (F-READ-15). Two covers "recently read" without holding a whole library.
 */
const MAX_OPEN_DOCUMENTS = 2;

/**
 * Store a load promise, evicting and destroying the least-recently-used document
 * beyond the bound — never the one being read.
 *
 * The just-inserted book is never the eviction victim: it is the one being read.
 * That is `bookId` itself — the third parameter this used to take was always
 * passed the same value at the only call site, so it carried no information.
 * The cache is re-inserted on use so recency is real.
 */
function cacheDocument(bookId: number, pending: Promise<PdfDocument>): void {
  documentCache.set(bookId, pending);
  while (documentCache.size > MAX_OPEN_DOCUMENTS) {
    const victim = [...documentCache.keys()].find((id) => id !== bookId);
    if (victim === undefined) break;
    const evicted = documentCache.get(victim);
    documentCache.delete(victim);
    void evicted?.then((d) => d.destroy()).catch(() => undefined);
  }
}

/**
 * pdf.js is served as a static asset, so it is loaded by URL at runtime rather
 * than bundled. The specifier is dynamic to keep Vite from trying to resolve it
 * at build time.
 *
 * In dev the page lives on the Vite origin, so the assets must come from that
 * same origin (a Worker cannot cross origins); the config copies them into the
 * dev server's public root. In production the page is `selfos-app://app/`, so
 * the assets are served from the same scheme.
 */
const PDFJS_BASE = import.meta.env.DEV ? "" : "selfos-app://app/pdfjs";
const PDFJS_URL = `${PDFJS_BASE}/pdf.mjs`;
const PDFJS_WORKER_URL = `${PDFJS_BASE}/pdf.worker.mjs`;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    const specifier = PDFJS_URL;
    pdfjsPromise = import(/* @vite-ignore */ specifier).then((m: unknown) => {
      const api = m as PdfJs;
      api.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return api;
    });
  }
  return pdfjsPromise;
}

/**
 * Matrix helper for placing text-layer spans.
 *
 * `Util` is a pure function of two matrices, so it is safe to take from the
 * module the document was loaded from. Importing pdf.js again here would create
 * a *second* module instance — a second worker — and rendering with two pdf.js
 * instances loaded deadlocks (measured: `page.render()` never resolves).
 */
async function getUtilTransform(): Promise<(a: number[], b: number[]) => number[]> {
  const pdfjs = await loadPdfJs();
  return (a, b) => pdfjs.Util.transform(a, b);
}

/**
 * Scroll position as a 0..1 fraction of the scrollable range.
 *
 * See `shared/scroll.ts`: it divides by the range rather than `scrollHeight`,
 * so the bottom of the page stores 1 and a container that cannot scroll stores
 * 0.
 */
function scrollFraction(wrap: HTMLElement): number {
  return fractionOf(wrap.scrollTop, wrap.scrollHeight, wrap.clientHeight);
}

/**
 * Run a callback with `requestAnimationFrame` replaced by a timer.
 *
 * pdf.js drives its operator loop through rAF (see `useRequestAnimationFrame` in
 * pdf.mjs), and rAF is not dependable on this compositor. It stalls to zero
 * ticks in an **unfocused** window and under **software rendering**
 * (`--disable-gpu --disable-software-rasterizer`), sometimes at once and
 * sometimes after a few frames. When it stalls, `page.render()` never resolves:
 * the canvas stays blank and the text layer never appears.
 *
 * Measured: with this substitution removed, a GPU-disabled verifier run builds
 * the canvas but ends with **0 text spans**; with it, the same run passes. The
 * verifier's own window is unmapped, but the reader still runs through this path,
 * so the workaround is load-bearing rather than defensive.
 *
 * A timer tick cannot stall, so the render always completes. The swap is scoped
 * to the render call and always restored, so animations elsewhere still use the
 * real rAF.
 */
async function withRenderClock<T>(fn: () => Promise<T>): Promise<T> {
  const real = window.requestAnimationFrame;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof window.requestAnimationFrame;
  try {
    return await fn();
  } finally {
    window.requestAnimationFrame = real;
  }
}

/**
 * Highlight colours, taken from the Omarchy palette tokens (`--c-*`).
 *
 * These were literal Gruvbox rgba values with a "pink" key that is not a token
 * (the palette calls it `magenta`), so highlights kept their old colours when
 * the desktop theme changed (F-SET-08). `color-mix` applies the same 45%
 * opacity the literals had, while still following the theme.
 */
// Shared with the IPC validator, so a colour offered here is one the handler
// accepts. It was a local literal before, and the handler had no list at all.
const COLORS = HIGHLIGHT_COLORS;

function colorValue(name: string): string {
  // `pink` was stored by an earlier build; the palette token is `magenta`.
  const normalized = name === "pink" ? "magenta" : name;
  const token = COLORS.includes(normalized as (typeof COLORS)[number]) ? normalized : "yellow";
  return `color-mix(in srgb, var(--c-${token}, #d8a657) 45%, transparent)`;
}

function pageFilter(s: BookSettingsView): string {
  const parts: string[] = [];
  if (s.invert) parts.push("invert(1)", "hue-rotate(180deg)");
  if (s.brightness !== 1) parts.push(`brightness(${s.brightness})`);
  if (s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
  return parts.length ? parts.join(" ") : "none";
}

function surfaceColor(bg: BookSettingsView["pageBackground"]): string {
  switch (bg) {
    case "dark":
      return "#1e1e1e";
    case "black":
      return "#000";
    case "sepia":
      return "#f4ecd8";
    default:
      return "transparent";
  }
}

export function Reader({ book, onBack }: { book: BookView; onBack: () => void }) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(book.page || 1);
  const [settings, setSettings] = useState<BookSettingsView>(book.settings);
  const [highlights, setHighlights] = useState<HighlightView[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState<string | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [activeColor, setActiveColor] = useState<string>("yellow");
  const [pendingSelection, setPendingSelection] = useState<{
    text: string;
    rects: HighlightView["anchor"]["rects"];
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  /** Serializes page renders; see the render effect. */
  const renderChain = useRef<Promise<void>>(Promise.resolve());
  const pageRef = useRef(page);
  /**
   * The book's author at the time the load effect runs.
   *
   * The effect needs to know whether the author is still missing, but taking
   * `book.author` as a dependency would re-run the whole document load the
   * moment the back-fill writes it — reloading the book the user is reading.
   * A ref gives the effect the current value without making it a dependency.
   */
  const authorRef = useRef(book.author);
  authorRef.current = book.author;
  /**
   * Whether this reader is still mounted. `startSession` is awaited after the
   * document loads, so a reader closed during load would otherwise start a
   * session that nothing ever ends.
   */
  const mountedRef = useRef(true);

  pageRef.current = page;

  /**
   * The raster's real inputs. Display-only settings (invert, brightness,
   * contrast, background) are applied as CSS on the canvas, so they are
   * deliberately *not* dependencies: dragging the brightness slider must repaint
   * with a filter, not re-rasterize the page (STACK §6.2).
   */
  const { zoomMode, zoom: zoomValue } = settings;
  /** Scale of the last raster, so a scroll save does not overwrite it with a guess. */
  const scaleRef = useRef(1);
  /**
   * The page's text items in screen space, kept so highlights can be re-anchored
   * (F-READ-07). Rects are not invariant under rotation, so a highlight whose
   * stored rotation differs must be found by its text instead (STACK §6.3).
   */
  const [textItems, setTextItems] = useState<TextItem[]>([]);
  /**
   * Increments after each completed raster. The restore effect waits on this:
   * an unsized `<canvas>` reports the HTML default height (150), not 0, so
   * `doc` is the wrong signal and assigning `scrollTop` before the page is
   * painted clamps to 0 and loses the saved offset (measured).
   */
  const [rasterDone, setRasterDone] = useState(0);
  /** Whether this book's saved offset has been applied (once per open). */
  const restoredRef = useRef(false);
  /** Pending debounced scroll save; a page turn cancels it (see goTo). */
  const scrollTimerRef = useRef<{ clear: () => void } | null>(null);
  /**
   * Width of the reader column. Fit-width and fit-page derive the scale from it,
   * so without this the raster stays at the old size after a window resize until
   * the page or zoom changes.
   */
  const [containerWidth, setContainerWidth] = useState(0);
  /**
   * The current page's rotation in degrees. Stored on each new anchor and passed
   * to the resolver, so a highlight made on a rotated page is re-anchored by text
   * instead of trusting rects that no longer describe the page shape (STACK §6.3).
   */
  const [pageRotation, setPageRotation] = useState(0);
  /** Markdown from the last export, shown when the clipboard write fails. */
  const [exportText, setExportText] = useState<string | null>(null);

  useEffect(() => {
    // `doc` is a dependency so the observer is re-attached once a document is
    // loaded. It is NOT because the wrapper ref is unavailable before then — the
    // canvas wrap is rendered unconditionally, so `wrapRef.current` is set on the
    // first render. The guard below is what actually handles a missing ref.
    if (!doc) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth((prev) => (Math.abs(prev - width) < 2 ? prev : width));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [doc]);

  // ── load document ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        let pending = documentCache.get(book.id);
        if (pending) {
          // Refresh recency so the open book is the last candidate for eviction.
          documentCache.delete(book.id);
          documentCache.set(book.id, pending);
        } else {
          // pdf.js 5 loads its codecs (JBIG2, OpenJPEG) and character maps at
          // runtime; without these the worker stalls on the first page that
          // needs them.
          pending = pdfjs.getDocument({
            // N-SEC-02: pdf.js defaults to allowing embedded JavaScript; the
            // type definitions omit the flag, so the cast is deliberate.
            isEvalSupported: false,
            url: `selfos-book://book/${book.id}`,
            wasmUrl: `${PDFJS_BASE}/wasm/`,
            cMapUrl: `${PDFJS_BASE}/cmaps/`,
            standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
            iccUrl: `${PDFJS_BASE}/iccs/`,
          } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
          cacheDocument(book.id, pending);
        }
        const loaded = await pending.catch((err: unknown) => {
          // A failed load must not poison the cache for the next attempt.
          documentCache.delete(book.id);
          throw err;
        });
        if (cancelled) return;
        setDoc(loaded);
        setStatus("");

        // Fetch metadata when the page count is stale OR when the author is
        // still missing. The second condition matters: `page_count` is written
        // by this same call, so a book opened once before `author` existed has a
        // correct count and would never re-enter this block — leaving `author`
        // NULL forever for the entire pre-existing library. Gating on both means
        // an already-open book back-fills on its next open and then stops.
        //
        // F-READ-02: title and author both come from the file's metadata, and
        // this is the only call that carries them.
        if (book.pageCount !== loaded.numPages || authorRef.current === null) {
          const meta = await loaded
            .getMetadata()
            .catch(() => ({ info: {} as { Title?: string; Author?: string } }));
          await window.selfos.invoke("reading.setPageCount", {
            bookId: book.id,
            pageCount: loaded.numPages,
            ...(meta.info && "Title" in meta.info && meta.info.Title ? { title: meta.info.Title } : {}),
            ...(meta.info && "Author" in meta.info && meta.info.Author ? { author: meta.info.Author } : {}),
          });
        }

        // The highlight poll refreshes immediately on mount, so this effect does
        // not fetch a second copy of the same list.

        // The session id is not needed by the renderer: endSession is keyed by
        // book, and the main process tracks the open session per book.
        await window.selfos.invoke("reading.startSession", { bookId: book.id });
        // The reader may have been closed while that call was in flight; close
        // the session it just opened rather than leaking it.
        if (!mountedRef.current) {
          await window.selfos.invoke("reading.endSession", { bookId: book.id, visibleSeconds: 0 });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [book.id, book.pageCount]);

  /**
   * Reading session lifecycle (F-READ-06/14, STACK §6.4).
   *
   * `active_seconds` must count only time the reader is visible and focused —
   * the app closes to the tray, so wall clock would accrue hours of "reading"
   * for a window nobody is looking at. Visible time is accumulated here and
   * reported on close (and on a heartbeat, so a shutdown can close truthfully).
   */
  useEffect(() => {
    // StrictMode runs setup → cleanup → setup, so the flag is reset here rather
    // than relying on the initial value.
    mountedRef.current = true;
    let visibleMs = 0;
    // Visible *and* focused: a window can be on screen while the user works in
    // another one, and that time is not reading. `document.visibilityState`
    // stays "visible" through an OS-level blur, so both signals are needed.
    const counting = () => document.visibilityState === "visible" && document.hasFocus();
    let since: number | null = counting() ? Date.now() : null;

    const flush = () => {
      if (since !== null) {
        visibleMs += Date.now() - since;
        since = null;
      }
    };

    const report = () => {
      void window.selfos.invoke("reading.reportVisible", {
        bookId: book.id,
        seconds: visibleMs / 1000,
      });
    };

    const onVisibility = () => {
      if (counting()) {
        if (since === null) since = Date.now();
      } else {
        flush();
        report();
      }
    };

    // Window blur/focus is not a visibility change, so it needs its own pair of
    // listeners; without them an unfocused-but-visible window kept accruing.
    const onBlur = () => {
      flush();
      report();
    };
    const onFocus = () => {
      // Only start the clock if it is not already running: a duplicate focus
      // event would otherwise reset `since` and discard the time since the
      // last one.
      if (since === null && counting()) since = Date.now();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    const heartbeat = setInterval(() => {
      if (since !== null) {
        void window.selfos.invoke("reading.reportVisible", {
          bookId: book.id,
          seconds: (visibleMs + (Date.now() - since)) / 1000,
        });
      }
    }, 30_000);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      clearInterval(heartbeat);
      flush();
      void window.selfos.invoke("reading.endSession", {
        bookId: book.id,
        visibleSeconds: visibleMs / 1000,
      });
    };
  }, [book.id]);

  // ── render the current page ──────────────────────────────────────────
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;

    const run = async () => {
      // `p` is hoisted so every exit path — cancel, failure, or success — can
      // release the page's operator list and decoded images. Cleanup on the
      // success path only left one leaked page per page flipped past mid-render,
      // which is exactly the accumulation F-READ-15 exists to bound.
      let pageRefObj: Awaited<ReturnType<typeof doc.getPage>> | null = null;
      try {
        pageRefObj = await doc.getPage(page);
        const p = pageRefObj;
        if (cancelled) return;

        const base = p.getViewport({ scale: 1 });
        if (!cancelled) setPageRotation(base.rotation);
        const usableWidth = (containerWidth || (wrapRef.current?.clientWidth ?? 800)) - 32;
        const scale =
          zoomMode === "fit-page"
            ? Math.min(usableWidth / base.width, (window.innerHeight - 160) / base.height)
            : zoomMode === "fit-width"
              ? usableWidth / base.width
              : zoomValue;
        const viewport = p.getViewport({ scale: Math.max(0.25, scale) });
        scaleRef.current = Math.max(0.25, scale);

        // Record the page as soon as it is chosen — rendering can take seconds,
        // and the reader is already "on" this page from the user's point of view.
        //
        // The scroll offset is NOT part of this write. The effect also re-runs on
        // resize and zoom, and writing an offset here would clobber the value the
        // debounced scroll listener owns (a resize fires no scroll event, so the
        // saved position would be lost until the next scroll). `savePosition`
        // keeps the stored offset when the field is omitted.
        void window.selfos.invoke("reading.savePosition", {
          bookId: book.id,
          page,
          zoom: Math.max(0.25, scale),
        });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // pdf.js's operator loop is driven by rAF, which stalls in an unfocused
        // window and under software rendering; the render would never resolve.
        // See withRenderClock.
        await withRenderClock(() => p.render({ canvasContext: ctx, viewport }).promise);
        if (cancelled) return;

        // Text layer, used for selection and for re-anchoring highlights.
        const text = await p.getTextContent();
        // Resolve the transform helper *before* touching the layer. It awaits a
        // dynamic import; if that resolved after the spans were appended, the
        // `innerHTML = ""` below would run late and wipe them.
        const transform = await getUtilTransform();
        // The await above can let a newer render take over; rebuilding the layer
        // from a superseded run would paint the previous page's spans.
        if (cancelled) return;
        const items: TextItem[] = [];
        for (const item of text.items) {
          if (!item.str) continue;
          const tx = transform(viewport.transform as number[], item.transform);
          // Font height comes from the transformed text matrix. It was a
          // literal 12 px before, which only happened to be right at the
          // default zoom: the canvas is rastered at `viewport`, so at any other
          // scale the rects captured from the DOM and the rects rebuilt from
          // TextItems described different boxes, and re-anchoring kept them
          // (the rects still landed inside [0,1], so `exact` never corrected).
          const fontHeight = Math.hypot(tx[2] as number, tx[3] as number);
          // `tx[4]`/`tx[5]` are already in viewport space, top-down: the
          // viewport transform carries the flip (its `d` is negative for
          // rotation 0). Subtracting `tx[5]` from `viewport.height` mirrored
          // every span to the opposite end of the page — measured: a span drawn
          // for ink at y=112 was positioned at y=1014.
          //
          // `fontAscent` moves from the baseline to the top of the glyph box,
          // and the direction it moves depends on the text angle, so a rotated
          // page needs the sin/cos terms (this is pdf.js's own text-layer
          // placement). The reader tracks rotation and re-anchors on a change,
          // so a 90° page has to place spans correctly too.
          const fontAscent = fontHeight * 0.8;
          const angle = Math.atan2(tx[1] as number, tx[0] as number);
          items.push({
            str: item.str,
            x: (tx[4] as number) + fontAscent * Math.sin(angle),
            y: (tx[5] as number) - fontAscent * Math.cos(angle),
            w: item.width * (viewport.width / base.width),
            h: fontHeight,
          });
        }
        if (!cancelled) setTextItems(items);
        if (!cancelled) setRasterDone((n) => n + 1);

        const layer = layerRef.current;
        if (layer) {
          layer.innerHTML = "";
          layer.style.width = `${viewport.width}px`;
          layer.style.height = `${viewport.height}px`;
          const spans: HTMLSpanElement[] = [];
          for (const item of items) {
            const span = document.createElement("span");
            span.textContent = item.str;
            span.style.left = `${item.x}px`;
            span.style.top = `${item.y}px`;
            span.style.fontSize = `${item.h}px`;
            // Read by the verification harness to count text-layer spans. It is
            // not dead: removing it made verify-reading report 0 spans.
            span.dataset.text = item.str;
            layer.appendChild(span);
            spans.push(span);
          }
          // Measure after every span is in the layer, and measure all of them
          // before writing any transform: writing a style inside the measuring
          // loop invalidates layout, so the next read forces a full re-layout
          // (N layouts for N spans). pdf.js stretches each span to the width the
          // PDF's own text matrix reports, because the browser's font metrics
          // differ from the embedded one; without the stretch, selection rects
          // came from the browser's layout while re-anchored rects came from
          // `item.width`, so the two disagreed by the metric difference.
          const widths = spans.map((span) => span.getBoundingClientRect().width);
          for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const target = items[i]?.w ?? 0;
            const natural = widths[i] ?? 0;
            if (span && natural > 0 && target > 0) span.style.transform = `scaleX(${target / natural})`;
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        // Release the page's operator list, decoded images and text cache on
        // every path. pdf.js otherwise keeps them for the document's lifetime,
        // so a long read would retain every page visited (F-READ-15).
        pageRefObj?.cleanup();
      }
    };

    // Serialize renders on one document. pdf.js deadlocks when two renders of
    // the same page overlap — measured 3/3 timeouts — and React StrictMode
    // invokes every effect twice, so the second run must wait for the first
    // rather than start alongside it.
    const previous = renderChain.current;
    const next = previous.then(run, run);
    renderChain.current = next;
    void next;

    return () => {
      cancelled = true;
    };
  }, [doc, page, zoomMode, zoomValue, book.id, containerWidth]);

  const goTo = useCallback(
    (next: number) => {
      if (!doc) return;
      const clamped = Math.min(doc.numPages, Math.max(1, next));
      if (clamped === pageRef.current) return;
      // A page turn is a new position: cancel the pending scroll save (its timer
      // reads `pageRef.current` at fire time, which would attribute this page's
      // scroll to the next one) and return the container to the top.
      scrollTimerRef.current?.clear();
      if (wrapRef.current) wrapRef.current.scrollTop = 0;
      setPage(clamped);
      void window.selfos.invoke("reading.turnPage", { bookId: book.id });
      setPendingSelection(null);
    },
    [doc, book.id],
  );

  // ── selection → highlight ────────────────────────────────────────────
  useEffect(() => {
    const onSelection = () => {
      const sel = window.getSelection();
      const canvas = canvasRef.current;
      if (!sel || sel.isCollapsed || !canvas) return;
      const text = sel.toString().trim();
      if (!text) return;

      const layerRect = canvas.getBoundingClientRect();
      const rects = [...sel.getRangeAt(0).getClientRects()]
        .filter((r) => r.width > 0 && r.height > 0)
        // `toNormalized` is the same arithmetic the resolver uses; inlining it
        // meant a change to the normalization convention had to be made twice.
        .map((r) =>
          toNormalized(
            r.left - layerRect.left,
            r.top - layerRect.top,
            r.width,
            r.height,
            layerRect.width,
            layerRect.height,
          ),
        );
      if (rects.length === 0) return;
      setPendingSelection({ text, rects });
    };
    document.addEventListener("mouseup", onSelection);
    return () => document.removeEventListener("mouseup", onSelection);
  }, []);

  const addHighlight = async () => {
    if (!pendingSelection) return;
    const res = await window.selfos.invoke("reading.addHighlight", {
      bookId: book.id,
      page,
      color: activeColor,
      text: pendingSelection.text,
      anchor: {
        page,
        rects: pendingSelection.rects,
        text: pendingSelection.text,
        rotation: pageRotation,
        // The shared constant, not a literal: this is a contract version number,
        // and a second copy of it here is exactly the drift the shared module
        // exists to prevent (the service overwrites it today, which masks any
        // divergence rather than preventing it).
        anchorVersion: ANCHOR_VERSION,
      },
    });
    if (res.ok) {
      await refreshHighlights();
    } else {
      setError(res.error);
    }
    setPendingSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  /**
   * Refetch highlights, skipping the state write when nothing changed.
   *
   * One helper for both callers: the mutation paths, and the self-healing poll.
   * The poll previously re-implemented the same fetch and the same
   * `JSON.stringify` comparison, so a change to either could silently disagree
   * with the other. `mountedRef` guards the write instead of a per-effect
   * `cancelled` flag, which is what let the two copies diverge.
   */
  const refreshHighlights = useCallback(async () => {
    const res = await window.selfos.invoke("reading.highlights", { bookId: book.id });
    if (!res.ok || !mountedRef.current) return;
    setHighlights((prev) => (JSON.stringify(prev) === JSON.stringify(res.data) ? prev : res.data));
  }, [book.id]);

  const removeHighlight = async (id: number) => {
    const res = await window.selfos.invoke("reading.deleteHighlight", { highlightId: id });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await refreshHighlights();
  };

  const saveNote = async (id: number, body: string) => {
    const res = await window.selfos.invoke("reading.updateNote", { highlightId: id, body });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await refreshHighlights();
  };

  // Persist the scroll offset while the user reads (debounced), so reopening
  // the book returns to the same place within the page, not just the page.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** The page whose offset a not-yet-fired write belongs to, if any. */
    let pendingPage: number | null = null;
    const write = (pageForOffset: number) => {
      // Stored as a 0..1 fraction of the *scrollable range*, not pixels: the
      // content height is the raster height, which changes with zoom and with
      // the window width, so a pixel offset restored after either change lands
      // somewhere else. `reading_position.scroll_offset` is declared 0..1
      // within the page (STACK §4.2).
      void window.selfos.invoke("reading.savePosition", {
        bookId: book.id,
        page: pageForOffset,
        scrollOffset: scrollFraction(wrap),
        zoom: scaleRef.current,
      });
    };
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      // Capture the page at scroll time. Reading `pageRef.current` when the
      // timer fires would attribute this page's offset to whatever page is
      // current 500 ms later — a scroll followed by a page turn wrote the old
      // offset onto the new page.
      const scrolledPage = pageRef.current;
      pendingPage = scrolledPage;
      const id = setTimeout(() => {
        scrollTimerRef.current = null;
        pendingPage = null;
        write(scrolledPage);
      }, 500);
      timer = id;
      scrollTimerRef.current = {
        clear: () => {
          clearTimeout(id);
          // A page turn discards this offset: `goTo` resets the container to
          // the top, so flushing it later would save the old page's position
          // against the new one.
          pendingPage = null;
        },
      };
    };
    wrap.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      scrollTimerRef.current = null;
      wrap.removeEventListener("scroll", onScroll);
      // Flush a pending debounced write on close. The timer used to be dropped,
      // so a scroll in the last 500 ms before the reader unmounted was never
      // saved. The page is the one captured at scroll time, not the one the
      // reader happens to be on now.
      if (pendingPage !== null) {
        const pageForOffset = pendingPage;
        pendingPage = null;
        write(pageForOffset);
      }
    };
  }, [book.id]);

  // Restore the saved offset within the page once, when the book opens
  // (F-READ-05). Separate from the load effect because it depends on the saved
  // position, not on the document.
  useEffect(() => {
    if (!doc || rasterDone === 0 || restoredRef.current) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    restoredRef.current = true;
    if (book.scrollOffset <= 0 || pageRef.current !== book.page) return;
    // Only after a real raster: before that the container holds the default
    // 150 px canvas and the assignment clamps to 0. The stored value is a
    // fraction of the scrollable range, so it survives a different zoom.
    wrap.scrollTop = scrollTopFor(book.scrollOffset, wrap.scrollHeight, wrap.clientHeight);
  }, [book.scrollOffset, book.page, doc, rasterDone]);

  // A new book resets the once-per-open guard. `book.id` is read so the effect
  // re-runs per book, even though the body only touches a ref.
  useEffect(() => {
    if (!book.id) return;
    restoredRef.current = false;
  }, [book.id]);

  const updateSettings = (patch: Partial<BookSettingsView>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void window.selfos.invoke("reading.saveSettings", { bookId: book.id, settings: next });
  };

  const exportMd = async () => {
    const res = await window.selfos.invoke("reading.exportMarkdown", { bookId: book.id });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    try {
      await navigator.clipboard.writeText(res.data.markdown);
      setStatus("Markdown copied to clipboard");
      // Clear the fallback box and its error: a later successful copy used to
      // leave the previous failure's markdown on screen under a message that
      // said the export had failed.
      setExportText(null);
      setError(null);
    } catch {
      // Clipboard writes reject without focus or permission; reporting success
      // would leave the user pasting stale content. Keep the text so it can be
      // selected by hand rather than pointing at UI that does not exist.
      setError("Could not write to the clipboard — the markdown is in the export box below.");
      setExportText(res.data.markdown);
      setStatus("");
    }
    setTimeout(() => setStatus(""), 2500);
  };

  /**
   * Highlights on this page, with their rects resolved against the live text
   * layer (F-READ-07). A rotation mismatch, or text that moved, falls back to
   * text search; a highlight that cannot be found is marked orphaned and shown
   * in the panel rather than silently disappearing (STACK §6.3).
   */
  const pageHighlights = useMemo(() => {
    const vw = canvasRef.current?.clientWidth ?? 0;
    const vh = canvasRef.current?.clientHeight ?? 0;
    return highlights
      .filter((h) => h.page === page)
      .map((h) => {
        if (!textItems.length || vw === 0 || vh === 0) return { ...h, resolvedRects: h.anchor.rects };
        const result = resolveAnchor(h.anchor, textItems, vw, vh, pageRotation);
        return { ...h, resolvedRects: result.rects, orphaned: isOrphaned(result) };
      });
  }, [highlights, page, textItems, pageRotation]);

  /** Ids of current-page highlights whose anchor could not be resolved. */
  const orphanedIds = useMemo(
    () => new Set(pageHighlights.filter((h) => "orphaned" in h && h.orphaned).map((h) => h.id)),
    [pageHighlights],
  );

  // Keep annotations fresh while the reader is open. A local query against an
  // indexed table is cheap, and polling makes the panel self-healing: highlights
  // can be written by another process (the verification harness inserts them
  // through IPC, and a future sync would too), so the panel cannot assume this
  // component was the last writer.
  useEffect(() => {
    if (!doc) return;
    void refreshHighlights();
    // Self-heal only: mutation paths refresh directly, so this is slow and is
    // skipped while the window is hidden (the app's steady state is the tray).
    const id = setInterval(() => {
      if (!document.hidden) void refreshHighlights();
    }, 15_000);
    return () => clearInterval(id);
  }, [doc, refreshHighlights]);

  // Keyboard navigation. NOT F-READ-13: that requirement is a full-screen
  // distraction-free mode (SHOULD), which is not implemented — there is no
  // fullscreen call or chrome-hiding state anywhere in the renderer. Citing it
  // here made the requirement look shipped. This block is plain paging.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") goTo(pageRef.current + 1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") goTo(pageRef.current - 1);
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, onBack]);

  return (
    <div className="reader">
      <div className="reader-toolbar">
        <button type="button" className="mini" onClick={onBack}>
          ← Library
        </button>
        <span className="reader-title" title={book.title}>
          {book.title}
        </span>

        <div className="reader-nav">
          <button type="button" className="mini" onClick={() => goTo(page - 1)} disabled={page <= 1}>
            ‹
          </button>
          <span className="page-indicator">
            {page} / {doc?.numPages ?? (book.pageCount || "—")}
          </span>
          <button
            type="button"
            className="mini"
            onClick={() => goTo(page + 1)}
            disabled={Boolean(doc && page >= doc.numPages)}
          >
            ›
          </button>
        </div>

        <div className="reader-controls">
          <select
            className="input"
            value={settings.pageBackground}
            onChange={(e) =>
              updateSettings({ pageBackground: e.target.value as BookSettingsView["pageBackground"] })
            }
            aria-label="Page background"
          >
            <option value="original">Original</option>
            <option value="sepia">Sepia</option>
            <option value="dark">Dark</option>
            <option value="black">Black</option>
          </select>
          <select
            className="input"
            value={settings.zoomMode}
            onChange={(e) => updateSettings({ zoomMode: e.target.value as BookSettingsView["zoomMode"] })}
            aria-label="Zoom mode"
          >
            <option value="fit-width">Fit width</option>
            <option value="custom">Custom zoom</option>
            <option value="fit-page">Fit page</option>
          </select>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.invert}
              onChange={(e) => updateSettings({ invert: e.target.checked })}
            />
            invert
          </label>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={settings.brightness}
            onChange={(e) => updateSettings({ brightness: Number(e.target.value) })}
            aria-label="Brightness"
            title="Brightness"
          />
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.05}
            value={settings.contrast}
            onChange={(e) => updateSettings({ contrast: Number(e.target.value) })}
            aria-label="Contrast"
            title="Contrast"
          />
          <select
            className="input"
            value={settings.layout}
            onChange={(e) => updateSettings({ layout: e.target.value as BookSettingsView["layout"] })}
            aria-label="Page layout"
          >
            <option value="scroll">Scroll</option>
            <option value="single">Single page</option>
          </select>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.hideHeaders}
              onChange={(e) => updateSettings({ hideHeaders: e.target.checked })}
            />
            hide headers
          </label>
          <input
            type="range"
            min={0}
            max={0.2}
            step={0.01}
            value={settings.cropMargins}
            onChange={(e) => updateSettings({ cropMargins: Number(e.target.value) })}
            aria-label="Crop margins"
            title="Crop margins"
          />
          <button type="button" className="mini" onClick={() => setShowAnnotations((v) => !v)}>
            {showAnnotations ? "hide notes" : "show notes"}
          </button>
        </div>
      </div>

      {status ? <div className="reader-status">{status}</div> : null}
      {error ? <div className="error">Reader error: {error}</div> : null}

      <div className={`reader-body layout-${settings.layout}`}>
        <div className="reader-canvas-wrap" ref={wrapRef}>
          <div
            className={`reader-page${settings.hideHeaders ? " hide-headers" : ""}`}
            style={{
              background: surfaceColor(settings.pageBackground),
              // F-READ-04 margin crop: a percentage of the page, clipped by the
              // wrapper. 0 is the default and renders exactly as before.
              padding: settings.cropMargins > 0 ? `${settings.cropMargins * 100}%` : undefined,
              overflow: settings.cropMargins > 0 ? "hidden" : undefined,
            }}
          >
            <canvas ref={canvasRef} style={{ filter: pageFilter(settings) }} />
            <div className="text-layer" ref={layerRef} aria-hidden="true" />
            <div className="highlight-layer" aria-hidden="true">
              {pageHighlights.map((h) =>
                h.resolvedRects.map((r) => (
                  <span
                    key={`${h.id}-${r.x.toFixed(4)}-${r.y.toFixed(4)}`}
                    className="highlight-rect"
                    style={{
                      left: `${r.x * 100}%`,
                      top: `${r.y * 100}%`,
                      width: `${r.w * 100}%`,
                      height: `${r.h * 100}%`,
                      background: colorValue(h.color),
                    }}
                  />
                )),
              )}
            </div>
          </div>

          {pendingSelection ? (
            <div className="selection-bar">
              <span className="muted">
                {pendingSelection.text.slice(0, 60)}
                {pendingSelection.text.length > 60 ? "…" : ""}
              </span>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch${activeColor === c ? " on" : ""}`}
                  style={{ background: colorValue(c) }}
                  onClick={() => setActiveColor(c)}
                  aria-label={`Highlight ${c}`}
                />
              ))}
              <button type="button" className="mini primary-mini" onClick={() => void addHighlight()}>
                highlight
              </button>
              <button type="button" className="mini" onClick={() => setPendingSelection(null)}>
                cancel
              </button>
            </div>
          ) : null}
        </div>

        {showAnnotations ? (
          <aside className="annotations">
            <div className="annotations-head">
              <strong>Highlights</strong>
              <span className="muted">{highlights.length}</span>
            </div>
            <button type="button" className="mini" onClick={() => void exportMd()}>
              copy as markdown
            </button>

            {/* Shown only when the clipboard write failed, so the text is still
                recoverable (see exportMd). */}
            {exportText ? (
              <textarea
                className="export-box"
                readOnly
                value={exportText}
                aria-label="Exported markdown"
                onFocus={(e) => e.currentTarget.select()}
              />
            ) : null}

            {highlights.length === 0 ? (
              <div className="muted annotations-empty">Select text in the page to add a highlight.</div>
            ) : null}

            {highlights.map((h) => (
              <div key={h.id} className={`annotation${h.page === page ? " current" : ""}`}>
                <button type="button" className="annotation-page" onClick={() => goTo(h.page)}>
                  p.{h.page}
                </button>
                <span className="annotation-dot" style={{ background: colorValue(h.color) }} />
                <div className="annotation-text">
                  {orphanedIds.has(h.id) ? (
                    <span className="pill orphaned" title="The text moved; jump to the page to relocate it">
                      not located
                    </span>
                  ) : null}{" "}
                  {h.text}
                </div>
                <textarea
                  className="annotation-note"
                  placeholder="Add a note…"
                  defaultValue={h.note ?? ""}
                  onBlur={(e) => void saveNote(h.id, e.target.value)}
                />
                <button type="button" className="mini" onClick={() => void removeHighlight(h.id)}>
                  delete
                </button>
              </div>
            ))}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
