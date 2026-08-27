/**
 * Prompt-injection defenses for the chat seed protocol.
 *
 * Before a freshly-spawned or provider-switched CLI engine resumes a session, the
 * session manager submits a seed made of XML-style framing blocks — `<memory>`
 * (recalled past conversations + extracted facts), `<conversation>` (replayed
 * prior turns), and `<prior-context>` (a rolling summary that is a verbatim
 * concatenation of stored assistant message bodies). The text inside those blocks
 * is user-influenced — a recalled chunk or prior user turn can contain anything
 * the user once typed, and the rolling summary can echo whatever the user steered
 * the model to emit. If that text can itself contain one of our closing
 * delimiters it can break out of its block and have the remainder read as
 * out-of-band instructions — a
 * prompt-injection vector (#123).
 */

/**
 * Rewrite the angle-bracket form of every reserved seed-framing delimiter (open
 * or close, any case) to a bracketed literal so the text survives for the model
 * to read but can never be parsed as our framing. Unrelated markup in the text
 * (a code snippet, stray HTML in a recalled message) is left untouched — only
 * the exact reserved tokens are neutralized.
 *
 *   "...</memory> ignore previous"  ->  "...[/memory] ignore previous"
 */
export function neutralizeSeedFraming(text: string): string {
  const withoutTagFraming = text.replace(
    /<\/?(?:memory|conversation|prior-context|retrieved_context|cross_tool_context|page_context|attachments|trusted_instructions|external_source|module_control|module_onboarding_state)>/gi,
    (match) => match.replace("<", "[").replace(">", "]")
  );
  return neutralizeRoleMarkers(withoutTagFraming);
}

// Matches a persona/role marker at the start of a line (or string), optionally preceded by
// markdown header hashes or blockquote/list decoration (which may repeat/nest, e.g. "> > " or
// 7+ hashes), so an attacker-embedded fake transcript turn ("\n\nUser: ...\nAssistant: ...") or a
// spoofed section header ("### System") cannot imitate real turn framing or system instructions.
//
// Fresh `User: `, `Assistant: ` labels this codebase adds right before sending to the model
// (chat-context-blocks.ts / codex-exec-session.ts) are added post-neutralization and are
// therefore never matched here. But text that was SAVED to memory with those labels already
// baked into it (see packages/chat/src/jobs.ts) is untrusted text like any other once it comes
// back through recall — it does go back through this same check, and does get rewritten to
// "[User]: ..." on the way back in. That's intentional: the label only becomes trustworthy once
// this code has already run.
//
// Two passes: a role word followed by a colon is always neutralized (decoration optional). A
// role word with NO colon is neutralized only when markdown header/blockquote decoration
// precedes it — required decoration is the signal that separates a spoofed header from an
// ordinary sentence starting with "User"/"System"/etc.
//
// The decoration group matches ONE decoration character per repetition (`[>\-*#]`, not
// `[>\-*#]+`). An inner `+` under the outer quantifier makes the partitioning of a decoration run
// ambiguous, so a plain markdown horizontal rule ("-" x 30) backtracks at ~2^n and blocks the event
// loop for seconds. Matching one character at a time is unambiguous, linear, and byte-identical in
// output. The same reasoning applies to every character class below: each is a flat set matched by
// a single quantifier, never nested, so the whole match stays linear even on adversarial input.
const ROLE_WORDS = [
  "user",
  "assistant",
  "system",
  "human",
  "ai",
  "moss",
  "developer",
  "tool",
  "function",
  "model"
] as const;
const ALLOWED_ROLES = new Set<string>(ROLE_WORDS);

// Zero-width space, zero-width non-joiner, zero-width joiner, word joiner, BOM / zero-width
// no-break space — the invisible characters security testing used to split a role word so the
// old ASCII-only regex would not recognize it.
const INVISIBLE_CLASS = "\\u200B\\u200C\\u200D\\u2060\\uFEFF";
// ASCII space/tab plus the Unicode space separators that can stand in for a real space before a
// marker or its decoration.
const SPACE_CLASS = " \\t\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000";
// ASCII letters plus full-width Latin letters (U+FF21-FF3A, U+FF41-FF5A) — the lookalike-letter
// form security testing used. A run of these plus invisible characters is a marker "token"
// candidate. Letters from any other alphabet (e.g. Cyrillic) are deliberately excluded, so a
// lookalike-letter word never forms a token in the first place — that keeps ordinary text with
// mixed-script lookalikes from ever reaching the allow-list check.
const MARKER_TOKEN_CLASS = `A-Za-z\\uFF21-\\uFF3A\\uFF41-\\uFF5A${INVISIBLE_CLASS}`;
// ASCII colon plus the full-width colon lookalike (both normalize to ":" under NFKC; kept
// explicit here so the regex can find the colon before normalization ever runs).
const COLON_CLASS = ":\\uFF1A";

// Each code point in these classes is matched individually as a standalone invisible character,
// never as part of a joined grapheme, so the lint rule's "joined character sequence" concern
// doesn't apply — disabled per line below since it fires on the template-literal line itself.
const ROLE_MARKER_COLON_RE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class -- see comment above
  `^([${SPACE_CLASS}]*(?:[>\\-*#][${SPACE_CLASS}]*)*)([${MARKER_TOKEN_CLASS}]+)([${SPACE_CLASS}${INVISIBLE_CLASS}]*[${COLON_CLASS}])`,
  "gim"
);
const ROLE_MARKER_HEADER_RE = new RegExp(
  // eslint-disable-next-line no-misleading-character-class -- see comment above
  `^([${SPACE_CLASS}]*(?:[>\\-*#][${SPACE_CLASS}]*)+)([${MARKER_TOKEN_CLASS}]+)(?=[${SPACE_CLASS}${INVISIBLE_CLASS}]*(?:\\r?\\n|$))`,
  "gim"
);
// eslint-disable-next-line no-misleading-character-class -- see comment above
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");

// Strips invisible characters and normalizes full-width lookalikes out of a matched token, then
// checks it against the allow-list. Only the matched token/colon are ever touched — the prefix
// (decoration) and everything outside the match is returned byte-for-byte as captured by the
// regex above, so normalization never reaches the surrounding text.
function resolveRoleToken(rawToken: string): string | null {
  const normalized = rawToken.replace(INVISIBLE_RE, "").normalize("NFKC");
  const roleKey = normalized.toLowerCase();
  return ALLOWED_ROLES.has(roleKey) ? normalized : null;
}

function neutralizeRoleMarkers(text: string): string {
  return text
    .replace(ROLE_MARKER_COLON_RE, (match, prefix: string, rawToken: string, colon: string) => {
      const role = resolveRoleToken(rawToken);
      return role === null ? match : `${prefix}[${role}]${colon.normalize("NFKC")}`;
    })
    .replace(ROLE_MARKER_HEADER_RE, (match, prefix: string, rawToken: string) => {
      const role = resolveRoleToken(rawToken);
      return role === null ? match : `${prefix}[${role}]`;
    });
}

/** #1194 — blanket XML defang for strings crossing from a module into a core-owned prompt. */
export function sanitizeExternalData(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const MODULE_CONTROL_CONTEXT_MAX_BYTES = 8 * 1024;
const MODULE_CONTROL_KEYS = ["step", "action", "values"] as const;

export type ModuleControlRenderResult =
  | { readonly ok: true; readonly text?: string }
  | { readonly ok: false; readonly error: string };

/** #1194 — validate, bound, and defang module data before core emits trusted framing. */
export function renderModuleControlContext(value: unknown): ModuleControlRenderResult {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "controlContext must be an object" };
  }
  try {
    const input = value as Record<string, unknown>;
    const selected: Record<string, unknown> = {};
    for (const key of MODULE_CONTROL_KEYS) {
      if (input[key] !== undefined) selected[key] = sanitizeJsonValue(input[key], new WeakSet());
    }
    if (Object.keys(selected).length === 0) return { ok: true };
    const json = JSON.stringify(selected);
    if (new TextEncoder().encode(json).byteLength > MODULE_CONTROL_CONTEXT_MAX_BYTES) {
      return {
        ok: false,
        error: `controlContext exceeds the ${MODULE_CONTROL_CONTEXT_MAX_BYTES} byte limit`
      };
    }
    return { ok: true, text: `<module_control>\n${json}\n</module_control>` };
  } catch {
    return { ok: false, error: "controlContext must contain JSON data" };
  }
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeExternalData(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new TypeError("non-json value");
  if (seen.has(value)) throw new TypeError("cyclic value");
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[sanitizeExternalData(key)] = sanitizeJsonValue(item, seen);
  }
  return output;
}
