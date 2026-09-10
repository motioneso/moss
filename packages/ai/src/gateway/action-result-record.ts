import type { GatewaySessionRecord, SessionNotifier } from "./types.js";

export type GatewayActionResult = Extract<GatewaySessionRecord, { readonly kind: "action_result" }>;
export type GatewayActionResultFields = Omit<GatewayActionResult, "kind">;

/** Keep action-result construction and decision provenance in one gateway-owned boundary. */
export function actionResultRecord(fields: GatewayActionResultFields): GatewayActionResult {
  return { kind: "action_result", ...fields };
}

export function emitActionResultRecord(
  notifier: SessionNotifier,
  chatSessionId: string,
  fields: GatewayActionResultFields
): void {
  notifier.emit(chatSessionId, actionResultRecord(fields));
}

/** Measure only the time spent waiting after the approval card was shown. */
export function actionHoldDurationMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
