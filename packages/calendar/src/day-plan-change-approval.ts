// Change confirmation for reserved calendar moves and removals (R2.2-T05).
// Pure helpers plus the calendar-owned approval port: the confirmation gate
// that existing Calendar policy requires for deletes and reschedules, the
// provenance check that stops the plan from touching an event it did not
// create, and the binding that ties one approval to one exact operation.
// This module never reads or writes anything itself and never calls a
// provider; the composition host implements the port on the audited
// assistant-action store. There is no boolean confirmed field anywhere.
import type { DataContextDb } from "@moss/db";
import type { DayPlanApplyBatchDto, DayPlanChangeSetEntry, DayPlanDto } from "@moss/shared";

import { pendingChangesEqual } from "./day-plan-apply.js";
import { CALENDAR_MODULE_ID, calendarModuleManifest } from "./manifest.js";

export const CHANGE_APPROVAL_FAMILY_ID = "calendar_management";
export const CHANGE_APPROVAL_TOOL_NAME = "calendar.applyDayPlanChanges";
export const CHANGE_APPROVAL_PERMISSION_ID = "calendar.manage";

// The audited binding stored as the approval's input summary: actor, plan,
// operation, expected revision, and the ordered change set. Creating revision
// and operation id of the underlying provider events may differ; this binding
// always names the operation being confirmed.
export interface DayPlanChangeBinding {
  readonly actorUserId: string;
  readonly planId: string;
  readonly operationId: string;
  readonly planRevision: number;
  readonly changes: DayPlanChangeSetEntry[];
}

// Authorization carried into the execution service on every entry. The
// service re-checks it against the frozen batch before touching a move or
// removal, so a confirmed approval for an unchanged operation is reused with
// no per-item prompt.
export interface ApplyChangeAuth {
  readonly tier: string;
  readonly approval: DayPlanChangeBinding | null;
}

function manifestDefaultTier(): string {
  const families = (
    calendarModuleManifest as unknown as {
      assistantActionFamilies?: readonly { id: string; defaultTier: string }[];
    }
  ).assistantActionFamilies;
  return (
    families?.find((family) => family.id === CHANGE_APPROVAL_FAMILY_ID)?.defaultTier ??
    "always_confirm"
  );
}

// One entry per frozen batch item, in batch order. The stored provider
// reference comes from the block's recorded placement: null for additions,
// which do not exist yet, and whatever the block records for moves and
// removals (null when the block was never applied).
export function buildOperationChangeSet(
  batch: DayPlanApplyBatchDto,
  plan: DayPlanDto
): DayPlanChangeSetEntry[] {
  const blockById = new Map(plan.blocks.map((block) => [block.id, block]));
  return batch.items.map((item) => {
    const change = item.pendingChange;
    const block = item.blockId ? blockById.get(item.blockId) : undefined;
    return {
      blockId: item.blockId ?? change.blockId,
      kind: item.kind,
      calendarEventRef:
        item.kind === "add" ? null : (block?.actualPlacement?.calendarEventRef ?? null),
      startsAt: change.kind === "remove" ? null : (change.startsAt ?? null),
      durationMinutes: change.kind === "remove" ? null : (change.durationMinutes ?? null)
    };
  });
}

export function buildChangeBinding(input: {
  readonly actorUserId: string;
  readonly batch: DayPlanApplyBatchDto;
  readonly plan: DayPlanDto;
}): DayPlanChangeBinding {
  return {
    actorUserId: input.actorUserId,
    planId: input.batch.planId,
    operationId: input.batch.id,
    planRevision: input.batch.expectedRevision,
    changes: buildOperationChangeSet(input.batch, input.plan)
  };
}

// Live binding for the confirm entry: same shape as the frozen binding,
// but timing and references come from the blocks as they stand now, and the
// frozen pending change of every item must still match the live draft. Null
// when the draft drifted under the reservation: changed contents require
// renewed approval, so the confirm stops at 409 before resolving anything.
export function buildLiveChangeBinding(input: {
  readonly actorUserId: string;
  readonly batch: DayPlanApplyBatchDto;
  readonly plan: DayPlanDto;
}): DayPlanChangeBinding | null {
  const blockById = new Map(input.plan.blocks.map((block) => [block.id, block]));
  const changes: DayPlanChangeSetEntry[] = [];
  for (const item of input.batch.items) {
    const block = item.blockId ? blockById.get(item.blockId) : undefined;
    if (!block || !pendingChangesEqual(block.pendingChange, item.pendingChange)) return null;
    const live = block.pendingChange;
    changes.push({
      blockId: item.blockId ?? item.pendingChange.blockId,
      kind: item.kind,
      calendarEventRef:
        item.kind === "add" ? null : (block.actualPlacement?.calendarEventRef ?? null),
      startsAt: live?.kind === "remove" || !live ? null : (live.startsAt ?? null),
      durationMinutes: live?.kind === "remove" || !live ? null : (live.durationMinutes ?? null)
    });
  }
  return {
    actorUserId: input.actorUserId,
    planId: input.batch.planId,
    operationId: input.batch.id,
    planRevision: input.batch.expectedRevision,
    changes
  };
}

// Exact equality: same actor, plan, operation, revision, and every change
// entry in order. Any drift means renewed approval.
export function changeBindingsEqual(a: DayPlanChangeBinding, b: DayPlanChangeBinding): boolean {
  if (
    a.actorUserId !== b.actorUserId ||
    a.planId !== b.planId ||
    a.operationId !== b.operationId ||
    a.planRevision !== b.planRevision ||
    a.changes.length !== b.changes.length
  ) {
    return false;
  }
  return a.changes.every((entry, index) => {
    const other = b.changes[index]!;
    return (
      entry.blockId === other.blockId &&
      entry.kind === other.kind &&
      entry.calendarEventRef === other.calendarEventRef &&
      entry.startsAt === other.startsAt &&
      entry.durationMinutes === other.durationMinutes
    );
  });
}

// Reads our binding back from a stored input summary. Null for anything we
// did not write, including other tools' approvals sharing the same store.
export function readChangeBinding(value: unknown): DayPlanChangeBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.tool !== CHANGE_APPROVAL_TOOL_NAME) return null;
  if (
    typeof row.actorUserId !== "string" ||
    typeof row.planId !== "string" ||
    typeof row.operationId !== "string" ||
    typeof row.planRevision !== "number" ||
    !Array.isArray(row.changes)
  ) {
    return null;
  }
  const changes: DayPlanChangeSetEntry[] = [];
  for (const entry of row.changes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const change = entry as Record<string, unknown>;
    if (
      typeof change.blockId !== "string" ||
      (change.kind !== "add" && change.kind !== "move" && change.kind !== "remove") ||
      (change.calendarEventRef !== null && typeof change.calendarEventRef !== "string") ||
      (change.startsAt !== null && typeof change.startsAt !== "string") ||
      (change.durationMinutes !== null && typeof change.durationMinutes !== "number")
    ) {
      return null;
    }
    changes.push({
      blockId: change.blockId,
      kind: change.kind,
      calendarEventRef: change.calendarEventRef,
      startsAt: change.startsAt,
      durationMinutes: change.durationMinutes
    });
  }
  return {
    actorUserId: row.actorUserId,
    planId: row.planId,
    operationId: row.operationId,
    planRevision: row.planRevision,
    changes
  };
}

export function changeApprovalSummary(binding: DayPlanChangeBinding): Record<string, unknown> {
  return {
    tool: CHANGE_APPROVAL_TOOL_NAME,
    actorUserId: binding.actorUserId,
    planId: binding.planId,
    operationId: binding.operationId,
    planRevision: binding.planRevision,
    changes: binding.changes.map((entry) => ({ ...entry }))
  };
}

export interface ChangePolicyRow {
  readonly moduleId: string;
  readonly actionFamilyId: string;
  readonly tier: string;
}

// The tier is read from the same policy store the gateway reads, for the
// calendar_management family, falling back to the manifest default.
export function resolveChangeTier(policies: readonly ChangePolicyRow[]): string {
  const policy = policies.find(
    (row) => row.moduleId === CALENDAR_MODULE_ID && row.actionFamilyId === CHANGE_APPROVAL_FAMILY_ID
  );
  return policy?.tier ?? manifestDefaultTier();
}

// Only an explicit trusted_auto promotion executes without confirmation;
// every other tier, including ask_each_time, confirms.
export function changeTierRequiresConfirmation(tier: string): boolean {
  return tier !== "trusted_auto";
}

// Provenance for a block the plan applied earlier: the creating revision and
// operation id may differ, so only actor, plan and block must match. Titles
// are never used to match.
export function applyBlockProvenanceMatches(
  actual: Record<string, string>,
  expected: { readonly actorUserId: string; readonly planId: string; readonly blockId: string }
): boolean {
  return (
    actual["jarvisTool"] === "applyAddition" &&
    actual["jarvisActorUserId"] === expected.actorUserId &&
    actual["jarvisPlanId"] === expected.planId &&
    actual["jarvisBlockId"] === expected.blockId
  );
}

export function batchHasChanges(batch: DayPlanApplyBatchDto): boolean {
  return batch.items.some((item) => item.kind !== "add");
}

export type DayPlanChangeApprovalStatus = "pending" | "confirmed" | "rejected" | "cancelled";

export interface DayPlanChangeApprovalRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly status: DayPlanChangeApprovalStatus;
  readonly inputSummary: Record<string, unknown>;
}

// Calendar-owned port over the audited assistant-action store. The
// composition host implements it; the approval lives in existing storage
// with no migration.
export interface DayPlanChangeApprovalPort {
  createPendingApproval(
    scopedDb: DataContextDb,
    input: { readonly inputSummary: Record<string, unknown> }
  ): Promise<DayPlanChangeApprovalRecord>;
  getApproval(
    scopedDb: DataContextDb,
    approvalId: string
  ): Promise<DayPlanChangeApprovalRecord | undefined>;
  // Resolves pending to confirmed atomically; undefined when the row is not
  // pending, so a replayed confirm can never double-execute.
  confirmApproval(
    scopedDb: DataContextDb,
    approvalId: string
  ): Promise<DayPlanChangeApprovalRecord | undefined>;
  findPendingApprovalForOperation(
    scopedDb: DataContextDb,
    operationId: string
  ): Promise<DayPlanChangeApprovalRecord | undefined>;
  findConfirmedApprovalForOperation(
    scopedDb: DataContextDb,
    operationId: string
  ): Promise<DayPlanChangeApprovalRecord | undefined>;
  listActionPolicies(scopedDb: DataContextDb): Promise<readonly ChangePolicyRow[]>;
}

// Gate for one execution entry: only move and removal items need a pass.
// Trusted_auto always passes; otherwise the caller must present the binding
// of this operation. Only the items about to execute are compared: settled
// items keep their stored outcomes and never re-execute, while their live
// blocks legitimately changed through mirroring (an applied removal clears
// its stored reference). Anything else denies with no writes.
export function checkChangeGate(input: {
  readonly batch: DayPlanApplyBatchDto;
  readonly executingItemIds: readonly string[];
  readonly binding: DayPlanChangeBinding;
  readonly auth: ApplyChangeAuth | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const byId = new Set(input.executingItemIds);
  const executingIndexes = new Set(
    input.batch.items.flatMap((item, index) => (byId.has(item.id) ? [index] : []))
  );
  const executingKinds = input.batch.items
    .filter((item) => byId.has(item.id))
    .map((item) => item.kind);
  if (!executingKinds.some((kind) => kind !== "add")) return { ok: true };
  const tier = input.auth?.tier ?? manifestDefaultTier();
  if (!changeTierRequiresConfirmation(tier)) return { ok: true };
  if (
    input.auth?.approval &&
    executingBindingsEqual(input.auth.approval, input.binding, executingIndexes)
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "confirmation-required: reserved moves or removals need a confirmed approval"
  };
}

// Exact binding equality scoped to the executing items: same actor, plan,
// operation and revision, and every executing change entry in order. Both
// bindings come from the same frozen batch, so positions line up; settled
// entries are skipped, never trusted.
function executingBindingsEqual(
  approval: DayPlanChangeBinding,
  current: DayPlanChangeBinding,
  executing: ReadonlySet<number>
): boolean {
  if (
    approval.actorUserId !== current.actorUserId ||
    approval.planId !== current.planId ||
    approval.operationId !== current.operationId ||
    approval.planRevision !== current.planRevision ||
    approval.changes.length !== current.changes.length
  ) {
    return false;
  }
  return approval.changes.every((entry, index) => {
    const other = current.changes[index]!;
    if (!executing.has(index)) return true;
    return (
      entry.blockId === other.blockId &&
      entry.kind === other.kind &&
      entry.calendarEventRef === other.calendarEventRef &&
      entry.startsAt === other.startsAt &&
      entry.durationMinutes === other.durationMinutes
    );
  });
}
