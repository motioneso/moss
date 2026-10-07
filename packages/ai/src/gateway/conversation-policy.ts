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
    // Storage failures must never authorize unattended writes or expose private diagnostics.
    return true;
  }
}
