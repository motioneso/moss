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

function normalizeShortcut(parsed: ParsedShortcut): string {
  return `${parsed.modifiers.join("+")}+${parsed.key}`;
}

/** True when the string parses to a shortcut with at least one modifier and isn't reserved. */
export function isValidShortcut(shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  return !RESERVED_SHORTCUTS.has(normalizeShortcut(parsed));
}
