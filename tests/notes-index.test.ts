import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanSnippet,
  discoverVaults,
  exportMarker,
  extractTags,
  firstLines,
  NotesIndex,
  splitFrontmatter,
} from "../src/main/modules/notes/index";
import { tempDir } from "./helpers/temp";

function tempVault(): string {
  const root = tempDir("selfos-vault-");
  mkdirSync(join(root, "daily"), { recursive: true });
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "ignored.md"), "# should not be indexed");
  writeFileSync(
    join(root, "reading.md"),
    "---\ntags: [books, review]\n---\n\n# Reading notes\n\nSome content about the seerah.\n",
  );
  writeFileSync(join(root, "daily", "2026-11-02.md"), "# Today\n\nPrayed all five. #salah #habits\n");
  return root;
}

describe("splitFrontmatter", () => {
  it("separates YAML frontmatter from the body", () => {
    const { frontmatter, body } = splitFrontmatter("---\ntags: [a]\n---\nBody here");
    expect(frontmatter).toBe("tags: [a]");
    expect(body).toBe("Body here");
  });

  it("leaves plain markdown untouched", () => {
    expect(splitFrontmatter("# Title\nbody").frontmatter).toBe("");
  });

  it("tolerates unterminated frontmatter", () => {
    const src = "---\ntags: [a]\n";
    expect(splitFrontmatter(src).frontmatter).toBe("");
  });
});

describe("extractTags", () => {
  it("finds inline tags", () => {
    expect(extractTags("", "Prayed. #salah #habits/deep")).toEqual(["salah", "habits/deep"]);
  });

  it("finds frontmatter tags in both forms", () => {
    expect(extractTags("tags: [books, review]", "")).toEqual(["books", "review"]);
    expect(extractTags("tags: books, review", "")).toEqual(["books", "review"]);
  });

  it("deduplicates", () => {
    expect(extractTags("tags: [x]", "#x #x")).toEqual(["x"]);
  });

  it("ignores short or numeric fragments", () => {
    expect(extractTags("", "issue #1 and #a")).toEqual([]);
  });
});

describe("firstLines", () => {
  it("strips headings and picks prose", () => {
    expect(firstLines("# Title\n\nActual text here.\nMore text.")).toBe("Actual text here. More text.");
  });

  it("skips code fences and images", () => {
    expect(firstLines("```\ncode\n```\n![img](x)\nReal line")).toBe("Real line");
  });
});

describe("cleanSnippet", () => {
  it("drops fence markers and heading hashes but keeps match markers", () => {
    // Heading text is kept: a query may only match a heading, and an empty
    // snippet would hide the hit entirely.
    expect(cleanSnippet("# Title\n\n<<Wudu>> here\n\n```\ncode fence must…")).toBe(
      "Title <<Wudu>> here code fence must…",
    );
  });

  it("collapses whitespace", () => {
    expect(cleanSnippet("a\n\n\nb")).toBe("a b");
  });

  it("removes images", () => {
    expect(cleanSnippet("![alt](img.png) text")).toBe("text");
  });
});

describe("NotesIndex", () => {
  it("indexes markdown and skips .obsidian", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    const n = idx.setVault({ path: root, name: "test-vault" });
    expect(n).toBe(2);
    expect(idx.count()).toBe(2);
    expect(
      idx
        .list()
        .map((h) => h.path)
        .sort(),
    ).toEqual(["daily/2026-11-02.md", "reading.md"]);
  });

  it("searches body text", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    const hits = idx.search("seerah");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("reading.md");
    expect(hits[0]?.snippet).toContain("seerah");
  });

  it("searches tags", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    expect(idx.search("salah")).toHaveLength(1);
  });

  it("returns nothing for an empty query instead of throwing", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    expect(idx.search("   ")).toEqual([]);
    expect(idx.search('"; DROP TABLE note; --')).toEqual([]);
  });

  it("re-indexes only changed files", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    // Unchanged file is skipped.
    expect(idx.upsertFile(join(root, "reading.md"), "reading.md")).toBe(false);
    writeFileSync(join(root, "reading.md"), "# Changed\n\nNew body about fiqh.\n");
    expect(idx.upsertFile(join(root, "reading.md"), "reading.md")).toBe(true);
    expect(idx.search("fiqh")).toHaveLength(1);
  });

  it("drops notes deleted outside the app", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    // Simulate deletion by reindexing a vault that no longer has the file.
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(join(root, "reading.md"));
    idx.reindex();
    expect(idx.count()).toBe(1);
  });

  it("reads a note and refuses path traversal", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    expect(idx.read("reading.md")).toContain("Reading notes");
    expect(idx.read("../../etc/passwd")).toBeNull();
  });

  it("appends without destroying existing content", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    const before = readFileSync(join(root, "daily/2026-11-02.md"), "utf8");
    const res = idx.append("daily/2026-11-02.md", "- [ ] Review notes");
    expect(res.created).toBe(false);
    const after = readFileSync(join(root, "daily/2026-11-02.md"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("- [ ] Review notes");
  });

  it("creates a missing note on append", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    const res = idx.append("inbox.md", "First thought");
    expect(res.created).toBe(true);
    expect(readFileSync(join(root, "inbox.md"), "utf8")).toContain("First thought");
  });

  it("never overwrites an existing note via createIfAbsent", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    const before = readFileSync(join(root, "reading.md"), "utf8");
    const res = idx.createIfAbsent("reading.md", "REPLACED");
    expect(res.created).toBe(false);
    expect(readFileSync(join(root, "reading.md"), "utf8")).toBe(before);
  });

  it("builds an obsidian URI", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "my vault" });
    expect(idx.uri("daily/2026-11-02.md")).toBe("obsidian://open?vault=my%20vault&file=daily%2F2026-11-02");
    expect(idx.uri("a.md", "Heading")).toContain("&heading=Heading");
  });

  it("clears the index when the vault is removed", () => {
    const root = tempVault();
    const idx = new NotesIndex(join(root, ".index.sqlite"));
    idx.setVault({ path: root, name: "test-vault" });
    expect(idx.setVault(null)).toBe(0);
    expect(idx.count()).toBe(0);
  });
});

describe("discoverVaults", () => {
  it("returns only paths that exist", () => {
    // The real config points at a path that may not exist; every candidate is
    // validated, so this must never throw.
    const vaults = discoverVaults();
    expect(Array.isArray(vaults)).toBe(true);
    for (const v of vaults) expect(existsSync(v.path)).toBe(true);
  });
});

describe("exportMarker", () => {
  it("is stable for the same content and changes with it", () => {
    expect(exportMarker(1, "a\u0000b")).toBe(exportMarker(1, "a\u0000b"));
    expect(exportMarker(1, "a\u0000b")).not.toBe(exportMarker(1, "a\u0000c"));
  });

  it("changes when content changes even if the row count does not", () => {
    // Two highlights swapped for two different ones: the count is identical,
    // so a count-keyed marker would report "already up to date".
    const before = exportMarker(1, "1\u0000first\u0000");
    const after = exportMarker(1, "1\u0000second\u0000");
    expect(before).not.toBe(after);
  });

  it("differs per book", () => {
    expect(exportMarker(1, "same")).not.toBe(exportMarker(2, "same"));
  });
});
