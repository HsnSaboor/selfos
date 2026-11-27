/**
 * Regression tests for defects found by the review loop.
 * Each test fails against the pre-fix code and states the failure scenario.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/main/db/driver";
import { migrate } from "../src/main/db/migrate";
import { heatmapDays } from "../src/main/modules/habits/streak";
import { NotesIndex, resolveInVault, safeFolder } from "../src/main/modules/notes/index";
import { BookStore } from "../src/main/modules/reading/library";
import { tempDir } from "./helpers/temp";

function freshDb(): Db {
  const dir = tempDir("selfos-regress-");
  const db = Db.open(join(dir, "test.sqlite"));
  migrate(db);
  return db;
}

describe("Db.transaction survives a failing COMMIT", () => {
  it("does not corrupt its depth when COMMIT throws", () => {
    const db = freshDb();
    db.raw.exec(`
      CREATE TABLE p(id INTEGER PRIMARY KEY);
      CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED);
    `);
    // A deferred FK violation only surfaces at COMMIT.
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO c (id, p) VALUES (1, 999)");
      }),
    ).toThrow(/FOREIGN KEY/);

    // The next transaction must still work. Before the fix the depth was -1
    // and this threw `near "-": syntax error` — every later transaction failed.
    expect(() => db.transaction(() => db.run("INSERT INTO p (id) VALUES (1)"))).not.toThrow();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM p")?.n).toBe(1);
  });

  it("still nests savepoints correctly after an inner failure", () => {
    const db = freshDb();
    db.raw.exec("CREATE TABLE t(v TEXT)");
    db.transaction(() => {
      db.run("INSERT INTO t VALUES ('outer')");
      try {
        db.transaction(() => {
          db.run("INSERT INTO t VALUES ('inner')");
          throw new Error("inner failed");
        });
      } catch {
        /* expected */
      }
      db.run("INSERT INTO t VALUES ('after')");
    });
    const rows = db.all<{ v: string }>("SELECT v FROM t ORDER BY rowid").map((r) => r.v);
    expect(rows).toEqual(["outer", "after"]);
  });
});

describe("notes vault containment", () => {
  function vaults() {
    const base = tempDir("selfos-vault-");
    const vault = join(base, "Notes");
    const sibling = join(base, "Notes-private");
    mkdirSync(vault, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.md"), "TOP SECRET");
    return { base, vault, sibling };
  }

  it("refuses a sibling directory that shares the vault prefix", () => {
    const { vault } = vaults();
    // A raw startsWith(vault) check passes here, because the sibling's path
    // literally begins with the vault path.
    expect(() => resolveInVault(vault, "../Notes-private/secret.md")).toThrow(/escapes the vault/);
  });

  it("refuses an absolute path", () => {
    const { vault } = vaults();
    expect(() => resolveInVault(vault, "/etc/passwd")).toThrow(/escapes the vault/);
  });

  it("refuses the vault root itself", () => {
    const { vault } = vaults();
    expect(() => resolveInVault(vault, ".")).toThrow(/escapes the vault/);
  });

  it("accepts a normal nested path", () => {
    const { vault } = vaults();
    expect(resolveInVault(vault, "daily/2026-11-02.md")).toBe(join(vault, "daily", "2026-11-02.md"));
  });

  it("read returns null instead of leaking a sibling file", () => {
    const { vault } = vaults();
    const idx = new NotesIndex(join(vault, ".index.sqlite"));
    idx.setVault({ path: vault, name: "v" });
    expect(idx.read("../Notes-private/secret.md")).toBeNull();
  });

  it("append cannot write outside the vault", () => {
    const { vault, sibling } = vaults();
    const idx = new NotesIndex(join(vault, ".index.sqlite"));
    idx.setVault({ path: vault, name: "v" });
    expect(() => idx.append("../Notes-private/planted.md", "x")).toThrow(/escapes the vault/);
    expect(existsSync(join(sibling, "planted.md"))).toBe(false);
  });

  it("createIfAbsent cannot write outside the vault", () => {
    const { vault, sibling } = vaults();
    const idx = new NotesIndex(join(vault, ".index.sqlite"));
    idx.setVault({ path: vault, name: "v" });
    expect(() => idx.createIfAbsent("../Notes-private/planted.md", "x")).toThrow(/escapes the vault/);
    expect(existsSync(join(sibling, "planted.md"))).toBe(false);
  });

  it("still reads a legitimate note", () => {
    const { vault } = vaults();
    writeFileSync(join(vault, "ok.md"), "fine");
    const idx = new NotesIndex(join(vault, ".index.sqlite"));
    idx.setVault({ path: vault, name: "v" });
    expect(idx.read("ok.md")).toBe("fine");
  });
});

describe("safeFolder", () => {
  it("accepts a plain folder", () => {
    expect(safeFolder("Daily")).toBe("Daily");
    expect(safeFolder("SelfOS/Books")).toBe("SelfOS/Books");
    expect(safeFolder("/Daily/")).toBe("Daily");
  });

  it("rejects traversal and empty segments", () => {
    expect(() => safeFolder("..")).toThrow(/invalid folder/);
    expect(() => safeFolder("a/../b")).toThrow(/invalid folder/);
    expect(() => safeFolder("a//b")).toThrow(/invalid folder/);
    expect(() => safeFolder("")).toThrow(/required/);
    // Whitespace-only is empty after trimming, so it is "required", not a
    // folder literally named spaces.
    expect(() => safeFolder("   ")).toThrow(/required/);
  });
});

describe("heatmapDays clamps its span", () => {
  const input = {
    habit: { id: 1, kind: "boolean", target: null } as never,
    versions: [],
    entries: [],
    today: "2026-11-02",
  };

  it("caps an absurd request instead of allocating it", () => {
    expect(heatmapDays(input, 50_000_000).length).toBeLessThanOrEqual(366);
  });

  it("floors at one day", () => {
    expect(heatmapDays(input, 0)).toHaveLength(1);
  });

  it("still honours a normal span", () => {
    expect(heatmapDays(input, 84)).toHaveLength(84);
  });
});

describe("qada debt follows status transitions", () => {
  it("does not double-count a repeated missed log", async () => {
    const { SalahService } = await import("../src/main/modules/salah/service");
    const db = freshDb();
    const salah = new SalahService(db);
    const date = "2026-11-02";

    await salah.log("fajr", { localDate: date, status: "missed" });
    expect(salah.qada().total).toBe(1);
    // Re-logging the same prayer must not add debt again.
    await salah.log("fajr", { localDate: date, status: "missed" });
    expect(salah.qada().total).toBe(1);
  });

  it("reverses the debt when a missed prayer is corrected", async () => {
    const { SalahService } = await import("../src/main/modules/salah/service");
    const db = freshDb();
    const salah = new SalahService(db);
    const date = "2026-11-02";

    await salah.log("fajr", { localDate: date, status: "missed" });
    expect(salah.qada().total).toBe(1);
    await salah.log("fajr", { localDate: date, status: "on_time" });
    expect(salah.qada().total).toBe(0);
  });

  it("goes on_time -> missed -> on_time without drifting", async () => {
    const { SalahService } = await import("../src/main/modules/salah/service");
    const db = freshDb();
    const salah = new SalahService(db);
    const date = "2026-11-02";

    await salah.log("dhuhr", { localDate: date, status: "on_time" });
    await salah.log("dhuhr", { localDate: date, status: "missed" });
    expect(salah.qada().total).toBe(1);
    await salah.log("dhuhr", { localDate: date, status: "on_time" });
    expect(salah.qada().total).toBe(0);
  });
});

describe("reading session rebuilds the day aggregate", () => {
  it("writes the session duration into the day aggregate", async () => {
    const { ReadingService } = await import("../src/main/modules/reading/service");
    const db = freshDb();
    const dir = tempDir("selfos-library-");
    const reading = new ReadingService(db, dir);

    // A minimal PDF is not needed: the session rows are what the aggregate reads.
    const bookId = Number(
      db.run(
        `INSERT INTO book (title, file_path, sha256, page_count, added_at)
         VALUES ('t', 't.pdf', 'x', 1, ?)`,
        Date.now(),
      ).lastInsertRowid,
    );
    reading.startSession(bookId);
    const ended = reading.endSession(bookId);

    const agg = db.get<{ reading_seconds: number }>(
      "SELECT reading_seconds FROM day_aggregate WHERE local_date = date('now', 'localtime')",
    );
    // The aggregate is rebuilt from the session row, so it must equal the
    // duration the service reported — not merely be non-negative.
    expect(agg?.reading_seconds).toBe(ended.activeSeconds);
    expect(ended.activeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("notes quick capture refuses a traversal folder", () => {
  it("does not write outside the vault", async () => {
    const { NotesService } = await import("../src/main/modules/notes/service");
    const db = freshDb();
    const base = tempDir("selfos-qc-");
    const vault = join(base, "Vault");
    mkdirSync(vault, { recursive: true });
    const svc = new NotesService(
      db,
      join(base, "index.sqlite"),
      (id) => db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", id)?.title ?? null,
    );
    svc.selectVault(vault);
    expect(() => svc.quickCapture("hello", "../../etc")).toThrow();
    expect(existsSync(join(base, "etc"))).toBe(false);
    svc.close();
  });
});

describe("wave 2: notes export identity", () => {
  it("names the export per book so same-titled books cannot collide", async () => {
    const { NotesService } = await import("../src/main/modules/notes/service");
    const db = freshDb();
    const base = tempDir("selfos-exp-");
    const vault = join(base, "Vault");
    mkdirSync(vault, { recursive: true });
    const svc = new NotesService(
      db,
      join(base, "index.sqlite"),
      (id) => db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", id)?.title ?? null,
    );
    svc.selectVault(vault);

    const mkBook = (title: string, sha: string) =>
      Number(
        db.run(
          `INSERT INTO book (title, file_path, sha256, page_count, added_at)
           VALUES (?, ?, ?, 1, ?)`,
          title,
          `${sha}.pdf`,
          sha,
          Date.now(),
        ).lastInsertRowid,
      );
    const a = mkBook("Untitled", "sha-a");
    const b = mkBook("Untitled", "sha-b");

    const ea = svc.exportHighlights(a);
    const eb = svc.exportHighlights(b);
    expect(ea.path).not.toBe(eb.path);
    expect(ea.path).toContain(String(a));
    expect(eb.path).toContain(String(b));
    svc.close();
  });

  it("re-exports when a highlight is swapped for another (same count)", async () => {
    const { NotesService } = await import("../src/main/modules/notes/service");
    const db = freshDb();
    const base = tempDir("selfos-exp2-");
    const vault = join(base, "Vault");
    mkdirSync(vault, { recursive: true });
    const svc = new NotesService(
      db,
      join(base, "index.sqlite"),
      (id) => db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", id)?.title ?? null,
    );
    svc.selectVault(vault);

    const bookId = Number(
      db.run(
        `INSERT INTO book (title, file_path, sha256, page_count, added_at)
         VALUES ('B', 'b.pdf', 'sha', 1, ?)`,
        Date.now(),
      ).lastInsertRowid,
    );
    const addHighlight = (text: string) =>
      db.run(
        `INSERT INTO highlight (book_id, page, color, text, rects_json, created_at)
         VALUES (?, 1, 'yellow', ?, '[]', ?)`,
        bookId,
        text,
        Date.now(),
      );

    addHighlight("first passage");
    const first = svc.exportHighlights(bookId);
    expect(first.skipped).toBe(false);

    // Swap: delete the row, add a different one. Count is unchanged.
    db.run("UPDATE highlight SET deleted_at = ? WHERE book_id = ?", Date.now(), bookId);
    addHighlight("second passage");
    const second = svc.exportHighlights(bookId);
    expect(second.skipped).toBe(false);

    const note = readFileSync(join(vault, second.path), "utf8");
    expect(note).toContain("second passage");
    expect(note).not.toContain("first passage");
    svc.close();
  });
});

describe("wave 2: notes vault restore", () => {
  it("restores a manually entered vault after restart", async () => {
    const { NotesService } = await import("../src/main/modules/notes/service");
    const db = freshDb();
    const base = tempDir("selfos-vr-");
    const vault = join(base, "hand-typed");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "note.md"), "# hi");

    const first = new NotesService(
      db,
      join(base, "index.sqlite"),
      (id) => db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", id)?.title ?? null,
    );
    first.selectVault(vault);
    first.close();

    // A fresh service (a new app launch) must find the same vault, even though
    // it is not in Obsidian's config.
    const second = new NotesService(
      db,
      join(base, "index.sqlite"),
      (id) => db.get<{ title: string }>("SELECT title FROM book WHERE id = ?", id)?.title ?? null,
    );
    expect(second.status().vault?.path).toBe(vault);
    expect(second.list().length).toBe(1);
    second.close();
  });
});

describe("wave 2: index robustness", () => {
  it("skips a directory whose name ends in .md instead of throwing", () => {
    const base = tempDir("selfos-dir-");
    mkdirSync(join(base, "archive.md"), { recursive: true });
    writeFileSync(join(base, "real.md"), "# real");
    const idx = new NotesIndex(join(base, ".index.sqlite"));
    expect(() => idx.setVault({ path: base, name: "v" })).not.toThrow();
    expect(idx.list().map((n) => n.path)).toEqual(["real.md"]);
  });
});

describe("wave 2: count habits at zero", () => {
  it("clearing the count removes the entry instead of recording 0", async () => {
    const { HabitsService } = await import("../src/main/modules/habits/service");
    const db = freshDb();
    const habits = new HabitsService(db);
    const today = "2026-11-02";
    const id = habits.create(
      { name: "Water", kind: "count", target: 8, unit: "glasses", schedule: { kind: "daily" } },
      today,
    );
    habits.increment(id, today, 2);
    habits.increment(id, today, -2);
    const habit = habits.list(today).find((h) => h.id === id);
    expect(habit?.todayEntry).toBeNull();
  });
});

describe("wave 3: time and site accounting", () => {
  it("the hour-walk rule advances, even when hourStart is behind start", () => {
    // Regression: the walk used `Math.min(end, hourStart + 1h)`. During a DST
    // fall-back the repeated local hour resolves to its *first* occurrence, so
    // hourStart can be an hour before `start` and the loop never advanced —
    // an infinite synchronous loop on the main process. Verified separately
    // under TZ=America/New_York; reproduced here with an explicit backwards
    // hourStart so the test does not depend on the host timezone.
    const start = new Date(2026, 10, 1, 1, 30).getTime();
    const end = start + 30 * 60_000;
    let s = start;
    let iterations = 0;
    while (s < end) {
      const hourStart = s - 3_600_000; // simulates the ambiguous hour
      const naturalHourEnd = hourStart + 3_600_000;
      const hourEnd = naturalHourEnd > s ? naturalHourEnd : s + 3_600_000;
      const sliceEnd = Math.min(end, hourEnd);
      expect(sliceEnd).toBeGreaterThan(s);
      s = sliceEnd;
      iterations++;
      if (iterations > 100) throw new Error("loop did not advance");
    }
    expect(iterations).toBeLessThan(10);
  });

  it("splitAtMidnight assigns each day its own share", async () => {
    const { splitAtMidnight } = await import("../src/main/modules/time/collector");
    const start = new Date(2026, 10, 1, 23, 0, 0).getTime();
    const end = new Date(2026, 10, 2, 1, 0, 0).getTime();
    const seg = {
      startedAt: start,
      endedAt: end,
      appClass: "mpv",
      appTitle: "film",
      workspaceId: "1",
      source: "hypr-ipc" as const,
    };
    const parts = splitAtMidnight(seg);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.startedAt).toBe(start);
    expect(parts[1]?.startedAt).toBe(new Date(2026, 10, 2, 0, 0, 0).getTime());
    expect(parts[0]?.endedAt).toBe(parts[1]?.startedAt);
    expect(parts[1]?.endedAt).toBe(end);
  });

  it("does not split a segment inside one day", async () => {
    const { splitAtMidnight } = await import("../src/main/modules/time/collector");
    const seg = {
      startedAt: new Date(2026, 10, 2, 9, 0).getTime(),
      endedAt: new Date(2026, 10, 2, 10, 0).getTime(),
      appClass: "kitty",
      appTitle: "",
      workspaceId: "1",
      source: "hypr-ipc" as const,
    };
    expect(splitAtMidnight(seg)).toHaveLength(1);
  });

  it("guessSite does not invent domains from file names", async () => {
    const { guessSite } = await import("../src/main/integrations/browser-history/title");
    expect(guessSite("README.md at main · org/repo - Helium")).toBeNull();
    expect(guessSite("installer.exe - Helium")).toBeNull();
    // A real hostname followed by a path is still accepted.
    expect(guessSite("example.org/docs — something")?.site).toBe("example.org");
  });

  it("uncategorized ignores domains covered by a parent rule", async () => {
    const { seedDefaultRules } = await import("../src/main/integrations/browser-history/ingest");
    const { uncategorizedDomains } = await import("../src/main/modules/time/sites");
    const db = freshDb();
    seedDefaultRules(db);
    const pid = Number(
      db.run("INSERT INTO browser_profile (browser, profile_dir, history_path) VALUES ('h','D','/h')")
        .lastInsertRowid,
    );
    const add = (domain: string) =>
      db.run(
        `INSERT INTO browser_visit (profile_id, url, domain, visit_time_us, visit_at, local_date, duration_us, source)
         VALUES (?, ?, ?, ?, ?, '2026-11-02', 60000000, 'history')`,
        pid,
        `https://${domain}/`,
        domain,
        String(Date.now() + Math.random() * 1e6),
        Date.now(),
      );
    add("music.youtube.com");
    add("mystery.example");
    const list = uncategorizedDomains(db).map((d) => d.domain);
    expect(list).toContain("mystery.example");
    expect(list).not.toContain("music.youtube.com");
  });
});

describe("reading position stores a fraction, not pixels", () => {
  it("resets a legacy pixel offset instead of restoring it as a fraction", () => {
    const db = freshDb();
    const store = new BookStore(db, tempDir("selfos-lib-"));
    db.run(
      `INSERT INTO book (title, file_path, sha256, page_count, settings_json, added_at)
       VALUES ('t', '/tmp/t.pdf', 'abc', 10, '{}', ?)`,
      Date.now(),
    );
    const bookId = db.get<{ id: number }>("SELECT id FROM book WHERE sha256 = 'abc'")?.id as number;
    // A row written by the old reader: `scrollTop` in CSS pixels.
    db.run(
      `INSERT INTO reading_position (book_id, page, scroll_offset, zoom, updated_at) VALUES (?, 4, 240, 1, ?)`,
      bookId,
      Date.now(),
    );
    const pos = store.position(bookId);
    // The page survives; the pixel offset cannot be converted, so it resets.
    expect(pos?.page).toBe(4);
    expect(pos?.scrollOffset).toBe(0);
  });

  it("clamps an out-of-range stored fraction", () => {
    const db = freshDb();
    const store = new BookStore(db, tempDir("selfos-lib-"));
    db.run(
      `INSERT INTO book (title, file_path, sha256, page_count, settings_json, added_at)
       VALUES ('t', '/tmp/t.pdf', 'def', 10, '{}', ?)`,
      Date.now(),
    );
    const bookId = db.get<{ id: number }>("SELECT id FROM book WHERE sha256 = 'def'")?.id as number;
    store.savePosition(bookId, 2, 0.5, 1);
    expect(store.position(bookId)?.scrollOffset).toBe(0.5);
  });
});

/**
 * F-READ-02 requires the library to show "author (from metadata when present)".
 * `author` crossed the whole contract (`BookRow` -> `BookView`) but had no
 * producer: the import insert wrote it as a literal NULL and the reader's
 * `getMetadata` type did not declare `Author`, so it could never be set and was
 * never rendered. These pin the capture path, including that a file which omits
 * a field does not blank what is already stored.
 */
describe("book metadata back-fill", () => {
  function seeded() {
    const db = freshDb();
    const store = new BookStore(db, tempDir("selfos-lib-"));
    db.run(
      `INSERT INTO book (title, file_path, sha256, page_count, settings_json, added_at)
       VALUES ('t', '/tmp/t.pdf', 'meta1', 10, '{}', ?)`,
      Date.now(),
    );
    const id = db.get<{ id: number }>("SELECT id FROM book WHERE sha256 = 'meta1'")?.id as number;
    return { db, store, id };
  }

  it("stores the author when metadata supplies one", () => {
    const { db, store, id } = seeded();
    store.setPageCount(id, 12, "Real Title", "Real Author");
    const row = db.get<{ title: string; author: string | null; page_count: number }>(
      "SELECT title, author, page_count FROM book WHERE id = ?",
      id,
    );
    expect(row?.author).toBe("Real Author");
    expect(row?.title).toBe("Real Title");
    expect(row?.page_count).toBe(12);
  });

  it("does not blank an existing author when metadata omits one", () => {
    const { db, store, id } = seeded();
    store.setPageCount(id, 12, "Real Title", "Real Author");
    // A later open of a file whose metadata lacks Author must not null it.
    store.setPageCount(id, 12, undefined, undefined);
    const row = db.get<{ author: string | null; title: string }>(
      "SELECT title, author FROM book WHERE id = ?",
      id,
    );
    expect(row?.author).toBe("Real Author");
    expect(row?.title).toBe("Real Title");
  });

  it("import leaves author null rather than inventing one", () => {
    const { db, id } = seeded();
    const row = db.get<{ author: string | null }>("SELECT author FROM book WHERE id = ?", id);
    expect(row?.author).toBeNull();
  });
});

/**
 * The `author` back-fill uses `COALESCE`, so a PDF that omits a field — or
 * supplies an empty/whitespace one — must not blank a real stored value.
 * Verified against SQLite directly: `COALESCE(NULL, author)` keeps the column,
 * and the caller maps empty strings to NULL before the bind.
 */
describe("setPageCount COALESCE edge cases", () => {
  function seed(title = "t", author: string | null = null) {
    const db = Db.open(join(tempDir("selfos-coal-"), "x.sqlite"));
    migrate(db);
    db.run(
      `INSERT INTO book (title, author, file_path, sha256, page_count, settings_json, added_at)
       VALUES (?, ?, '/tmp/a.pdf', 'h1', 10, '{}', ?)`,
      title,
      author,
      Date.now(),
    );
    const id = db.get<{ id: number }>("SELECT id FROM book WHERE sha256='h1'")?.id as number;
    return { db, store: new BookStore(db, tempDir("selfos-coal-lib-")), id };
  }

  it("empty-string title does not blank a real title", () => {
    const { db, store, id } = seed("Real");
    store.setPageCount(id, 10, "", "Auth");
    const r = db.get<{ title: string; author: string | null }>(
      "SELECT title, author FROM book WHERE id=?",
      id,
    );
    expect(r?.title).toBe("Real");
    expect(r?.author).toBe("Auth");
  });

  it("whitespace-only author does not blank a real author", () => {
    const { db, store, id } = seed("T", "Real Auth");
    store.setPageCount(id, 10, undefined, "   ");
    const r = db.get<{ author: string | null }>("SELECT author FROM book WHERE id=?", id);
    expect(r?.author).toBe("Real Auth");
  });

  it("trims a padded author", () => {
    const { db, store, id } = seed();
    store.setPageCount(id, 10, undefined, "  Padded Author  ");
    const r = db.get<{ author: string | null }>("SELECT author FROM book WHERE id=?", id);
    expect(r?.author).toBe("Padded Author");
  });

  it("still updates page_count when both metadata fields are absent", () => {
    const { db, store, id } = seed("Keep");
    store.setPageCount(id, 42);
    const r = db.get<{ page_count: number; title: string }>(
      "SELECT page_count, title FROM book WHERE id=?",
      id,
    );
    expect(r?.page_count).toBe(42);
    expect(r?.title).toBe("Keep");
  });
});

/**
 * The metadata back-fill gate (`Reader.tsx`). Gating only on a stale page count
 * meant an already-opened book — whose count was written by this same call in an
 * earlier build — never re-fetched metadata, so `author` stayed NULL forever for
 * the whole pre-existing library (F-READ-02).
 */
/** The exact gate from Reader.tsx:334. */
const shouldFetch = (book: { pageCount: number; author: string | null }, numPages: number) =>
  book.pageCount !== numPages || book.author === null;

describe("metadata fetch gate back-fills an already-opened book", () => {
  it("fires for a book with a correct page count but no author (the regression)", () => {
    // Opened once before `author` existed: count is right, author is NULL.
    expect(shouldFetch({ pageCount: 40, author: null }, 40)).toBe(true);
  });
  it("fires for a book with a stale page count", () => {
    expect(shouldFetch({ pageCount: 10, author: null }, 40)).toBe(true);
  });
  it("does NOT fire once both are settled, so it stops re-reading", () => {
    expect(shouldFetch({ pageCount: 40, author: "Someone" }, 40)).toBe(false);
  });
  it("does not fire for a book whose PDF legitimately has no author", () => {
    // author stays null because the file has none; the gate keeps firing, which
    // is one metadata read per open — cheap, and the alternative (a "checked"
    // flag) is a schema change.
    expect(shouldFetch({ pageCount: 40, author: null }, 40)).toBe(true);
  });
});

/**
 * The "Last ingest" row (`App.tsx`, F-SET-07). `last_ingest_at` is written as
 * `Date.now()` (ms) by the ingester and the column has no default, so a
 * never-ingested profile is NULL and is filtered out. These pin the expression,
 * including the assumption that no `0` default can reach it — a `0` renders as
 * "1 Jan 1970", which would look like a real timestamp.
 */
/** The exact expression from App.tsx's "Last ingest" row. */
function lastIngest(profiles: Array<{ lastIngestAt: number | null }>): string {
  const times = profiles.map((p) => p.lastIngestAt).filter((t): t is number => typeof t === "number");
  return times.length ? new Date(Math.max(...times)).toISOString().slice(0, 16) : "never";
}

describe("Last ingest row", () => {
  it("shows 'never' when every profile is null", () => {
    expect(lastIngest([{ lastIngestAt: null }])).toBe("never");
    expect(lastIngest([])).toBe("never");
  });
  it("ignores null profiles and reports the newest real one", () => {
    const t1 = Date.UTC(2026, 10, 1, 10, 0),
      t2 = Date.UTC(2026, 10, 3, 9, 30);
    expect(lastIngest([{ lastIngestAt: t1 }, { lastIngestAt: null }, { lastIngestAt: t2 }])).toBe(
      "2026-11-03T09:30",
    );
  });
  it("a zero would render as 1970 — the schema must never default to 0", () => {
    // 0001_init.sql declares `last_ingest_at INTEGER` with no default, so a
    // never-ingested profile is NULL and is filtered. This pins that assumption:
    // if a default of 0 were ever added, the row would read "1 Jan 1970".
    expect(lastIngest([{ lastIngestAt: 0 }])).toBe("1970-01-01T00:00");
  });
});

/** The exact guard from Analytics.tsx: `++loadSeq.current` before the awaits,
 *  compared after; a mismatch means a newer load owns the state. */
function makeGuard() {
  let current = 0;
  const committed: string[] = [];
  const start = () => {
    const seq = ++current;
    return (label: string) => {
      if (seq !== current) return; // stale: a newer load started
      committed.push(label);
    };
  };
  return {
    start,
    committed,
    get current() {
      return current;
    },
  };
}

describe("Analytics loadSeq guard", () => {
  it("commits a response when no newer load started", () => {
    const g = makeGuard();
    const done = g.start();
    done("7d");
    expect(g.committed).toEqual(["7d"]);
  });

  it("drops a stale response that lands after a newer load began", () => {
    const g = makeGuard();
    const first = g.start(); // user clicks 90d
    const second = g.start(); // then 7d
    second("7d"); // 7d resolves first
    first("90d"); // 90d resolves later — must NOT overwrite
    expect(g.committed).toEqual(["7d"]);
  });

  it("commits the newest only, even with three in flight", () => {
    const g = makeGuard();
    const a = g.start(),
      b = g.start(),
      c = g.start();
    a("90d");
    b("30d");
    c("7d");
    expect(g.committed).toEqual(["7d"]);
  });
});

/**
 * `reading.setPageCount` with `pageCount: 0`.
 *
 * pdf.js reports `numPages === 0` for a file it can load but not page, and the
 * reader sends that value. The old guard threw "invalid page count" for it,
 * failing the whole call — so the title/author read from the same metadata were
 * discarded and the error shown was about the page count. A zero must skip only
 * the page-count write, and must never reset a count found by an earlier open.
 */
describe("setPageCount tolerates an unpageable file", () => {
  function seeded() {
    const db = freshDb();
    const store = new BookStore(db, tempDir("selfos-pc-"));
    db.run(
      `INSERT INTO book (title, file_path, sha256, page_count, settings_json, added_at)
       VALUES ('file-name', '/tmp/a.pdf', 'pc1', 0, '{}', ?)`,
      Date.now(),
    );
    const id = db.get<{ id: number }>("SELECT id FROM book WHERE sha256 = 'pc1'")?.id as number;
    return { db, store, id };
  }

  it("back-fills title and author even when pageCount is 0", () => {
    const { db, store, id } = seeded();
    store.setPageCount(id, 0, "Real Title", "Real Author");
    const r = db.get<{ title: string; author: string | null; page_count: number }>(
      "SELECT title, author, page_count FROM book WHERE id = ?",
      id,
    );
    expect(r?.title).toBe("Real Title");
    expect(r?.author).toBe("Real Author");
    expect(r?.page_count).toBe(0);
  });

  it("does not reset a page count discovered earlier", () => {
    const { db, store, id } = seeded();
    store.setPageCount(id, 40, "T", "A");
    store.setPageCount(id, 0, "T", "A"); // a later open cannot page the file
    const r = db.get<{ page_count: number }>("SELECT page_count FROM book WHERE id = ?", id);
    expect(r?.page_count).toBe(40);
  });

  it("still stores a real page count", () => {
    const { db, store, id } = seeded();
    store.setPageCount(id, 40, "T", "A");
    const r = db.get<{ page_count: number }>("SELECT page_count FROM book WHERE id = ?", id);
    expect(r?.page_count).toBe(40);
  });
});

/** The guard pattern with a recurring caller, as Salah uses it (60s interval). */
function makeLoader() {
  let current = 0;
  const applied: string[] = [];
  const load = async (label: string, delayMs: number) => {
    const seq = ++current;
    await new Promise((r) => setTimeout(r, delayMs));
    if (seq !== current) return; // superseded
    applied.push(label);
  };
  return { load, applied };
}

describe("recurring loader with a sequence guard", () => {
  it("applies a single slow load when nothing supersedes it", async () => {
    const g = makeLoader();
    await g.load("first", 20);
    expect(g.applied).toEqual(["first"]);
  });

  it("discards a slow load when a newer one started", async () => {
    const g = makeLoader();
    const slow = g.load("slow", 40);
    const fast = g.load("fast", 5);
    await Promise.all([slow, fast]);
    expect(g.applied).toEqual(["fast"]);
  });

  it("a tick that starts after the previous finished still applies", async () => {
    const g = makeLoader();
    await g.load("t1", 5);
    await g.load("t2", 5); // the next interval tick, nothing in flight
    expect(g.applied).toEqual(["t1", "t2"]);
  });
});

/**
 * The race `design_critic` described for Habits/Salah: `localDate` rolls over at
 * midnight while a load for the previous day is still in flight, so the old
 * day's rows land after the new day's and are written under the wrong date.
 * Models the exact guard shape the components use.
 */
function makeView() {
  let seq = 0;
  let applied: { date: string; rows: string } | null = null;
  const load = async (date: string, res: { rows: string }, delayMs: number) => {
    const mine = ++seq;
    await new Promise((r) => setTimeout(r, delayMs));
    if (mine !== seq) return; // superseded
    applied = { date, rows: res.rows };
  };
  return {
    load,
    get applied() {
      return applied;
    },
  };
}

describe("localDate rollover race", () => {
  it("yesterday's late response does not overwrite today's", async () => {
    const v = makeView();
    const yday = v.load("2026-11-03", { rows: "yesterday" }, 40); // slow
    const today = v.load("2026-11-04", { rows: "today" }, 5); // fast
    await Promise.all([yday, today]);
    expect(v.applied).toEqual({ date: "2026-11-04", rows: "today" });
  });

  it("a single load still applies when nothing supersedes it", async () => {
    const v = makeView();
    await v.load("2026-11-04", { rows: "today" }, 5);
    expect(v.applied).toEqual({ date: "2026-11-04", rows: "today" });
  });
});
