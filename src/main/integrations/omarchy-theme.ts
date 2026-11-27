/**
 * Omarchy theme adapter (STACK.md §8).
 * Reads ~/.local/state/omarchy/current/theme/colors.toml and maps it to tokens.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThemeTokens } from "../../shared/api";

const THEME_DIR = join(homedir(), ".local/state/omarchy/current/theme");
/** Omarchy's own change counter; a switch bumps it even if mtimes are preserved. */
const THEME_GENERATION = join(homedir(), ".local/state/omarchy/current/theme.generation");

/** Minimal TOML reader for the flat `key = "value"` files Omarchy ships. */
function parseFlatToml(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      // Quoted: the value ends at the matching quote, so a trailing comment is
      // not part of it (`key = "#fff" # note`).
      const quote = value.charAt(0);
      const end = value.indexOf(quote, 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      // Bare value: an inline comment starts at the first ` #`.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length !== 6) return Number.NaN;
  const channels = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const r = channels[0] ?? 0;
  const g = channels[1] ?? 0;
  const b = channels[2] ?? 0;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  if (Number.isNaN(l1) || Number.isNaN(l2)) return Number.NaN;
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text/surface pair the UI puts together, for the AA gate. */
export function contrastPairs(t: ThemeTokens): Array<[string, string, string]> {
  return [
    ["foreground/background", t.foreground, t.background],
    ["foreground/raised", t.foreground, t.raised],
    ["muted/background", t.muted, t.background],
    ["muted/raised", t.muted, t.raised],
    ["accent/background", t.accent, t.background],
  ];
}

export const FALLBACK_THEME: ThemeTokens = {
  name: "SelfOS fallback",
  mode: "dark",
  background: "#282828",
  sunken: "#1e1e1e",
  raised: "#3c3836",
  foreground: "#d4be98",
  muted: "#b0a292",
  selection: "#504945",
  accent: "#7daea3",
  palette: {
    red: "#ea6962",
    orange: "#e1875c",
    yellow: "#d8a657",
    green: "#a9b665",
    cyan: "#89b482",
    blue: "#7daea3",
    magenta: "#d3869b",
    brown: "#70432e",
  },
};

const PALETTE_KEYS = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown"] as const;

export function readTheme(): ThemeTokens {
  try {
    const file = join(THEME_DIR, "colors.toml");
    if (!existsSync(file)) return FALLBACK_THEME;
    const c = parseFlatToml(readFileSync(file, "utf8"));

    const palette: Record<string, string> = {};
    for (const k of PALETTE_KEYS) if (c[k]) palette[k] = c[k];

    let name = "Omarchy";
    try {
      const nameFile = join(homedir(), ".local/state/omarchy/current/theme.name");
      if (existsSync(nameFile)) name = readFileSync(nameFile, "utf8").trim();
    } catch {
      /* name is cosmetic */
    }

    const theme: ThemeTokens = {
      name,
      mode: c.mode === "light" ? "light" : "dark",
      background: c.background ?? FALLBACK_THEME.background,
      sunken: c.darker_background ?? c.dark_background ?? FALLBACK_THEME.sunken,
      raised: c.lighter_background ?? FALLBACK_THEME.raised,
      foreground: c.foreground ?? FALLBACK_THEME.foreground,
      muted: c.muted ?? FALLBACK_THEME.muted,
      selection: c.selection ?? FALLBACK_THEME.selection,
      accent: c.accent ?? FALLBACK_THEME.accent,
      palette,
    };
    // STACK §8's runtime half of the contrast gate: a theme-supplied pair below
    // AA is a warning, not a refusal — the user chose that theme.
    for (const [pair, fg, bg] of contrastPairs(theme)) {
      const ratio = contrastRatio(fg, bg);
      if (Number.isFinite(ratio) && ratio < 4.5) {
        console.warn(`[theme] ${pair} contrast ${ratio.toFixed(2)}:1 is below WCAG AA (4.5:1)`);
      }
    }
    return theme;
  } catch {
    return FALLBACK_THEME;
  }
}

/** mtime of the theme file, used to detect switches cheaply. */
export function themeStamp(): number {
  try {
    // The generation counter is what Omarchy bumps on a switch; the mtime is a
    // fallback for a tree copied with preserved timestamps.
    return statSync(THEME_GENERATION).mtimeMs + statSync(join(THEME_DIR, "colors.toml")).mtimeMs;
  } catch {
    return 0;
  }
}

export function watchTheme(onChange: (t: ThemeTokens) => void, intervalMs = 5000): () => void {
  let last = themeStamp();
  const id = setInterval(() => {
    const now = themeStamp();
    if (now !== last) {
      last = now;
      onChange(readTheme());
    }
  }, intervalMs);
  return () => clearInterval(id);
}
