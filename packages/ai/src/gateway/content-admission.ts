import type { ModuleAssistantToolManifest, ToolContext } from "@moss/module-sdk";

import type { ExecutableTool, RunHandlerOutcome } from "./run-tool-handler.js";
import type { AdmissionPath, AutomaticExecution, ConversationProvenancePort } from "./types.js";

export const CONTEXT_ADMISSION_UNAVAILABLE =
  "context_admission_unavailable: Outside content was withheld because its safety state could not be recorded. Wait for pending actions or start a new chat. If an action ran, check its result in the app before retrying.";

export function toolHasOutsideContent(tool: ModuleAssistantToolManifest): boolean {
  return (
    tool.externalContent === true || tool.isExternal === true || tool.content !== "user_authored"
  );
}

/** Descriptor trust is separate from result trust and never inferred from enabled membership. */
export function toolHasOutsideDescriptors(
  tool: ModuleAssistantToolManifest,
  actorUserId: string
): boolean {
  if (tool.isExternal === false) return false;
  return tool.isExternal !== true || !actorUserId || tool.descriptorOwnerUserId !== actorUserId;
}

/** No content, path, token or provider error is passed to the persistence port or caller. */
export async function recordContextAdmission(
  provenance: ConversationProvenancePort | undefined,
  ctx: Pick<ToolContext, "actorUserId" | "threadId">,
  path: AdmissionPath
): Promise<void> {
  if (!ctx.threadId || !provenance) throw new Error(CONTEXT_ADMISSION_UNAVAILABLE);
  try {
    await provenance.recordAdmission(ctx.actorUserId, ctx.threadId, path);
  } catch {
    throw new Error(CONTEXT_ADMISSION_UNAVAILABLE);
  }
}

export async function admitToolOutcome(
  provenance: ConversationProvenancePort | undefined,
  found: ExecutableTool,
  ctx: ToolContext,
  outcome: RunHandlerOutcome
): Promise<RunHandlerOutcome> {
  if (
    !outcome.requiresErrorAdmission &&
    (!outcome.response.ok || !toolHasOutsideContent(found.tool))
  )
    return outcome;
  try {
    await recordContextAdmission(
      provenance,
      ctx,
      found.tool.name === "app.callAction"
        ? "app_action_outside"
        : found.tool.name === "chat.readAttachment"
          ? "attachment_read"
          : "tool_external_content"
    );
    return outcome;
  } catch {
    return {
      response: { ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE },
      audit: { ...outcome.audit, outcome: "failed", errorClass: "content_admission" }
    };
  }
}

/** Resolve target text before any pending row/card; a failed admission must not yield a blind card. */
export async function admitResolvedCard(
  provenance: ConversationProvenancePort | undefined,
  found: ExecutableTool,
  ctx: ToolContext,
  displayedOutside?: boolean
): Promise<boolean> {
  const disclosureIsOutside =
    displayedOutside ??
    (found.resolution
      ? (found.resolution.disclosureExternalContent ?? found.resolution.externalContent)
      : found.tool.approvalPresentation
        ? found.tool.approvalContent !== "user_authored"
        : Boolean(found.tool.preview) && toolHasOutsideContent(found.tool));
  if (!disclosureIsOutside) return true;
  try {
    await recordContextAdmission(
      provenance,
      ctx,
      found.tool.name === "app.callAction" ? "app_action_outside" : "tool_external_content"
    );
    return true;
  } catch {
    return false;
  }
}

/** A missing guard never claims a clean conversation. Post-dispatch failures never ask again. */
export async function runAutomaticAction<T>(
  provenance: ConversationProvenancePort | undefined,
  ctx: Pick<ToolContext, "actorUserId" | "threadId">,
  execute: () => Promise<T>
): Promise<AutomaticExecution<T> | { readonly kind: "failed" }> {
  if (!ctx.threadId || !provenance?.runAutomatic) return { kind: "confirm" };
  try {
    return await provenance.runAutomatic(ctx.actorUserId, ctx.threadId, execute);
  } catch {
    // The callback may already have run. Never convert this into a second confirmation/execution.
    return { kind: "failed" };
  }
}
