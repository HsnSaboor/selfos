/**
 * One catalogue of the sites the app knows (F-TIME-05/06/07).
 *
 * The same domains used to be declared three times — title suffixes, media
 * rules and default categories — and they had drifted: `nebula.tv` was media
 * but could not be recognised from a title, and ten title-known sites had no
 * default category. A new streaming site is now one row here.
 */

export interface SiteDef {
  domain: string;
  /** Title suffix (regex source, case-insensitive) that names this site. */
  title?: string;
  category?: string;
  distracting?: boolean;
  media?: boolean;
  /** Path prefix that counts as watching rather than browsing. */
  pathPrefix?: string;
}

export const SITE_CATALOG: SiteDef[] = [
  // Longest/most specific title patterns first: "Google Docs" before "Google".
  {
    domain: "youtube.com",
    title: "\\bYouTube\\s*(?:Music|Shorts)?$",
    category: "Entertainment",
    distracting: true,
    media: true,
    pathPrefix: "/watch",
  },
  { domain: "youtube.com", media: true, pathPrefix: "/shorts" },
  { domain: "youtube.com", media: true, pathPrefix: "/live" },
  { domain: "m.youtube.com", media: true, pathPrefix: "/watch" },
  {
    domain: "netflix.com",
    title: "\\bNetflix$",
    category: "Entertainment",
    distracting: true,
    media: true,
    pathPrefix: "/watch",
  },
  { domain: "twitch.tv", title: "\\bTwitch$", category: "Entertainment", distracting: true, media: true },
  { domain: "vimeo.com", title: "\\bVimeo$", category: "Entertainment", distracting: true, media: true },
  {
    domain: "primevideo.com",
    title: "\\bPrime Video$",
    category: "Entertainment",
    distracting: true,
    media: true,
  },
  {
    domain: "disneyplus.com",
    title: "\\bDisney\\+$",
    category: "Entertainment",
    distracting: true,
    media: true,
  },
  {
    domain: "crunchyroll.com",
    title: "\\bCrunchyroll$",
    category: "Entertainment",
    distracting: true,
    media: true,
  },
  { domain: "nebula.tv", title: "\\bNebula$", category: "Entertainment", distracting: true, media: true },
  { domain: "github.com", title: "\\bGitHub$", category: "Work" },
  { domain: "gitlab.com", title: "\\bGitLab$", category: "Work" },
  { domain: "reddit.com", title: "\\bReddit$", category: "Social", distracting: true },
  { domain: "x.com", title: "^x$", category: "Social", distracting: true },
  { domain: "twitter.com", category: "Social", distracting: true },
  { domain: "instagram.com", title: "\\bInstagram$", category: "Social", distracting: true },
  { domain: "facebook.com", title: "\\bFacebook$", category: "Social", distracting: true },
  { domain: "tiktok.com", category: "Social", distracting: true },
  { domain: "linkedin.com", title: "\\bLinkedIn$", category: "Social" },
  { domain: "docs.google.com", title: "\\bGoogle Docs$", category: "Work" },
  { domain: "drive.google.com", title: "\\bGoogle Drive$", category: "Work" },
  { domain: "mail.google.com", title: "\\bGmail$", category: "Communication" },
  { domain: "google.com", title: "\\bGoogle Search$", category: "Work" },
  { domain: "google.com", title: "\\bGoogle$", category: "Work" },
  { domain: "wikipedia.org", title: "\\bWikipedia$", category: "Reference" },
  { domain: "stackoverflow.com", title: "\\bStack Overflow$", category: "Work" },
  { domain: "developer.mozilla.org", category: "Work" },
  { domain: "docs.rs", category: "Work" },
  { domain: "crates.io", category: "Work" },
  { domain: "npmjs.com", category: "Work" },
  { domain: "chatgpt.com", title: "\\bChatGPT$", category: "Work" },
  { domain: "claude.ai", title: "\\bClaude$", category: "Work" },
  { domain: "figma.com", title: "\\bFigma$", category: "Work" },
  { domain: "notion.so", title: "\\bNotion$", category: "Work" },
  {
    domain: "openfront.io",
    title: "\\bOpenFront(?:\\s*\\(ALPHA\\))?$",
    category: "Entertainment",
    distracting: true,
  },
];

export interface MediaRule {
  domain: string;
  pathPrefix?: string | null;
}

export const MEDIA_RULES: MediaRule[] = SITE_CATALOG.filter((s) => s.media || s.pathPrefix).map((s) => ({
  domain: s.domain,
  ...(s.pathPrefix ? { pathPrefix: s.pathPrefix } : {}),
}));

export const DEFAULT_RULES: Array<{ domain: string; category: string; distracting: boolean }> =
  SITE_CATALOG.filter((s): s is SiteDef & { category: string } => Boolean(s.category)).map((s) => ({
    domain: s.domain,
    category: s.category,
    distracting: s.distracting ?? false,
  }));

/** Title suffix matchers, longest/most specific first (catalog order). */
export const SUFFIX_SITES: Array<[RegExp, string]> = SITE_CATALOG.filter((s) => s.title).map((s) => [
  new RegExp(s.title as string, "i"),
  s.domain,
]);
