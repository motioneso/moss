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

/* Only the required 12 map 1:1 to a var; the optional gold slot derives a ramp below. */
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
  "--gold-ink"
] as const;

export function isThemeColor(value: string): boolean {
  return THEME_COLOR_RE.test(value.trim());
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

  if (tokens.gold) {
    const gold = parseThemeColor(tokens.gold);
    if (gold) {
      // Mix toward --paper (not pure white) for the same reason as the accent
      // ramp above (#787) — keeps the gold softs oat-tinted, not chalky.
      const paper = parseThemeColor(tokens.paper) ?? { r: 255, g: 255, b: 255 };
      style.setProperty("--gold", tokens.gold);
      style.setProperty("--gold-strong", rgbToHex(mix(gold, { r: 0, g: 0, b: 0 }, 0.18)));
      style.setProperty("--gold-soft", rgbToHex(mix(gold, paper, 0.82)));
      style.setProperty("--gold-soft-2", rgbToHex(mix(gold, paper, 0.72)));
      style.setProperty("--gold-ink", rgbToHex(mix(gold, { r: 0, g: 0, b: 0 }, 0.45)));
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
  const rgb = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/.exec(trimmed);
  if (!rgb) return null;
  const channels = rgb.slice(1).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  return { r: channels[0]!, g: channels[1]!, b: channels[2]! };
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
