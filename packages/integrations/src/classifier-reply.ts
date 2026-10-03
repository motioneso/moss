import { INTEGRATION_SUMMARY } from "./summaries.js";

/**
 * Reply contract for a classifier-handled connected tool (plan 2b.5, #2905).
 *
 * One code-authored renderer. It never shows the remote `detail` field, never lets a literal
 * template claim success over an error, and never paraphrases a suppression or truncation as a
 * fresh result. The gate's runtime wiring lane injects this renderer (chat does not depend on
 * `@moss/integrations`).
 */

/** The exact strings the plan fixes for 2b.5. Do not invent alternatives. */
export const CLASSIFIER_REPLY = {
  performedOk: "Action performed successfully.",
  readOk: "Read succeeded.",
  unconfirmed: "The action could not be confirmed. Check the connected service before trying again."
} as const;

/**
 * `INTEGRATION_SUMMARY` meanings that describe what actually happened and must pass through
 * unchanged. `callFailed` is deliberately excluded: it points the reader at `detail`, which the
 * gate never shows.
 */
const PRESERVED_SUMMARIES: ReadonlySet<string> = new Set([
  INTEGRATION_SUMMARY.blockedRead,
  INTEGRATION_SUMMARY.blockedPerformed,
  INTEGRATION_SUMMARY.truncated,
  INTEGRATION_SUMMARY.requestRefused
]);

export interface ClassifierReplyEnvelope {
  readonly status: unknown;
  readonly action: unknown;
  readonly summary: unknown;
}

export interface ClassifierReplyInput {
  /** The owner-reviewed declarative template carried on the tool's classifier declaration. */
  readonly template: string;
  /** The validated/sanitized result fields (the integration outcome envelope). */
  readonly result: unknown;
  readonly envelope: ClassifierReplyEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAt(data: unknown, path: string): unknown {
  let node = data;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Fills a reviewed template from the result. Mirrors the gate's renderer
 * (`packages/chat/src/live/classifier-gate-arguments.ts:229-239`): a placeholder that is missing or
 * is not a plain string, number or boolean makes the whole template unusable (null), so a
 * malformed result never reads as success.
 */
export function renderClassifierTemplate(template: string, result: unknown): string | null {
  let missing = false;
  const text = template.replace(/\{([^{}]*)\}/g, (_match, path: string) => {
    const value = valueAt(result, path);
    if (typeof value === "string" || typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    missing = true;
    return "";
  });
  return missing ? null : text;
}

/**
 * Resolves the handled reply in this fixed order:
 *
 * 1. A preserved `INTEGRATION_SUMMARY` meaning (already-done, refused, truncated) — it describes
 *    what happened and must not be replaced by a literal template.
 * 2. A non-`ok`/unknown envelope status — the fixed unconfirmed string, so a literal template can
 *    never fill an error with success text.
 * 3. The reviewed declarative template, when every placeholder resolves.
 * 4. A non-empty envelope summary.
 * 5. An empty success summary — the exact performed/read fallback by the envelope's action.
 *
 * Returns null when none of these can produce a reply (for example an unknown action with an empty
 * success summary); the caller then declines rather than inventing text. `detail` is never read.
 */
export function renderIntegrationClassifierReply(input: ClassifierReplyInput): string | null {
  const summary = typeof input.envelope.summary === "string" ? input.envelope.summary : "";
  if (PRESERVED_SUMMARIES.has(summary)) return summary;

  if (input.envelope.status !== "ok") return CLASSIFIER_REPLY.unconfirmed;

  const rendered = renderClassifierTemplate(input.template, input.result);
  if (rendered !== null && rendered !== "") return rendered;

  if (summary !== "") return summary;
  if (input.envelope.action === "read") return CLASSIFIER_REPLY.readOk;
  if (input.envelope.action === "performed") return CLASSIFIER_REPLY.performedOk;
  return null;
}
