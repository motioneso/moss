/**
 * #2236 slice 1: pure validator for the scratchpad's open-shortcut setting. No dependency on
 * module-sdk or the database - shared with the web app the same way the DTOs in
 * scratchpad-api.ts are, through @moss/shared's plain barrel export.
 *
 * Shortcut strings look like "mod+shift+s": one or more modifier tokens joined with "+",
 * followed by exactly one key token. "mod" means "control on Windows/Linux, command on Mac" -
 * the same cross-platform meaning the command palette shortcut already uses.
 */

const MODIFIER_TOKENS = new Set(["mod", "ctrl", "cmd", "meta", "alt", "shift"]);

/**
 * Shortcuts already claimed by another part of the app. Kept as a small, explicit set rather
 * than a broad rule, so adding a new reserved shortcut later is a one-line change.
 */
const RESERVED_SHORTCUTS = new Set([
  "mod+k" // the command palette
]);

export interface ParsedShortcut {
  readonly modifiers: readonly string[];
  readonly key: string;
}

/**
 * Parses a shortcut string into its modifier tokens and key. Returns null when the string is
 * empty, has no modifier, has an unrecognized modifier token, or has no key.
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
  const trimmed = shortcut.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);

  // Needs at least one modifier plus exactly one trailing key token.
  if (parts.length < 2) return null;

  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (key === undefined || key.length === 0 || modifiers.length === 0) return null;
  if (!modifiers.every((modifier) => MODIFIER_TOKENS.has(modifier))) return null;

  return { modifiers, key };
}

/**
 * "ctrl", "cmd" and "meta" all mean the same physical key as "mod" on their own platform, so two
 * shortcuts that differ only in which of those four tokens they use are really the same shortcut.
 * Used only for the reserved-shortcut check and the modifier check below - `parseShortcut` keeps
 * returning the raw tokens the caller typed.
 */
function canonicalizeModifier(modifier: string): string {
  return modifier === "ctrl" || modifier === "cmd" || modifier === "meta" ? "mod" : modifier;
}

function normalizeShortcut(parsed: ParsedShortcut): string {
  const canonicalModifiers = parsed.modifiers.map(canonicalizeModifier);
  return `${canonicalModifiers.join("+")}+${parsed.key}`;
}

/**
 * True when the string parses to a shortcut with a real modifier (something other than Shift
 * alone - Shift plus a letter is a normal typed character, not a keyboard shortcut) and isn't
 * reserved under any of its equivalent spellings ("mod+k", "ctrl+k", "cmd+k", "meta+k" are all
 * the same shortcut).
 */
export function isValidShortcut(shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  const canonicalModifiers = parsed.modifiers.map(canonicalizeModifier);
  const hasRealModifier = canonicalModifiers.some((modifier) => modifier !== "shift");
  if (!hasRealModifier) return false;

  return !RESERVED_SHORTCUTS.has(normalizeShortcut(parsed));
}
