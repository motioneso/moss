import { recordModelActivity, type ModelActivityEntry } from "@moss/ai";

import type { GateTrace } from "./classifier-gate.js";

/** Longest tool name the activity table accepts for the action column. */
const ACTION_LIMIT = 200;

/**
 * The one activity-history line for a turn the gate handled or failed. The model name, tool and
 * time come from the gate's own trace, so no text the model wrote can reach the line. The line
 * takes the turn id as its own id, so the gate's per-question check lines group under it.
 */
export function handledTurnActivityLine(input: {
  readonly actorUserId: string;
  readonly turnId: string;
  readonly trace: GateTrace;
  readonly outcome: "handled" | "failed";
}): ModelActivityEntry {
  const { trace } = input;
  return {
    id: input.turnId,
    kind: "chat",
    action: (trace.toolName ?? "unknown tool").slice(0, ACTION_LIMIT),
    outcome: input.outcome === "handled" ? "ok" : "error",
    modelName: trace.modelName ?? "unknown model",
    result: input.outcome === "handled" ? "completed" : "failed",
    ownerUserId: input.actorUserId,
    actionCode: "chat.handled",
    turnId: input.turnId,
    durationMs: Math.max(0, Math.round(trace.latencyMs)),
    ...(trace.confidence !== undefined ? { factCounts: { confidence: trace.confidence } } : {})
  };
}

/** Files the line. A missing turn id files nothing, because the line could not join its checks. */
export function recordHandledTurnActivity(input: {
  readonly actorUserId: string;
  readonly turnId: string | undefined;
  readonly trace: GateTrace;
  readonly outcome: "handled" | "failed";
}): void {
  if (!input.turnId) return;
  recordModelActivity(handledTurnActivityLine({ ...input, turnId: input.turnId }));
}
