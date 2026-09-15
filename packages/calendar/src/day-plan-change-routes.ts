// Confirm route and the 202 gate branch for reserved calendar moves and
// removals (R2.2-T05). The approval is a pending assistant action request
// whose input summary binds actor, plan, operation, revision and the ordered
// change set; confirmation validates the binding, records it, and runs the
// same execution service. Kept out of day-plan-routes.ts so that file stays
// under its size limit.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { handleRouteError, HttpError } from "@moss/module-sdk";
import type { ToolContext } from "@moss/module-sdk";
import {
  confirmDayPlanApplyRouteSchema,
  type ApplyConfirmationRequiredResponse,
  type ApplyExecutionReport,
  type ConfirmDayPlanApplyRequest,
  type DayPlanApplyBatchDto
} from "@moss/shared";

import {
  buildChangeBinding,
  buildLiveChangeBinding,
  changeApprovalSummary,
  changeBindingsEqual,
  changeTierRequiresConfirmation,
  readChangeBinding,
  resolveChangeTier,
  type ApplyChangeAuth,
  type DayPlanChangeApprovalPort
} from "./day-plan-change-approval.js";
import type { ApplyExecutionRouteCallback } from "./day-plan-execute.js";
import type { DayPlanRepository } from "./day-plan-repository.js";

export interface DayPlanChangeRouteDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly dayPlanRepository: Pick<DayPlanRepository, "getById" | "getApplyBatchById">;
  readonly changeApproval?: DayPlanChangeApprovalPort;
  readonly applyExecution?: ApplyExecutionRouteCallback;
}

export interface DayPlanChangeRouteAccess {
  readonly authenticateApplyAccess: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireApplyAccess: (request: FastifyRequest) => AccessContext;
  readonly requireApplyExecution: () => ApplyExecutionRouteCallback;
  readonly toolContextOf: (accessContext: AccessContext) => ToolContext;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireChangeApproval(
  approval: DayPlanChangeApprovalPort | undefined
): DayPlanChangeApprovalPort {
  if (!approval) throw new HttpError(503, "day plan apply is unavailable");
  return approval;
}

// Apply gate for a freshly reserved batch: additions-only batches pass
// straight through, exactly as before. A batch holding any move or removal
// executes only on trusted_auto; otherwise this writes no item outcome,
// makes zero provider calls, and answers 202 with the bound change set.
// Replaying apply with the same idempotency key replays the reservation and
// returns the same pending approval id, never a second one.
export async function gateReservedChanges(input: {
  readonly access: AccessContext;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly dayPlanRepository: Pick<DayPlanRepository, "getById">;
  readonly changeApproval?: DayPlanChangeApprovalPort;
  readonly batch: DayPlanApplyBatchDto;
}): Promise<
  | { readonly proceed: true; readonly tier: string }
  | ({ readonly proceed: false } & ApplyConfirmationRequiredResponse)
> {
  const approval = requireChangeApproval(input.changeApproval);
  const gate = await input.dataContext.withDataContext(input.access, async (scopedDb) => {
    const plan = await input.dayPlanRepository.getById(scopedDb, input.batch.planId);
    if (!plan) throw new HttpError(404, "day plan is not available");
    const tier = resolveChangeTier(await approval.listActionPolicies(scopedDb));
    const binding = buildChangeBinding({
      actorUserId: input.access.actorUserId,
      batch: input.batch,
      plan
    });
    if (!changeTierRequiresConfirmation(tier))
      return { tier, binding, approvalId: null as string | null };
    const existing = await approval.findPendingApprovalForOperation(scopedDb, input.batch.id);
    if (existing) {
      const existingBinding = readChangeBinding(existing.inputSummary);
      if (!existingBinding || !changeBindingsEqual(existingBinding, binding)) {
        throw new HttpError(409, "day plan apply approval does not match the reserved batch");
      }
      return { tier, binding, approvalId: existing.id };
    }
    const created = await approval.createPendingApproval(scopedDb, {
      inputSummary: changeApprovalSummary(binding)
    });
    return { tier, binding, approvalId: created.id };
  });
  if (!changeTierRequiresConfirmation(gate.tier)) return { proceed: true, tier: gate.tier };
  return {
    proceed: false,
    status: "confirmation-required",
    operationId: input.batch.id,
    approvalId: gate.approvalId!,
    changes: gate.binding.changes
  };
}

// Authorization for retry and recover entries over move and removal items:
// the resolved tier plus the operation's confirmed binding, if any. The
// service re-checks both against the frozen batch before executing.
export async function resolveChangeAuth(input: {
  readonly access: AccessContext;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly changeApproval?: DayPlanChangeApprovalPort;
  readonly operationId: string;
}): Promise<ApplyChangeAuth> {
  const approval = requireChangeApproval(input.changeApproval);
  return input.dataContext.withDataContext(input.access, async (scopedDb) => {
    const tier = resolveChangeTier(await approval.listActionPolicies(scopedDb));
    const confirmed = await approval.findConfirmedApprovalForOperation(scopedDb, input.operationId);
    return { tier, approval: confirmed ? readChangeBinding(confirmed.inputSummary) : null };
  });
}

const CONFIRM_BODY_KEYS: ReadonlySet<string> = new Set(["approvalId"]);

async function rejectUnknownConfirmFields(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body;
  if (!isObject(body)) {
    return reply.code(400).send({ error: "request must be an object", code: "day_plan_invalid" });
  }
  const unknown = Object.keys(body).find((entry) => !CONFIRM_BODY_KEYS.has(entry));
  if (unknown) {
    return reply.code(400).send({ error: `unknown field: ${unknown}`, code: "day_plan_invalid" });
  }
  if (typeof body.approvalId !== "string" || body.approvalId.trim().length === 0) {
    return reply
      .code(400)
      .send({ error: "approvalId must be a non-empty string", code: "day_plan_invalid" });
  }
}

export function registerDayPlanChangeConfirmRoute(
  server: FastifyInstance,
  deps: DayPlanChangeRouteDeps,
  access: DayPlanChangeRouteAccess
): void {
  server.post<{ Params: { id: string; operationId: string }; Body: ConfirmDayPlanApplyRequest }>(
    "/api/calendar/day-plans/:id/operations/:operationId/confirm",
    {
      schema: confirmDayPlanApplyRouteSchema,
      onRequest: access.authenticateApplyAccess,
      preValidation: rejectUnknownConfirmFields
    },
    async (request, reply) => {
      try {
        const accessContext = access.requireApplyAccess(request);
        const execute = access.requireApplyExecution();
        const approval = requireChangeApproval(deps.changeApproval);
        // Foreign plans and operations stay invisible and read as 404; the
        // composition gate fails closed with 503 before any of that.
        const batch = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          deps.dayPlanRepository.getApplyBatchById(scopedDb, {
            planId: request.params.id,
            operationId: request.params.operationId
          })
        );
        if (!batch) throw new HttpError(404, "day plan apply operation is not available");
        // A missing approval, including a foreign one invisible to this
        // actor, reads as 409: only the exact pending binding may execute.
        const stored = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          approval.getApproval(scopedDb, request.body.approvalId)
        );
        if (!stored || stored.status !== "pending") {
          throw new HttpError(409, "day plan apply approval is not available");
        }
        const plan = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          deps.dayPlanRepository.getById(scopedDb, batch.planId)
        );
        if (!plan) throw new HttpError(404, "day plan is not available");
        // The live draft must still carry the frozen selection: changed
        // contents require renewed approval, before anything is resolved.
        const expected = buildLiveChangeBinding({
          actorUserId: accessContext.actorUserId,
          batch,
          plan
        });
        const presented = readChangeBinding(stored.inputSummary);
        if (!expected || !presented || !changeBindingsEqual(presented, expected)) {
          throw new HttpError(409, "day plan apply approval does not match the operation");
        }
        // Resolve to confirmed in its own short transaction before execution
        // starts. A replayed confirm finds no pending row and stops here.
        const confirmed = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          approval.confirmApproval(scopedDb, stored.id)
        );
        if (!confirmed) {
          throw new HttpError(409, "day plan apply approval is not available");
        }
        const tier = await deps.dataContext.withDataContext(accessContext, async (scopedDb) =>
          resolveChangeTier(await approval.listActionPolicies(scopedDb))
        );
        const confirmedBinding = presented;
        const report = await execute({
          access: accessContext,
          toolCtx: access.toolContextOf(accessContext),
          planId: batch.planId,
          idempotencyKey: batch.idempotencyKey,
          operationId: batch.id,
          changeAuth: { tier, approval: confirmedBinding }
        });
        return report satisfies ApplyExecutionReport;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
