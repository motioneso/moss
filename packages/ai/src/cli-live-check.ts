import { unfence } from "./structured/run-helpers.js";
import type { LiveCheckResult } from "./cli-version-check.js";

/**
 * #2689 slice 4: the two calls of the live check, with the model's words never read. Each call is
 * a throwaway turn supplied by the caller. Call 1 passes on the reported tool call. Call 2 passes
 * on a schema-valid one-field object, and the number of tries is recorded.
 */

export const TOOL_CHECK_PROMPT =
  "Call the app.getMapSlice tool once with no arguments, then reply with the word done.";
export const STRUCTURED_CHECK_PROMPT =
  'Reply with only this JSON for 2 + 2, no other text: {"sum": 4}';
export const STRUCTURED_CHECK_TRIES = 2;

export type CheckTurnOutcome =
  | { readonly ok: true; readonly replyText: string }
  | { readonly ok: false; readonly reason: "tool_call_missing" | "timeout" | "check_unavailable" };

export interface LiveCheckPorts {
  readonly toolTurn: () => Promise<CheckTurnOutcome>;
  readonly structuredTurn: () => Promise<CheckTurnOutcome>;
}

/** True when the reply is one object whose only field `sum` is the number 4. */
export function isValidSumReply(text: string): boolean {
  try {
    const value: unknown = JSON.parse(unfence(text));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === "sum" && (value as { sum: unknown }).sum === 4;
  } catch {
    return false;
  }
}

export async function runLiveCheckSteps(ports: LiveCheckPorts): Promise<LiveCheckResult> {
  const tool = await ports.toolTurn();
  if (!tool.ok) return { passed: false, reason: tool.reason };

  for (let attempt = 1; attempt <= STRUCTURED_CHECK_TRIES; attempt++) {
    const turn = await ports.structuredTurn();
    if (!turn.ok) return { passed: false, reason: turn.reason, attempts: attempt };
    if (isValidSumReply(turn.replyText)) return { passed: true, reason: "ok", attempts: attempt };
  }
  return { passed: false, reason: "structured_call_failed", attempts: STRUCTURED_CHECK_TRIES };
}
