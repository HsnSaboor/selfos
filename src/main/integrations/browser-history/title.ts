/**
 * Site identification from window titles (PRD F-TIME-05).
 *
 * When history is unavailable — the browser is locked, the profile is missing,
 * or the site never reached history — the focused window's title still names
 * what is on screen. Observed shapes on this machine:
 *
 *   "OpenFront (ALPHA) - Helium"
 *   "Some video - YouTube"
 *   "Issue #12 · org/repo - GitHub"
 *   "Search results | Figma"
 *
 * The parser is deliberately conservative: it only reports a site when the
 * title carries a recognisable site name, so unknown pages stay unattributed
 * rather than inventing a domain.
 */

export interface SiteGuess {
  site: string;
  /** Why this site was chosen, for the health/UI provenance line. */
  basis: "suffix" | "hostname";
}

export { SUFFIX_SITES } from "./catalog";

import { SUFFIX_SITES } from "./catalog";

/**
 * Chromium appends the browser's own name to every window title
 * ("Some video - YouTube - Helium", "OpenFront (ALPHA) - Helium"). It must be
 * stripped first or the suffix matcher sees "Helium" and gives up.
 */
const BROWSER_SUFFIX =
  /\s+[-|·]\s+(?:helium|chromium|google chrome|brave|firefox|zen|microsoft edge|vivaldi)\s*$/i;

export function stripBrowserSuffix(title: string): string {
  return title.replace(BROWSER_SUFFIX, "").trim();
}

/** Browser window classes seen on this machine. */
export const BROWSER_CLASSES = new Set([
  "helium",
  "chromium",
  "google-chrome",
  "brave-browser",
  "firefox",
  "zen",
]);

export function isBrowserClass(appClass: string): boolean {
  return BROWSER_CLASSES.has(appClass.toLowerCase());
}

/**
 * Guess the site a browser window is showing.
 *
 * Splits on the last ` - ` / ` | ` / ` · ` separator and matches the suffix.
 * Returns null for anything unrecognised — an invented domain would silently
 * pollute the site report.
 */
export function guessSite(title: string | null | undefined): SiteGuess | null {
  if (!title) return null;
  const trimmed = stripBrowserSuffix(title.trim());
  if (!trimmed) return null;

  // After the browser name is gone, titles end with "<page> - <site>" or
  // "<page> | <site>".
  const parts = trimmed.split(/\s+[-|·]\s+/);
  const candidates = parts.length > 1 ? [parts[parts.length - 1] ?? "", trimmed] : [trimmed];

  for (const candidate of candidates) {
    for (const [pattern, site] of SUFFIX_SITES) {
      if (pattern.test(candidate.trim())) return { site, basis: "suffix" };
    }
  }

  // A title that starts with a hostname followed by a path or separator is
  // unambiguous. The TLD must be letters and the match must end at a boundary:
  // without that, ordinary file names ("README.md", "foo.exe") became invented
  // domains and polluted the site report.
  const host = trimmed.match(/^((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/|\s|$)/i);
  if (host?.[1] && !/\.(md|exe|txt|pdf|zip|js|ts|json|png|jpg)$/i.test(host[1])) {
    return { site: host[1].toLowerCase().replace(/^www\./, ""), basis: "hostname" };
  }

  return null;
}

/** Strip the trailing site name, leaving the page title for per-title reports. */
export function pageTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const parts = title.trim().split(/\s+[-|·]\s+/);
  if (parts.length < 2) return title.trim() || null;
  return parts.slice(0, -1).join(" - ").trim() || null;
}
