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
