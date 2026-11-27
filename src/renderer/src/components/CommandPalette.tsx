import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  /** May be async: the palette fires it without waiting for it to settle. */
  run: () => void | Promise<void>;
}

/**
 * Fire a command and report a rejection instead of letting it float.
 *
 * The palette closes before the command settles, so an unhandled rejection had
 * no surface to appear on: the command silently did nothing.
 */
function runCommand(cmd: Command): void {
  try {
    const out = cmd.run();
    if (out && typeof out.catch === "function") {
      out.catch((err: unknown) => {
        console.error(`[command] ${cmd.id} failed:`, err);
      });
    }
  } catch (err) {
    console.error(`[command] ${cmd.id} threw:`, err);
  }
}

/**
 * Keyboard-first launcher (Ctrl+K / Cmd+K).
 *
 * A native <dialog> would fight the app's own focus handling and Electron's
 * window chrome, so this is a plain overlay with an explicit focus trap: Tab is
 * the only key that stays inside, and Escape always closes.
 */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    // Subsequence match: "gda" finds "Goals dashboard". Cheap, and it forgives
    // the typo-prone middle of long labels.
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ""}`.toLowerCase();
      if (hay.includes(q)) return true;
      let i = 0;
      for (const ch of hay) if (ch === q[i]) i++;
      return i === q.length;
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The palette is an overlay: dismissing it must not also close the book
        // underneath. `stopImmediatePropagation` is NOT enough here — the reader
        // registers its window listener earlier, and same-target bubble listeners
        // run in registration order, so the reader would already have fired.
        // This listener is therefore registered in the capture phase (below),
        // which runs before any bubble listener on the same target. Measured.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (results.length ? (i + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
      } else if (e.key === "Enter") {
        const cmd = results[index];
        if (cmd) {
          e.preventDefault();
          onClose();
          runCommand(cmd);
        }
      } else if (e.key === "Tab") {
        // Keep focus inside the palette while it is open.
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    // Capture phase: runs before the reader's bubble listener on the same target.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, results, index, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  return (
    <div className="palette-backdrop">
      <button type="button" className="palette-scrim" aria-label="Close command palette" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to a module or run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-controls="palette-results"
          aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
        />
        <div className="palette-list" id="palette-results" role="listbox" ref={listRef}>
          {results.length === 0 ? <div className="palette-empty">No matching command</div> : null}
          {results.map((c, i) => (
            <button
              key={c.id}
              id={`palette-${c.id}`}
              data-idx={i}
              type="button"
              role="option"
              aria-selected={i === index}
              className={`palette-item${i === index ? " on" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onClose();
                runCommand(c);
              }}
            >
              <span>{c.label}</span>
              {c.hint ? <span className="palette-hint">{c.hint}</span> : null}
            </button>
          ))}
        </div>
        <div className="palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
