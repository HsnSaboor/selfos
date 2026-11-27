/**
 * Markdown export for book highlights (F-READ-10).
 *
 * There is exactly one builder because two callers exist: the reader's "copy as
 * markdown" and the Obsidian export into the notes vault. They used to build
 * the block independently, and had already drifted (one emitted a highlight
 * count in the header, the other did not), so the same book produced two
 * different documents depending on which button was pressed.
 *
 * Pure — no database, no filesystem — so both services and tests can use it.
 */

export interface ExportHighlight {
  page: number;
  text: string;
  note: string | null;
}

/** Build the Obsidian markdown block for a book's highlights. */
export function buildHighlightsMarkdown(title: string, highlights: readonly ExportHighlight[]): string {
  const lines: string[] = [`# ${title}`, ""];
  const count = highlights.length;
  lines.push(`> Exported from SelfOS · ${count} highlight${count === 1 ? "" : "s"}`, "");

  let currentPage = -1;
  for (const h of highlights) {
    if (h.page !== currentPage) {
      lines.push("", `## Page ${h.page}`, "");
      currentPage = h.page;
    }
    lines.push(`> ${h.text.replace(/\n+/g, " ")}`);
    if (h.note) lines.push(">", `> **Note:** ${h.note.replace(/\n+/g, " ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
