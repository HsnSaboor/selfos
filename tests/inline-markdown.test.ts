import { describe, expect, it } from "vitest";
import { isExternalHref, isSafeHref, tokenizeInline } from "../src/shared/inline-markdown";

describe("tokenizeInline", () => {
  it("leaves plain text alone", () => {
    expect(tokenizeInline("a plain line")).toEqual([{ kind: "text", text: "a plain line" }]);
  });

  it("parses strong, em, strike and inline code", () => {
    expect(tokenizeInline("**bold**")).toEqual([{ kind: "strong", text: "bold" }]);
    expect(tokenizeInline("_it_")).toEqual([{ kind: "em", text: "it" }]);
    expect(tokenizeInline("~~gone~~")).toEqual([{ kind: "strike", text: "gone" }]);
    expect(tokenizeInline("`x = 1`")).toEqual([{ kind: "code", text: "x = 1" }]);
  });

  it("mixes constructs with surrounding text", () => {
    expect(tokenizeInline("a **b** c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " c" },
    ]);
  });

  it("does not start emphasis inside an inline code span", () => {
    // `a ** b` must stay code; the asterisks are content, not a delimiter.
    expect(tokenizeInline("`a ** b`")).toEqual([{ kind: "code", text: "a ** b" }]);
  });

  it("keeps an unmatched delimiter literal", () => {
    expect(tokenizeInline("2 * 3")).toEqual([{ kind: "text", text: "2 * 3" }]);
    expect(tokenizeInline("**unclosed")).toEqual([{ kind: "text", text: "**unclosed" }]);
  });

  it("parses links and keeps their href", () => {
    expect(tokenizeInline("[site](https://example.com)")).toEqual([
      { kind: "link", text: "site", href: "https://example.com" },
    ]);
  });

  it("handles backticks of more than one character", () => {
    expect(tokenizeInline("``a ` b``")).toEqual([{ kind: "code", text: "a ` b" }]);
  });
});

describe("isSafeHref", () => {
  it("allows web, mail and obsidian links plus relative paths", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.c")).toBe(true);
    expect(isSafeHref("obsidian://open?vault=x")).toBe(true);
    expect(isSafeHref("#heading")).toBe(true);
    expect(isSafeHref("./note.md")).toBe(true);
  });

  it("refuses script and unknown schemes", () => {
    // A `javascript:` link in an anchor is the injection path a preview has.
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});

describe("isExternalHref", () => {
  it("treats absolute schemes as external", () => {
    expect(isExternalHref("https://example.com")).toBe(true);
    expect(isExternalHref("mailto:a@b.c")).toBe(true);
    expect(isExternalHref("obsidian://open?vault=x")).toBe(true);
  });

  it("treats relative and in-page links as internal", () => {
    expect(isExternalHref("./note.md")).toBe(false);
    expect(isExternalHref("#heading")).toBe(false);
    expect(isExternalHref("/abs")).toBe(false);
  });
});
