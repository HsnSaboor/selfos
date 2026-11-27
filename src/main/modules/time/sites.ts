/**
 * Site-time aggregation (PRD F-TIME-04, F-TIME-05, F-TIME-06, F-TIME-07).
 *
 * Two sources feed site time and they must never be summed blindly:
 *
 *  - `history`     — per-visit dwell from the browser's own database. Accurate
 *                    when the browser writes it (many visits carry 0).
 *  - `window-title`— focused seconds attributed to a site inferred from the
 *                    title. Used only for time history does not cover.
 *
 * `siteUsage` therefore reconciles them per domain with a **union** of the two
 * interval sets: never a sum (the same moment can appear in both), never a max
 * (max is only correct when one set contains the other, and a watermark lag
 * makes them disjoint). Every row keeps its source so the UI can show
 * provenance (D-05).
 */
import type { Db } from "../../db/driver";
import { isMediaUrl, MEDIA_RULES } from "../../integrations/browser-history/ingest";

export interface SiteUsage {
  domain: string;
  category: string;
  distracting: boolean;
  media: boolean;
  seconds: number;
  visits: number;
  /** Which source contributed the seconds. */
  source: "history" | "window-title" | "mixed";
  historySeconds: number;
  titleSeconds: number;
}

export interface CategoryUsage {
  category: string;
  seconds: number;
  /**
   * Fraction of *browser open* time during which at least one page in this
   * category was loaded. Shares can sum past 1 because a background tab and a
   * foreground tab are open at the same time; the UI says so rather than
   * pretending the categories partition the day.
   */
  share: number;
  distracting: boolean;
}

export interface SiteTotals {
  /** Union across every domain: time the browser had at least one page open. */
  webSeconds: number;
  /** Union restricted to distracting domains (F-TIME-10). */
  distractingSeconds: number;
  /** Union restricted to media domains. */
  mediaSeconds: number;
}

export interface WatchTime {
  seconds: number;
  bySite: Array<{ domain: string; seconds: number }>;
  /** F-TIME-06 per-title breakdown, where the title was recorded. */
  byTitle: Array<{ title: string; seconds: number }>;
}

function categoryFor(
  rules: Map<string, { category: string; distracting: number; is_media: number }>,
  domain: string,
): { category: string; distracting: boolean; media: boolean } {
  // Match the domain itself, then each parent domain, so a rule on
  // `youtube.com` covers `music.youtube.com`.
  let probe = domain;
  for (;;) {
    const rule = rules.get(probe);
    if (rule)
      return { category: rule.category, distracting: rule.distracting === 1, media: rule.is_media === 1 };
    const dot = probe.indexOf(".");
    if (dot === -1) break;
    probe = probe.slice(dot + 1);
  }
  return { category: "Uncategorized", distracting: false, media: false };
}

export interface Interval {
  start: number;
  end: number;
}

/**
 * Total time covered by a set of intervals, counting overlap once.
 *
 * Chromium's `visit_duration` is wall time the page stayed open, *including
 * background tabs*, so two tabs on the same site report overlapping hours and
 * a naive SUM can exceed the length of the day. Dwell for a domain is the union
 * of its visits, not their sum.
 */
export function unionSeconds(intervals: Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return 0;

  let totalMs = 0;
  let curStart = sorted[0]?.start ?? 0;
  let curEnd = sorted[0]?.end ?? 0;
  for (const i of sorted.slice(1)) {
    if (i.start <= curEnd) {
      if (i.end > curEnd) curEnd = i.end;
    } else {
      totalMs += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    }
  }
  totalMs += curEnd - curStart;
  return Math.round(totalMs / 1000);
}

export function loadRules(db: Db): Map<string, { category: string; distracting: number; is_media: number }> {
  const rows = db.all<{ domain: string; category: string; is_distracting: number; is_media: number }>(
    "SELECT domain, category, is_distracting, is_media FROM domain_rule",
  );
  return new Map(
    rows.map((r) => [
      r.domain,
      { category: r.category, distracting: r.is_distracting, is_media: r.is_media },
    ]),
  );
}

/**
 * Site time for one day.
 *
 * Window-title time is attributed per browser window class only when the
 * title names a site; unidentifiable time stays in the app total and out of
 * the site report, which is the honest outcome.
 */
export function siteUsage(db: Db, localDate: string): SiteUsage[] {
  const rules = loadRules(db);
  const byDomain = new Map<string, SiteUsage>();

  const visits = db.all<{ domain: string; url: string; visit_at: number; duration_us: number }>(
    `SELECT domain, url, visit_at, duration_us FROM browser_visit
      WHERE local_date = ? AND source = 'history'`,
    localDate,
  );
  const historyIntervals = groupIntervals(visits);
  for (const [domain, intervals] of historyIntervals) {
    const meta = categoryFor(rules, domain);
    // The user's `is_media` rule applies to history rows too: marking a domain
    // as media and then ignoring the mark made watchTime list it with 0 seconds.
    const media = meta.media || visits.some((v) => v.domain === domain && isMediaUrl(v.url));
    const seconds = unionSeconds(intervals);
    if (seconds <= 0) continue;
    byDomain.set(domain, {
      domain,
      ...meta,
      media,
      seconds,
      visits: intervals.length,
      source: "history",
      historySeconds: seconds,
      titleSeconds: 0,
    });
  }

  // Window-title rows are stored in browser_visit with source = 'window-title'.
  // They come from focus segments, which never overlap, so a union is exact
  // and also protects against a duplicated segment.
  const titleRows = db.all<{ domain: string; url: string; visit_at: number; duration_us: number }>(
    `SELECT domain, url, visit_at, duration_us FROM browser_visit
      WHERE local_date = ? AND source = 'window-title'`,
    localDate,
  );
  const titleIntervals = groupIntervals(titleRows);
  for (const [domain, intervals] of titleIntervals) {
    const meta = categoryFor(rules, domain);
    const seconds = unionSeconds(intervals);
    if (seconds <= 0) continue;
    const media = meta.media || titleRows.some((r) => r.domain === domain && isMediaUrl(r.url));
    const existing = byDomain.get(domain);
    if (existing) {
      // One union over both interval sets: max under-counts disjoint intervals,
      // sum double counts overlap (round-12).
      existing.seconds = unionSeconds([...(historyIntervals.get(domain) ?? []), ...intervals]);
      existing.titleSeconds += seconds;
      existing.source = existing.historySeconds > 0 ? "mixed" : "window-title";
      existing.visits += intervals.length;
      existing.media = existing.media || media;
    } else {
      byDomain.set(domain, {
        domain,
        ...meta,
        media,
        seconds,
        visits: intervals.length,
        source: "window-title",
        historySeconds: 0,
        titleSeconds: seconds,
      });
    }
  }

  return [...byDomain.values()].sort((a, b) => b.seconds - a.seconds);
}

/** Group (visit_at, duration) rows by domain into [start, end] intervals. */
function groupIntervals(
  rows: Array<{ domain: string; visit_at: number; duration_us: number }>,
): Map<string, Interval[]> {
  const out = new Map<string, Interval[]>();
  for (const r of rows) {
    const list = out.get(r.domain) ?? [];
    // Clip at the local day boundary: a 23:50 visit that runs 30 min belongs
    // 10 min to this day and 20 min to the next, not 30 to this one (D-04).
    const end = Math.min(r.visit_at + Math.round(r.duration_us / 1000), localDayEnd(r));
    if (end > r.visit_at) list.push({ start: r.visit_at, end });
    out.set(r.domain, list);
  }
  return out;
}

/** Local midnight at the end of the visit's own day. */
function localDayEnd(row: { visit_at: number }): number {
  const d = new Date(row.visit_at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Totals over the union of *all* visits.
 *
 * Summing per-domain time is wrong: a browser can have many tabs open at once,
 * so per-site numbers overlap and their sum can exceed the length of the day
 * (observed: 15.4 h of site time in a 13.6 h day). The only defensible total is
 * the union — the wall-clock time during which the browser had any page open.
 */
export function siteTotals(db: Db, localDate: string): SiteTotals {
  const rules = loadRules(db);
  const rows = db.all<{ domain: string; url: string; source: string; visit_at: number; duration_us: number }>(
    "SELECT domain, url, source, visit_at, duration_us FROM browser_visit WHERE local_date = ?",
    localDate,
  );
  const all: Interval[] = [];
  const distracting: Interval[] = [];
  const media: Interval[] = [];
  for (const r of rows) {
    const iv = { start: r.visit_at, end: r.visit_at + Math.round(r.duration_us / 1000) };
    if (iv.end <= iv.start) continue;
    all.push(iv);
    const meta = categoryFor(rules, r.domain);
    if (meta.distracting) distracting.push(iv);
    // Path-aware for history rows: `youtube.com/feed` is browsing, not watching.
    // Window-title rows only carry the bare domain, so they fall back to the
    // domain-level media rule.
    const isMedia = meta.media || (r.source === "history" ? isMediaUrl(r.url) : isMediaDomain(r.domain));
    if (isMedia) media.push(iv);
  }
  return {
    webSeconds: unionSeconds(all),
    distractingSeconds: unionSeconds(distracting),
    mediaSeconds: unionSeconds(media),
  };
}

/**
 * Category time, computed from the same intervals as the site rows.
 *
 * `sites[].seconds` is a union per *domain*, so adding domains together
 * double counts any moment two tabs were open. Category seconds must
 * therefore be the union over the whole category, not a sum of its domains —
 * otherwise a category can exceed the browser-open total (observed: 121%).
 */
export function categoryUsage(
  db: Db,
  localDate: string,
  sites: SiteUsage[],
  webSeconds: number,
): CategoryUsage[] {
  const rules = loadRules(db);
  const rows = db.all<{ domain: string; visit_at: number; duration_us: number }>(
    "SELECT domain, visit_at, duration_us FROM browser_visit WHERE local_date = ?",
    localDate,
  );
  const byCategory = new Map<string, { intervals: Interval[]; distracting: boolean }>();
  for (const r of rows) {
    const meta = categoryFor(rules, r.domain);
    // A category is distracting if *any* of its domains is: the flag is a
    // property of the category the user sees, not of whichever row was read
    // first (round-12 nit).
    const entry = byCategory.get(meta.category) ?? { intervals: [], distracting: false };
    entry.distracting = entry.distracting || meta.distracting;
    const end = r.visit_at + Math.round(r.duration_us / 1000);
    if (end > r.visit_at) entry.intervals.push({ start: r.visit_at, end });
    byCategory.set(meta.category, entry);
  }

  const total = webSeconds > 0 ? webSeconds : sites.reduce((a, s) => a + s.seconds, 0) || 1;
  return [...byCategory.entries()]
    .map(([category, v]) => {
      const seconds = unionSeconds(v.intervals);
      return { category, seconds, share: Math.min(1, seconds / total), distracting: v.distracting };
    })
    .filter((c) => c.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * Watch time (F-TIME-06): media sites from history plus local players.
 *
 * Local player time is not a domain, so it is reported separately by the
 * caller from `day_aggregate.media_seconds`; this function returns the
 * browser half only.
 */
export function watchTime(db: Db, localDate: string, known?: SiteUsage[]): WatchTime {
  const sites = known ?? siteUsage(db, localDate);
  const mediaDomains = new Set(sites.filter((s) => s.media || isMediaDomain(s.domain)).map((s) => s.domain));
  const rows = db
    .all<{
      domain: string;
      url: string;
      title: string | null;
      source: string;
      visit_at: number;
      duration_us: number;
    }>(
      "SELECT domain, url, title, source, visit_at, duration_us FROM browser_visit WHERE local_date = ?",
      localDate,
    )
    .filter((r) => mediaDomains.has(r.domain))
    // Path-aware for history: a YouTube feed page is not watch time.
    .filter((r) =>
      r.source === "history" ? isMediaUrl(r.url) : isMediaDomain(r.domain) || mediaDomains.has(r.domain),
    );

  // Per-domain and per-title unions use the same filtered rows as the total, so
  // the breakdown can never exceed the headline (round-12).
  const byDomain = new Map<string, { start: number; end: number }[]>();
  const byTitle = new Map<string, { start: number; end: number }[]>();
  for (const r of rows) {
    const end = Math.min(r.visit_at + Math.round(r.duration_us / 1000), localDayEnd(r));
    if (end <= r.visit_at) continue;
    const iv = { start: r.visit_at, end };
    const d = byDomain.get(r.domain) ?? [];
    d.push(iv);
    byDomain.set(r.domain, d);
    if (r.title) {
      const key = `${r.domain} — ${r.title}`;
      const t = byTitle.get(key) ?? [];
      t.push(iv);
      byTitle.set(key, t);
    }
  }
  const titles = [...byTitle.entries()]
    .map(([title, intervals]) => ({ title, seconds: unionSeconds(intervals) }))
    .filter((t) => t.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  return {
    // Two media tabs open at once still only count once.
    seconds: unionSeconds(
      rows.map((r) => ({
        start: r.visit_at,
        end: Math.min(r.visit_at + Math.round(r.duration_us / 1000), localDayEnd(r)),
      })),
    ),
    bySite: [...byDomain.entries()]
      .map(([domain, intervals]) => ({ domain, seconds: unionSeconds(intervals) }))
      .filter((s) => s.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds),
    byTitle: titles,
  };
}

/**
 * Is this domain a media site, judged by the same rules the ingester uses?
 *
 * This was a hand-maintained `Set` listing exactly the domains of `MEDIA_RULES`
 * (`integrations/browser-history/ingest.ts`), so adding a streaming service
 * there left watch time blind to it here — and `sites.ts` already imports
 * `isMediaUrl` from that module, so the second list bought nothing.
 *
 * The **domain** is matched ignoring `pathPrefix`, which is the distinction this
 * function exists to draw: a title row carries no path, so it can only be judged
 * by host, while a history row carries a URL and goes through `isMediaUrl` for
 * the path-aware answer. Filtering on `pathPrefix` here would drop
 * `youtube.com` altogether — every one of its rules is path-scoped — and
 * `watchTime` would then report zero for the most-watched site on the machine.
 *
 * The domain is walked up its labels because `MEDIA_RULES` names bare hosts,
 * and a row can carry a subdomain (`m.youtube.com`).
 */
function isMediaDomain(domain: string): boolean {
  let probe = domain;
  for (;;) {
    if (MEDIA_RULES.some((r) => r.domain === probe)) return true;
    const dot = probe.indexOf(".");
    if (dot === -1) return false;
    probe = probe.slice(dot + 1);
  }
}

/** Per-page dwell for one domain, largest dwell first (F-TIME-04). */
export function pagesForDomain(
  db: Db,
  domain: string,
  localDate: string,
  limit = 50,
): Array<{
  url: string;
  title: string | null;
  seconds: number;
  visits: number;
}> {
  // Pages carry the same overlap problem as domains: revisiting a page twice
  // in the day must count the union, not the sum.
  const rows = db.all<{ url: string; title: string | null; visit_at: number; duration_us: number }>(
    `SELECT url, MAX(title) AS title, visit_at, duration_us
       FROM browser_visit
      WHERE local_date = ? AND domain = ?
      GROUP BY url, visit_at, duration_us`,
    localDate,
    domain,
  );
  const byUrl = new Map<string, { title: string | null; intervals: Interval[] }>();
  for (const r of rows) {
    // Window-title rows all carry the synthetic `https://<domain>/`; their page
    // is the title, so key those by title or every fallback page collapses into
    // one row (round-12).
    const key = r.url === `https://${domain}/` && r.title ? `title:${r.title}` : r.url;
    const entry = byUrl.get(key) ?? { title: r.title, intervals: [] };
    entry.intervals.push({ start: r.visit_at, end: r.visit_at + Math.round(r.duration_us / 1000) });
    byUrl.set(key, entry);
  }
  return [...byUrl.entries()]
    .map(([url, v]) => ({
      url,
      title: v.title,
      seconds: unionSeconds(v.intervals),
      visits: v.intervals.length,
    }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

/** Domains that have never been categorised, for bulk classification (F-TIME-07). */
export function uncategorizedDomains(db: Db, limit = 50): Array<{ domain: string; seconds: number }> {
  // Filter in JS via the same parent-domain lookup the site table uses. A plain
  // `NOT EXISTS (r.domain = v.domain)` listed `music.youtube.com` as
  // uncategorized even though `youtube.com` has a rule and the UI shows it as
  // Entertainment. The candidate list is bounded by a GROUP BY instead of a
  // full scan of a table that grows forever (round-12).
  const rules = loadRules(db);
  const counts = db.all<{ domain: string; n: number }>(
    "SELECT domain, COUNT(*) AS n FROM browser_visit GROUP BY domain",
  );
  const candidates = counts
    .filter((r) => categoryFor(rules, r.domain).category === "Uncategorized")
    .sort((a, b) => b.n - a.n)
    .slice(0, limit * 4)
    .map((r) => r.domain);
  if (candidates.length === 0) return [];
  const rows = db.all<{ domain: string; visit_at: number; duration_us: number }>(
    `SELECT domain, visit_at, duration_us FROM browser_visit WHERE domain IN (${candidates.map(() => "?").join(",")})`,
    ...candidates,
  );
  return [...groupIntervals(rows).entries()]
    .map(([domain, intervals]) => ({ domain, seconds: unionSeconds(intervals) }))
    .filter((d) => d.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

/**
 * Set a domain's category. Upserts so the user can reclassify a default.
 *
 * `distracting` and `media` are optional and *preserve the existing value* when
 * omitted. Recategorising from the Sites screen sends only the category, and
 * treating the missing flags as `false` silently demoted every site the user
 * touched — turning off its distraction marking (F-TIME-10) and its watch-time
 * classification (F-TIME-06) with no way to restore them.
 */
export function setDomainRule(
  db: Db,
  domain: string,
  category: string,
  opts: { distracting?: boolean; media?: boolean } = {},
): void {
  const clean = domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!clean) throw new Error("domain is required");
  if (!category.trim()) throw new Error("category is required");

  const existing = db.get<{ is_distracting: number; is_media: number }>(
    "SELECT is_distracting, is_media FROM domain_rule WHERE domain = ?",
    clean,
  );
  const distracting = opts.distracting ?? (existing ? existing.is_distracting === 1 : false);
  const media = opts.media ?? (existing ? existing.is_media === 1 : false);

  db.run(
    `INSERT INTO domain_rule (domain, category, is_distracting, is_media, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       category = excluded.category,
       is_distracting = excluded.is_distracting,
       is_media = excluded.is_media,
       updated_at = excluded.updated_at`,
    clean,
    category.trim(),
    distracting ? 1 : 0,
    media ? 1 : 0,
    Date.now(),
  );
}

/** Category label for a domain, using the same rules the site table uses. */
export function categoryForDomain(db: Db, domain: string, rules = loadRules(db)): string {
  return categoryFor(rules, domain).category;
}
