import {
  AESTHETIC_THEME_TOKEN_KEYS,
  type AestheticThemeTokenKey,
  type AestheticThemeTokens
} from "@moss/shared";

export interface CSSStyleDeclarationLike {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): string;
  getPropertyValue(name: string): string;
}

const THEME_COLOR_RE =
  /^#[0-9a-fA-F]{6}$|^rgba?\((25[0-5]|2[0-4]\d|1?\d?\d),\s*(25[0-5]|2[0-4]\d|1?\d?\d),\s*(25[0-5]|2[0-4]\d|1?\d?\d)(,\s*(0|1|0?\.\d+))?\)$/;

/* Only the required 12 map 1:1 to a var; the optional highlight slot derives the gold ramp below. */
const TOKEN_TO_VAR: Record<AestheticThemeTokenKey, string> = {
  paper: "--paper",
  surface: "--surface",
  surface2: "--surface-2",
  surface3: "--surface-3",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  ink4: "--ink-4",
  line: "--line",
  lineSubtle: "--line-subtle",
  lineStrong: "--line-strong",
  accent: "--accent"
};

/* Shell nav vars. Unset, the sidebar and phone top bar fall back to the theme's own colors. */
const NAV_VARS = [
  "--nav-bg",
  "--nav-fg",
  "--nav-muted",
  "--nav-line",
  "--nav-hover",
  "--nav-active-bg",
  "--nav-active-fg",
  "--nav-brand"
] as const;

/* House ink and bone; nav text uses whichever reads better on the chosen ground. */
const NAV_DARK_TEXT: Rgb = { r: 0x28, g: 0x2c, b: 0x25 };
const NAV_LIGHT_TEXT: Rgb = { r: 0xed, g: 0xe5, b: 0xd2 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const TEXT_FLOOR = 4.5;
const ACCENT_PILL_FLOOR = 3;

const CLEARED_RUNTIME_VARS = [
  ...Object.values(TOKEN_TO_VAR),
  "--forest",
  "--forest-hover",
  "--forest-active",
  "--forest-soft",
  "--forest-soft-2",
  "--forest-ink",
  "--accent-hover",
  "--accent-active",
  "--accent-soft",
  "--accent-soft-2",
  "--accent-soft-fg",
  "--accent-strong",
  "--btn-primary-bg",
  "--focus-ring",
  "--gold",
  "--gold-strong",
  "--gold-soft",
  "--gold-soft-2",
  "--gold-ink",
  ...NAV_VARS
] as const;

export function isThemeColor(value: string): boolean {
  return THEME_COLOR_RE.test(value.trim());
}

/* Opaque colors only. Contrast math needs a solid ground, so the nav refuses see-through rgba. */
export function isSolidThemeColor(value: string): boolean {
  return isThemeColor(value) && parseThemeColor(value) !== null;
}

export function parsePalette(input: string): string[] {
  const matches = input.match(/#[0-9a-fA-F]{6}\b|rgba?\([^)]*\)/g) ?? [];
  return [...new Set(matches.map((value) => value.trim()).filter(isThemeColor))];
}

/**
 * `paper` softs mix toward the active --paper ground (not pure white) so
 * runtime-derived custom-theme softs read like the hand-tuned oat-tinted
 * built-in softs instead of washed-out/chalky on the oat ground (#787).
 * Falls back to white if `paper` isn't a parseable theme color.
 */
export function deriveAccentRamp(accent: string, paper: string): Record<string, string> {
  const color = parseThemeColor(accent);
  if (!color) return {};
  const paperColor = parseThemeColor(paper) ?? { r: 255, g: 255, b: 255 };
  return {
    "--accent-hover": rgbToHex(mix(color, { r: 0, g: 0, b: 0 }, 0.12)),
    "--accent-active": rgbToHex(mix(color, { r: 0, g: 0, b: 0 }, 0.22)),
    "--accent-soft": rgbToHex(mix(color, paperColor, 0.86)),
    "--accent-soft-2": rgbToHex(mix(color, paperColor, 0.76)),
    "--accent-soft-fg": rgbToHex(mix(color, { r: 0, g: 0, b: 0 }, 0.28)),
    "--btn-primary-bg": accent
  };
}

export interface NavColors {
  readonly vars: Record<(typeof NAV_VARS)[number], string>;
  readonly textRatio: number;
  readonly mutedRatio: number;
  readonly textKind: "dark" | "light";
  /** True when neither house color reached 4.5:1 and text fell back to black or white. */
  readonly strongText: boolean;
  readonly activeKind: "accent" | "wash";
}

/**
 * Derives readable nav colors for any ground. Text takes house ink or bone,
 * falling back to black or white on mid-tones, so it always clears 4.5:1.
 * Quieter links dim toward the ground only as far as 4.5:1 allows. The
 * selected item keeps the accent pill when the accent clears 3:1 against the
 * ground, otherwise it becomes a wash of the text color. Text on the hover,
 * wash and pill grounds is checked against that ground, not the nav.
 */
export function deriveNavColors(nav: string, accent: string): NavColors | null {
  const bg = parseThemeColor(nav);
  if (!bg) return null;

  const fg = readableText(bg);
  const strongText = fg === BLACK || fg === WHITE;

  let muted = fg;
  for (let step = 20; step >= 0; step -= 1) {
    const candidate = mix(fg, bg, step / 50);
    if (ratio(candidate, bg) >= TEXT_FLOOR) {
      muted = candidate;
      break;
    }
  }

  const accentColor = parseThemeColor(accent);
  const accentRatio = accentColor ? ratio(accentColor, bg) : 1;
  const accentPill = accentColor !== null && accentRatio >= ACCENT_PILL_FLOOR;
  const fgHex = rgbToHex(fg);

  return {
    vars: {
      "--nav-bg": rgbToHex(bg),
      "--nav-fg": fgHex,
      "--nav-muted": rgbToHex(muted),
      "--nav-line": rgbToHex(mix(bg, fg, 0.2)),
      "--nav-hover": rgbToHex(shade(bg, fg, 0.08)),
      "--nav-active-bg": accentPill ? rgbToHex(accentColor) : rgbToHex(shade(bg, fg, 0.16)),
      "--nav-active-fg": accentPill ? rgbToHex(readableText(accentColor)) : fgHex,
      "--nav-brand": accentColor && accentRatio >= TEXT_FLOOR ? rgbToHex(accentColor) : fgHex
    },
    textRatio: ratio(fg, bg),
    mutedRatio: ratio(muted, bg),
    textKind: fg === NAV_DARK_TEXT || fg === BLACK ? "dark" : "light",
    strongText,
    activeKind: accentPill ? "accent" : "wash"
  };
}

export function applyThemeTokens(
  style: CSSStyleDeclarationLike,
  tokens: AestheticThemeTokens | null
): void {
  for (const name of CLEARED_RUNTIME_VARS) {
    style.removeProperty(name);
  }
  if (!tokens) return;

  for (const key of AESTHETIC_THEME_TOKEN_KEYS) {
    const value = tokens[key];
    if (isThemeColor(value)) style.setProperty(TOKEN_TO_VAR[key], value);
  }
  style.setProperty("--forest", tokens.accent);
  for (const [name, value] of Object.entries(deriveAccentRamp(tokens.accent, tokens.paper))) {
    style.setProperty(name, value);
  }
  style.setProperty("--forest-hover", style.getPropertyValue("--accent-hover"));
  style.setProperty("--forest-active", style.getPropertyValue("--accent-active"));
  style.setProperty("--forest-soft", style.getPropertyValue("--accent-soft"));
  style.setProperty("--forest-soft-2", style.getPropertyValue("--accent-soft-2"));
  style.setProperty("--forest-ink", style.getPropertyValue("--accent-soft-fg"));
  style.setProperty("--accent-strong", "var(--accent-hover)");
  style.setProperty("--focus-ring", `color-mix(in srgb, ${tokens.accent} 45%, transparent)`);

  if (tokens.highlight) {
    const gold = parseThemeColor(tokens.highlight);
    if (gold) {
      // Mix toward --paper (not pure white) for the same reason as the accent
      // ramp above (#787) — keeps the gold softs oat-tinted, not chalky.
      const paper = parseThemeColor(tokens.paper) ?? { r: 255, g: 255, b: 255 };
      style.setProperty("--gold", tokens.highlight);
      style.setProperty("--gold-strong", rgbToHex(mix(gold, { r: 0, g: 0, b: 0 }, 0.18)));
      style.setProperty("--gold-soft", rgbToHex(mix(gold, paper, 0.82)));
      style.setProperty("--gold-soft-2", rgbToHex(mix(gold, paper, 0.72)));
      style.setProperty("--gold-ink", rgbToHex(mix(gold, { r: 0, g: 0, b: 0 }, 0.45)));
    }
  }

  if (tokens.nav) {
    const nav = deriveNavColors(tokens.nav, tokens.accent);
    if (nav) {
      for (const [name, value] of Object.entries(nav.vars)) style.setProperty(name, value);
    }
  }
}

export function readCurrentAestheticTokens(style: CSSStyleDeclarationLike): AestheticThemeTokens {
  return Object.fromEntries(
    AESTHETIC_THEME_TOKEN_KEYS.map((key) => [key, style.getPropertyValue(TOKEN_TO_VAR[key]).trim()])
  ) as AestheticThemeTokens;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function parseThemeColor(value: string): Rgb | null {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return {
      r: parseInt(trimmed.slice(1, 3), 16),
      g: parseInt(trimmed.slice(3, 5), 16),
      b: parseInt(trimmed.slice(5, 7), 16)
    };
  }
  const rgb = /^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*([\d.]+))?\)$/.exec(trimmed);
  if (!rgb) return null;
  if (rgb[4] !== undefined && Number(rgb[4]) !== 1) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]! };
}

/* House ink or bone when either clears 4.5:1, else black or white. One of
   those two always clears it, so any ground gets readable text. */
function readableText(ground: Rgb): Rgb {
  const house =
    ratio(NAV_DARK_TEXT, ground) >= ratio(NAV_LIGHT_TEXT, ground) ? NAV_DARK_TEXT : NAV_LIGHT_TEXT;
  if (ratio(house, ground) >= TEXT_FLOOR) return house;
  return ratio(BLACK, ground) >= ratio(WHITE, ground) ? BLACK : WHITE;
}

/* A hover or selected ground. It leans toward the text color, unless that
   drops the text under 4.5:1; then it leans away, which only adds contrast. */
function shade(ground: Rgb, text: Rgb, amount: number): Rgb {
  const toward = mix(ground, text, amount);
  if (ratio(text, toward) >= TEXT_FLOOR) return toward;
  const away = luminance(text) < luminance(ground) ? WHITE : BLACK;
  return mix(ground, away, amount);
}

function ratio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function luminance(color: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount)
  };
}

function rgbToHex(color: Rgb): string {
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}
