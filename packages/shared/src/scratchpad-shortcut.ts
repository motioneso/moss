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
 * Shortcuts already claimed by another part of the app, written the way the handler that claims
 * them actually behaves. The command palette (apps/web/src/shell/command-palette.tsx,
 * `isCommandPaletteShortcut`) opens whenever control or command is held and the key is "k" - it
 * ignores any other modifier - so Ctrl+Shift+K and Cmd+Alt+K reach the palette too and must not
 * be offered to the scratchpad. Each entry is checked against the canonical modifier set (see
 * `canonicalModifierSet`), so repeated and equivalent spellings cannot slip past it.
 */
const RESERVED_SHORTCUT_MATCHERS: readonly ((
  modifiers: ReadonlySet<string>,
  key: string
) => boolean)[] = [
  // The command palette: control-or-command plus K, whatever else is held down.
  (modifiers, key) => key === "k" && modifiers.has("mod")
];

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

/**
 * The shortcut's modifiers as a set of canonical names, which collapses both repeats
 * ("ctrl+ctrl+k") and equivalent spellings ("ctrl+cmd+k") down to what the keyboard actually
 * produces. Reservation checks run against this set so neither trick can bypass them.
 */
function canonicalModifierSet(parsed: ParsedShortcut): ReadonlySet<string> {
  return new Set(parsed.modifiers.map(canonicalizeModifier));
}

function isReservedShortcut(parsed: ParsedShortcut): boolean {
  const modifiers = canonicalModifierSet(parsed);
  return RESERVED_SHORTCUT_MATCHERS.some((matches) => matches(modifiers, parsed.key));
}

/**
 * True when the string parses to a shortcut with a real modifier (something other than Shift
 * alone - Shift plus a letter is a normal typed character, not a keyboard shortcut) and isn't
 * already claimed elsewhere in the app. Repeated and equivalent modifier spellings are collapsed
 * first, so "mod+k", "ctrl+k", "cmd+k", "meta+k", "ctrl+ctrl+k" and "ctrl+shift+k" are all
 * rejected as the command palette's shortcut.
 */
export function isValidShortcut(shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;

  const canonicalModifiers = canonicalModifierSet(parsed);
  const hasRealModifier = [...canonicalModifiers].some((modifier) => modifier !== "shift");
  if (!hasRealModifier) return false;

  return !isReservedShortcut(parsed);
}
