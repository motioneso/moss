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
// Framing this codebase itself emits (`User: `, `Assistant: ` literals added by
// chat-context-blocks.ts / codex-exec-session.ts) is added post-neutralization and is therefore
// never matched here.
//
// Two passes: a role word followed by a colon is always neutralized (decoration optional). A
// role word with NO colon is neutralized only when markdown header/blockquote decoration
// precedes it — required decoration is the signal that separates a spoofed header from an
// ordinary sentence starting with "User"/"System"/etc.
const ROLE_MARKER_COLON_RE =
  /^([ \t]*(?:[>\-*#]+[ \t]*)*)(user|assistant|system|human|ai)(\s*:)/gim;
const ROLE_MARKER_HEADER_RE =
  /^([ \t]*(?:[>\-*#]+[ \t]*)+)(user|assistant|system|human|ai)(?=[ \t]*(?:\r?\n|$))/gim;

function neutralizeRoleMarkers(text: string): string {
  return text
    .replace(
      ROLE_MARKER_COLON_RE,
      (_m, prefix: string, role: string, colon: string) => `${prefix}[${role}]${colon}`
    )
    .replace(ROLE_MARKER_HEADER_RE, (_m, prefix: string, role: string) => `${prefix}[${role}]`);
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
