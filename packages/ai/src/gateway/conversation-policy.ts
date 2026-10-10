import type { ToolContext } from "@moss/module-sdk";

import type { ConversationProvenancePort } from "./types.js";

/** One fail-closed lookup shared by module, native and outside-agent permission paths. */
export async function isConversationTainted(
  provenance: ConversationProvenancePort | undefined,
  ctx: Pick<ToolContext, "actorUserId" | "threadId">
): Promise<boolean> {
  if (!ctx.threadId || !provenance) return true;
  try {
    return await provenance.isTainted(ctx.actorUserId, ctx.threadId);
  } catch {
    // Storage failures never establish a clean conversation or expose private diagnostics.
    return true;
  }
}

/**
 * Whether taint comes only from a durable outside-content mark, the one taint the user's trust
 * may run past. Missing bindings, held reservations and storage failures answer false.
 */
export async function isConversationMarked(
  provenance: ConversationProvenancePort | undefined,
  ctx: Pick<ToolContext, "actorUserId" | "threadId">
): Promise<boolean> {
  if (!ctx.threadId || !provenance?.isMarked) return false;
  try {
    return await provenance.isMarked(ctx.actorUserId, ctx.threadId);
  } catch {
    return false;
  }
}

/** How the gateway routes one call once its approval decision is made. */
export type PlannedCall = {
  readonly kind: "yolo-confirm" | "yolo-run" | "auto-run" | "confirm";
  readonly userTrusted?: true;
  /** A clean conversation would run this call. Only the outside-content mark makes it ask. */
  readonly outsideContentReason?: true;
};

/**
 * An asking plan carries the outside-content reason only when the durable mark is the whole
 * cause: the chat is marked and a clean conversation would run the same call (#3338).
 */
export async function plannedConfirm(
  kind: "confirm" | "yolo-confirm",
  marked: boolean,
  cleanRuns: () => Promise<boolean> = async () => true
): Promise<PlannedCall> {
  return marked && (await cleanRuns()) ? { kind, outsideContentReason: true } : { kind };
}
