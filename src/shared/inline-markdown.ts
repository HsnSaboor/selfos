/**
 * Inline markdown tokenizer for the notes preview (PRD F-NOTES-02).
 *
 * The preview's block parser handled headings, quotes, lists and code, but
 * every inline construct was emitted literally: a note containing `**done**`
 * or `` `code` `` showed the raw markup, so the preview disagreed with what
 * Obsidian displays for the same file.
 *
 * STACK §3.2 prescribes `react-markdown` + `remark-gfm` + `rehype-sanitize`
 * for this. That is a new dependency, which needs approval, so this covers the
 * inline grammar Obsidian notes actually use — emphasis, strong, inline code,
 * strikethrough and links — and nothing else. It emits tokens, never HTML, so
 * there is no injection surface (N-SEC-02): the renderer turns each token into
 * a React element and link targets are filtered by the caller.
 */

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * Split one line of markdown into inline tokens.
 *
 * Order matters: inline code is matched first, because `` `a ** b` `` must not
 * let the asterisks inside the code span start an emphasis run. Links are next,
 * then the delimiter pairs. An unmatched delimiter stays literal text.
 */
export function tokenizeInline(line: string): InlineToken[] {
  const out: InlineToken[] = [];
  let rest = line;
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Coalesce adjacent plain text so the renderer emits one string child.
    if (last?.kind === "text") last.text += text;
    else out.push({ kind: "text", text });
  };

  while (rest) {
    // Inline code: a run of backticks, closed by the same run length.
    const code = rest.match(/^(`+)([\s\S]*?)\1/);
    if (code) {
      out.push({ kind: "code", text: (code[2] ?? "").trim() });
      rest = rest.slice(code[0].length);
      continue;
    }
    // Link: [text](href). The text may contain no brackets.
    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]*)\)/);
    if (link) {
      out.push({ kind: "link", text: link[1] ?? "", href: link[2] ?? "" });
      rest = rest.slice(link[0].length);
      continue;
    }
    const strong = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/);
    if (strong) {
      out.push({ kind: "strong", text: strong[2] ?? "" });
      rest = rest.slice(strong[0].length);
      continue;
    }
    const strike = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/);
    if (strike) {
      out.push({ kind: "strike", text: strike[1] ?? "" });
      rest = rest.slice(strike[0].length);
      continue;
    }
    const em = rest.match(/^(\*|_)(?=\S)([\s\S]*?\S)\1/);
    if (em) {
      out.push({ kind: "em", text: em[2] ?? "" });
      rest = rest.slice(em[0].length);
      continue;
    }
    // No construct starts here: consume one character as text and retry. This
    // is what keeps `2 * 3` literal instead of swallowing to the next asterisk.
    const next = rest.slice(1);
    pushText(rest[0] ?? "");
    rest = next;
  }
  return out;
}

/**
 * Is this href safe to render as a link?
 *
 * The notes preview never injects HTML, so the risk is a `javascript:` URL in
 * an anchor. Only schemes that make sense for a note are allowed; anything else
 * is rendered as text.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }
  return /^(https?|mailto|obsidian):/i.test(trimmed);
}

/**
 * Does this safe href leave the app (so the OS should open it)?
 *
 * The preview cannot navigate: the main process blocks `will-navigate` outside
 * the app origin. Absolute links are therefore handed to the main process,
 * while a relative or in-page link has no page to show and stays inert.
 */
export function isExternalHref(href: string): boolean {
  return /^(https?|mailto|obsidian):/i.test(href.trim());
}
