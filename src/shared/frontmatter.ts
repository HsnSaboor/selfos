/**
 * Markdown frontmatter parsing, shared by the notes indexer and the renderer.
 *
 * The indexer uses it to separate metadata from body when indexing; the renderer
 * uses it to preview a note without showing its YAML header. It was implemented
 * twice (once in `main/modules/notes/index.ts`, once locally in `Notes.tsx`)
 * with the same boundary rules, so a change to one could silently disagree with
 * the other (PRD N-MAINT-02, STACK §12.1).
 */

/** Strip YAML frontmatter, returning it separately from the body. */
export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  if (!src.startsWith("---\n")) return { frontmatter: "", body: src };
  const end = src.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: "", body: src };
  const after = src.indexOf("\n", end + 4);
  return {
    frontmatter: src.slice(4, end),
    body: after === -1 ? "" : src.slice(after + 1),
  };
}

/** The note body without its frontmatter. */
export function stripFrontmatter(src: string): string {
  return splitFrontmatter(src).body;
}
