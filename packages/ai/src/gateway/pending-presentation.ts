import { ApprovalInputError, ApprovalPrerequisiteError } from "@moss/module-sdk";
import { inputValidationFailure } from "./validation-failure.js";
import { isDeepStrictEqual } from "node:util";
import type { AiRepository } from "../repository.js";
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { ActionRequestPreview, ToolContext, ToolServices } from "@moss/module-sdk";
import type { ExecutableTool, RunHandlerOutcome } from "./run-tool-handler.js";
import { approvalOutcomeTitle } from "./approval-outcome-title.js";
import { summarizeToolAction } from "./policy.js";
import { freezeSnapshot } from "./per-call-resolution.js";
import { admitResolvedCard, CONTEXT_ADMISSION_UNAVAILABLE } from "./content-admission.js";
import type {
  ActiveModulesResolver,
  ConversationProvenancePort,
  GatewayToolResponse,
  CallCardDetails,
  GatewaySessionRecord
} from "./types.js";

interface PendingPresentation {
  readonly validationError?: string;
  readonly preparationError?: string;
  readonly title?: string;
  readonly disclosureExternalContent?: boolean;
  readonly externalTool?: true;
  readonly exactArguments?: string;
  readonly details?: CallCardDetails;
  readonly preview?: ActionRequestPreview;
  readonly version?: string;
}

export function completeActionPresentation(
  record: Pick<
    Extract<GatewaySessionRecord, { kind: "action_request" }>,
    | "summary"
    | "outcomeTitle"
    | "details"
    | "preview"
    | "nativePermission"
    | "externalTool"
    | "exactArguments"
  >
): boolean {
  if (record.nativePermission === true && record.externalTool === true) return false;
  if (record.externalTool === true) {
    if (typeof record.exactArguments !== "string") return false;
    try {
      const value: unknown = JSON.parse(record.exactArguments);
      return value !== null && typeof value === "object" && !Array.isArray(value);
    } catch {
      return false;
    }
  }
  if (record.nativePermission === true)
    return typeof record.summary === "string" && Boolean(record.summary.trim());
  if (typeof record.outcomeTitle !== "string" || !record.outcomeTitle.trim()) return false;
  if (record.preview) {
    return (
      [record.preview.to, record.preview.subject, record.preview.body].every(
        (value) => typeof value === "string"
      ) && Boolean(record.preview.to.trim())
    );
  }
  const details = record.details;
  return (
    details?.presentation === "human" &&
    typeof details.target === "string" &&
    Boolean(details.target.trim()) &&
    Array.isArray(details.fields) &&
    details.fields.every(
      (field) =>
        field !== null &&
        typeof field === "object" &&
        typeof field.label === "string" &&
        Boolean(field.label.trim()) &&
        typeof field.value === "string"
    )
  );
}

/** A JSON disclosure must account for every input value; stringify alone silently drops some. */
export function exactArgumentText(input: Record<string, unknown>): string | null {
  try {
    const text = JSON.stringify(input, null, 2);
    return isDeepStrictEqual(input, JSON.parse(text)) ? text : null;
  } catch {
    return null;
  }
}

/** Hooks run in the actor's scope; failures never turn into a summary-only approval. */
export async function preparePendingPresentation(
  runner: Pick<DataContextRunner, "withDataContext">,
  access: AccessContext,
  found: ExecutableTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  services: ToolServices
): Promise<PendingPresentation> {
  if (found.resolution) return { details: found.resolution.details };
  try {
    if (found.tool.approvalPresentation) {
      const result = await runner.withDataContext(access, (db) =>
        found.tool.approvalPresentation!(db, input, ctx, services)
      );
      if (
        !result ||
        !completeActionPresentation({
          summary: "Action",
          outcomeTitle: "Action",
          details: { presentation: "human", target: result.target, fields: result.fields }
        })
      )
        return {};
      return structuredClone({
        ...(result.title !== undefined ? { title: result.title } : {}),
        details: {
          presentation: "human" as const,
          ...(result.approvalKind === "note_delete" &&
          found.tool.isExternal === false &&
          found.dto.moduleId === "notes" &&
          found.dto.name === "notes.delete"
            ? { approvalKind: "note_delete" as const }
            : {}),
          target: result.target,
          fields: result.fields
        },
        disclosureExternalContent:
          (result.content ?? found.tool.approvalContent) !== "user_authored",
        ...(result.version ? { version: result.version } : {})
      });
    }
    if (found.tool.preview) {
      const preview = await runner.withDataContext(access, (db) =>
        found.tool.preview!(db, input, ctx, services)
      );
      return preview ? { preview: structuredClone(preview) } : {};
    }
  } catch (error) {
    if (error instanceof ApprovalInputError) return { validationError: error.message };
    if (found.tool.isExternal === false && error instanceof ApprovalPrerequisiteError)
      return { preparationError: error.message };
    // A failed lookup is not a missing description. Keep unexpected dependency details private.
    if (found.tool.isExternal !== true)
      return {
        preparationError: "The app could not prepare this action. Try again or use its app screen."
      };
    // Connected tools retain their complete exact-argument fallback when no summary is available.
  }
  const exactArguments = found.tool.isExternal === true ? exactArgumentText(input) : null;
  return exactArguments === null ? {} : { externalTool: true, exactArguments };
}

/** Recheck module-owned targets before dispatch; per-call executors keep their stronger boundary. */
export async function runPresentedAction(
  approved: PendingPresentation,
  title: string | undefined,
  recheck: () => Promise<PendingPresentation>,
  run: () => Promise<RunHandlerOutcome>
): Promise<RunHandlerOutcome> {
  let current: PendingPresentation;
  try {
    current = await recheck();
  } catch {
    current = {};
  }
  if (
    !completeActionPresentation({ summary: title ?? "", outcomeTitle: title, ...approved }) ||
    !isDeepStrictEqual(approved, current)
  ) {
    return {
      response: { ok: false, error: "The action changed. Ask Moss again to review fresh details." },
      audit: { outcome: "failed", durationMs: 0, errorClass: "approval_changed" }
    };
  }
  return run();
}

/** Cancellation is pending-only; a completed action is never rewritten if notification fails. */
export async function cancelFailedPresentation(
  deps: {
    readonly runner: Pick<DataContextRunner, "withDataContext">;
    readonly repository: Pick<AiRepository, "resolveAssistantAction">;
  },
  access: AccessContext,
  actionId: string
) {
  try {
    await deps.runner.withDataContext(access, (db) =>
      deps.repository.resolveAssistantAction(db, actionId, { status: "cancelled" })
    );
  } catch {
    /* Ordinary recovery expires the pending row if cancellation storage is unavailable. */
  }
  return {
    ok: false as const,
    error: "Action details are unavailable. Ask Moss to find the action again."
  };
}

/** All fallible preparation precedes pending persistence and waiter creation. */
export async function prepareApprovalCard(
  deps: {
    readonly runner: Pick<DataContextRunner, "withDataContext">;
    readonly resolveActiveModules: ActiveModulesResolver;
    readonly provenance?: ConversationProvenancePort;
  },
  found: ExecutableTool,
  input: Record<string, unknown>,
  ctx: ToolContext,
  services: ToolServices,
  notice?: string
): Promise<
  | { failure: GatewayToolResponse; validationTitle?: string }
  | {
      input: Record<string, unknown>;
      summary: string;
      outcomeTitle: string | undefined;
      presentation: PendingPresentation;
      readPresentation: () => Promise<PendingPresentation>;
    }
> {
  const unavailable = {
    failure: {
      ok: false,
      denied: true,
      reason:
        "approval_unavailable: Complete action details are unavailable. Ask Moss to find the action again."
    } satisfies GatewayToolResponse
  };
  let actionSummary: string;
  try {
    actionSummary = summarizeToolAction(found.tool, input, ctx);
    input = freezeSnapshot(input);
  } catch {
    return unavailable;
  }
  const summary = [notice, actionSummary].filter(Boolean).join(" ");
  let outcomeTitle =
    found.resolution?.summary ??
    (found.tool.approvalPresentation
      ? found.tool.actionLabel
      : found.tool.isExternal === true
        ? (found.tool.actionLabel ?? "Connected tool request")
        : approvalOutcomeTitle(found.tool, actionSummary));
  const readPresentation = async () => {
    const modules = await deps.resolveActiveModules(ctx.actorUserId);
    if (
      !found.resolution &&
      !modules.some(
        (module) =>
          module.id === found.dto.moduleId &&
          module.assistantTools?.some((tool) => tool.name === found.tool.name)
      )
    )
      return {};
    return preparePendingPresentation(
      deps.runner,
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      found,
      input,
      ctx,
      {
        ...services,
        approvalModules: modules.map((entry) => ({
          id: entry.id,
          name: entry.name,
          notificationsSupported: entry.notifications?.supported === true
        }))
      }
    );
  };
  const presentation: PendingPresentation = await readPresentation().catch(() => ({
    preparationError:
      found.tool.isExternal === true
        ? "The connected tool could not prepare this request. Try again or check its connection."
        : "The app could not prepare this action. Try again or use its app screen."
  }));
  if (presentation.title !== undefined) outcomeTitle = presentation.title;
  if (presentation.preparationError)
    return { failure: { ok: false, error: presentation.preparationError } };
  if (presentation.validationError)
    return inputValidationFailure(outcomeTitle ?? "Perform action", presentation.validationError);
  if (!completeActionPresentation({ summary, outcomeTitle, ...presentation })) return unavailable;
  if (
    !(await admitResolvedCard(deps.provenance, found, ctx, presentation.disclosureExternalContent))
  )
    return {
      failure: { ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE } satisfies GatewayToolResponse
    };
  return { input, summary, outcomeTitle, presentation, readPresentation };
}
