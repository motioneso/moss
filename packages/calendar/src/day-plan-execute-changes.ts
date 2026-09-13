// Move and removal item execution (R2.2-T05). Runs after the service snapshot
// classified the batch and the change gate passed: every entry re-checks
// provenance before any mutation, never runs a provider call inside an open
// database transaction, and records provider-success/local-failure as unknown
// with the event id so the next recover adopts the observed provider state.
import type { AccessContext, DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import type {
  ApplyExecutionReport,
  ApplyItemFailureReason,
  ApplyItemResult,
  DayPlanApplyBatchDto,
  DayPlanDto,
  DayPlanOperationOutcome,
  DayPlanPendingChange
} from "@moss/shared";

import { applyBlockProvenanceMatches } from "./day-plan-change-approval.js";
import type { DayPlanRepository } from "./day-plan-repository.js";
import type { ApplyBusyInterval, ApplyWriterPort } from "./day-plan-execute.js";

export interface ChangePreparedItem {
  readonly itemId: string;
  readonly blockId: string;
  readonly kind: "move" | "remove";
  readonly startsAt: string | null;
  readonly durationMinutes: number | null;
  readonly title: string;
  // Recorded provider reference of the block's placement, null when the
  // block was never applied. A missing reference fails before any call.
  readonly storedEventRef: string | null;
  // True when a previous attempt already recorded unknown: recovery may
  // adopt the observed provider state instead of failing closed.
  readonly resumeUnknown: boolean;
}

export interface ChangeExecutionContext {
  readonly access: AccessContext;
  readonly toolCtx: ToolContext;
  readonly planId: string;
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly batches: Pick<
    DayPlanRepository,
    "getApplyBatchById" | "recordItemResult" | "mirrorAppliedBlock"
  >;
  readonly facts: {
    readAvailability(window: { readonly start: string; readonly end: string }): Promise<{
      readonly intervals: readonly ApplyBusyInterval[];
      readonly complete: boolean;
    }>;
  };
  readonly writer: Pick<ApplyWriterPort, "lookupAddition" | "moveBlockEvent" | "removeBlockEvent">;
  readonly batch: DayPlanApplyBatchDto;
  readonly plan: DayPlanDto;
}

export function toExecutionReportItem(
  itemId: string | null,
  blockId: string | null,
  outcome: DayPlanOperationOutcome,
  result: ApplyItemResult | null
): ApplyExecutionReport["items"][number] {
  return { itemId, blockId, outcome, result };
}

// Finalization in its own short transaction per item, with the
// applied-never-reset guard: a concurrent resume that recorded this item
// applied after our snapshot keeps its application; our observation never
// resets it.
export async function finalizeItemResult(
  ctx: Pick<ChangeExecutionContext, "access" | "planId" | "dataContext" | "batches">,
  operationId: string,
  itemId: string,
  outcome: DayPlanOperationOutcome,
  result: ApplyItemResult
): Promise<void> {
  await ctx.dataContext.withDataContext(ctx.access, async (scopedDb) => {
    if (outcome !== "applied") {
      const current = await ctx.batches.getApplyBatchById(scopedDb, {
        planId: ctx.planId,
        operationId
      });
      if (current?.items.find((entry) => entry.id === itemId)?.outcome === "applied") return;
    }
    await ctx.batches.recordItemResult(scopedDb, { itemId, operationId, outcome, result });
  });
}

function endsAtOf(startsAt: string, durationMinutes: number): string {
  return new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();
}

function sameInstant(a: string | null, b: string): boolean {
  if (a === null) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

type ProvenanceReadback =
  | { readonly outcome: "failed" }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "not-found" }
  | {
      readonly outcome: "ready";
      readonly lookup: {
        readonly id: string;
        readonly start: string | null;
        readonly end: string | null;
        readonly provenance: Record<string, string>;
        readonly attendeeCount: number | null;
      };
    };

// Provider readback by the block's stored reference. No stored reference
// fails before any provider call; a failed readback stays unknown, never
// absence. Titles are never used to match.
async function checkChangeProvenance(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem
): Promise<ProvenanceReadback> {
  const ref = item.storedEventRef;
  if (!ref) return { outcome: "failed" };
  let lookup: Awaited<ReturnType<ChangeExecutionContext["writer"]["lookupAddition"]>>;
  try {
    lookup = await ctx.writer.lookupAddition({ ctx: ctx.toolCtx, eventId: ref });
  } catch {
    return { outcome: "unknown" };
  }
  if (!lookup.found) return { outcome: "not-found" };
  return {
    outcome: "ready",
    lookup: {
      id: lookup.id,
      start: lookup.start,
      end: lookup.end,
      provenance: lookup.provenance,
      attendeeCount: lookup.attendeeCount ?? null
    }
  };
}

function provenanceOf(ctx: ChangeExecutionContext, item: ChangePreparedItem) {
  return { actorUserId: ctx.access.actorUserId, planId: ctx.batch.planId, blockId: item.blockId };
}

async function failChange(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem,
  reason: ApplyItemFailureReason,
  providerEventId?: string
): Promise<ApplyExecutionReport["items"][number]> {
  const result: ApplyItemResult = { status: "failed", reason, providerEventId };
  await finalizeItemResult(ctx, ctx.batch.id, item.itemId, "failed", result);
  return toExecutionReportItem(item.itemId, item.blockId, "failed", result);
}

async function unknownChange(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem,
  providerEventId?: string
): Promise<ApplyExecutionReport["items"][number]> {
  const result: ApplyItemResult = { status: "unknown", reason: "unknown", providerEventId };
  await finalizeItemResult(ctx, ctx.batch.id, item.itemId, "unknown", result);
  return toExecutionReportItem(item.itemId, item.blockId, "unknown", result);
}

// Mirror and outcome record share one transaction, exactly as additions do.
// When this transaction fails after the provider mutation succeeded, the
// item is recorded unknown with the event id and the batch continues.
async function mirrorMoveApplied(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem,
  placement: { readonly startsAt: string; readonly durationMinutes: number },
  calendarMirror: ApplyItemApplied["calendarMirror"]
): Promise<ApplyExecutionReport["items"][number]> {
  const ref = item.storedEventRef!;
  const frozen = ctx.batch.items.find((entry) => entry.id === item.itemId)?.pendingChange ?? null;
  try {
    const result = await ctx.dataContext.withDataContext(ctx.access, async (scopedDb) => {
      const mirror = await ctx.batches.mirrorAppliedBlock(scopedDb, {
        planId: ctx.plan.id,
        blockId: item.blockId,
        expectedPending: frozen as DayPlanPendingChange | null,
        actualPlacement: {
          startsAt: placement.startsAt,
          durationMinutes: placement.durationMinutes,
          calendarEventRef: ref
        }
      });
      const settled: ApplyItemResult = {
        status: "applied",
        providerEventId: ref,
        startsAt: placement.startsAt,
        durationMinutes: placement.durationMinutes,
        calendarMirror,
        blockMirror: mirror === "mirrored" ? "mirrored" : "mismatch-preserved"
      };
      await ctx.batches.recordItemResult(scopedDb, {
        itemId: item.itemId,
        operationId: ctx.batch.id,
        outcome: "applied",
        result: settled
      });
      return settled;
    });
    return toExecutionReportItem(item.itemId, item.blockId, "applied", result);
  } catch {
    return unknownChange(ctx, item, ref);
  }
}

async function mirrorRemovalApplied(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem,
  observed: { readonly startsAt: string | null; readonly durationMinutes: number | null },
  cacheMirror: "queued" | "deleted" | "skipped-rls" | "skipped-error" | "not-cached"
): Promise<ApplyExecutionReport["items"][number]> {
  const ref = item.storedEventRef!;
  const frozen = ctx.batch.items.find((entry) => entry.id === item.itemId)?.pendingChange ?? null;
  const calendarMirror: ApplyItemApplied["calendarMirror"] =
    cacheMirror === "queued" || cacheMirror === "deleted"
      ? "evicted"
      : cacheMirror === "not-cached"
        ? "not-cached"
        : cacheMirror === "skipped-rls"
          ? "skipped-rls"
          : "skipped-error";
  try {
    const result = await ctx.dataContext.withDataContext(ctx.access, async (scopedDb) => {
      const mirror = await ctx.batches.mirrorAppliedBlock(scopedDb, {
        planId: ctx.plan.id,
        blockId: item.blockId,
        expectedPending: frozen as DayPlanPendingChange | null,
        actualPlacement: { startsAt: null, durationMinutes: null, calendarEventRef: null }
      });
      const settled: ApplyItemResult = {
        status: "applied",
        removed: true,
        providerEventId: ref,
        startsAt: observed.startsAt,
        durationMinutes: observed.durationMinutes,
        calendarMirror,
        blockMirror: mirror === "mirrored" ? "mirrored" : "mismatch-preserved"
      };
      await ctx.batches.recordItemResult(scopedDb, {
        itemId: item.itemId,
        operationId: ctx.batch.id,
        outcome: "applied",
        result: settled
      });
      return settled;
    });
    return toExecutionReportItem(item.itemId, item.blockId, "applied", result);
  } catch {
    return unknownChange(ctx, item, ref);
  }
}

type ApplyItemApplied = Extract<ApplyItemResult, { status: "applied"; removed?: undefined }>;

function observedWindow(lookup: { readonly start: string | null; readonly end: string | null }): {
  readonly startsAt: string | null;
  readonly durationMinutes: number | null;
} {
  if (!lookup.start || !lookup.end) return { startsAt: null, durationMinutes: null };
  const durationMinutes = Math.round(
    (new Date(lookup.end).getTime() - new Date(lookup.start).getTime()) / 60_000
  );
  if (!Number.isFinite(durationMinutes) || durationMinutes < 0) {
    return { startsAt: null, durationMinutes: null };
  }
  return { startsAt: lookup.start, durationMinutes };
}

async function executeMoveItem(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem
): Promise<ApplyExecutionReport["items"][number]> {
  const ref = item.storedEventRef;
  if (item.startsAt === null || item.durationMinutes === null) {
    return failChange(ctx, item, "block-changed", ref ?? undefined);
  }
  const targetStart = item.startsAt;
  const targetEnd = endsAtOf(targetStart, item.durationMinutes);
  const readback = await checkChangeProvenance(ctx, item);
  if (readback.outcome === "failed") return failChange(ctx, item, "provenance-mismatch", ref!);
  if (readback.outcome === "unknown") return unknownChange(ctx, item, ref!);
  if (readback.outcome === "not-found") {
    // A resumed unknown may have patched and lost the event since; without
    // provenance that stays ambiguous. A first attempt without an event to
    // verify can never prove ownership.
    if (item.resumeUnknown) return unknownChange(ctx, item, ref!);
    return failChange(ctx, item, "provenance-mismatch", ref!);
  }
  if (!applyBlockProvenanceMatches(readback.lookup.provenance, provenanceOf(ctx, item))) {
    return failChange(ctx, item, "provenance-mismatch", ref!);
  }
  // The writer's attendee refusal applies regardless of tier or approval.
  if ((readback.lookup.attendeeCount ?? 0) > 0) {
    return failChange(ctx, item, "has-attendees", ref!);
  }
  // Already at the target window: adopt with no patch, still mirrored.
  if (
    sameInstant(readback.lookup.start, targetStart) &&
    sameInstant(readback.lookup.end, targetEnd)
  ) {
    return mirrorMoveApplied(
      ctx,
      item,
      { startsAt: targetStart, durationMinutes: item.durationMinutes },
      "not-checked"
    );
  }
  // Fresh live recheck over the target window, excluding the block's own
  // event so the move never conflicts with itself.
  let live: { intervals: readonly ApplyBusyInterval[]; complete: boolean };
  try {
    live = await ctx.facts.readAvailability({ start: targetStart, end: targetEnd });
  } catch {
    return failChange(ctx, item, "facts-unavailable", ref!);
  }
  if (!live.complete) return failChange(ctx, item, "facts-unavailable", ref!);
  if (
    live.intervals.some(
      (busy) => busy.eventKey !== ref && targetStart < busy.end && busy.start < targetEnd
    )
  ) {
    return failChange(ctx, item, "conflict", ref!);
  }
  let moved: Awaited<ReturnType<ChangeExecutionContext["writer"]["moveBlockEvent"]>>;
  try {
    moved = await ctx.writer.moveBlockEvent({
      ctx: ctx.toolCtx,
      eventRef: ref!,
      newStart: new Date(targetStart),
      newEnd: new Date(targetEnd)
    });
  } catch {
    return unknownChange(ctx, item, ref!);
  }
  if (!moved.ok) {
    if (moved.reason === "has_attendees") return failChange(ctx, item, "has-attendees", ref!);
    return failChange(ctx, item, "provider-rejected", ref!);
  }
  return mirrorMoveApplied(
    ctx,
    item,
    { startsAt: targetStart, durationMinutes: item.durationMinutes },
    "written"
  );
}

async function executeRemoveItem(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem
): Promise<ApplyExecutionReport["items"][number]> {
  const ref = item.storedEventRef;
  const readback = await checkChangeProvenance(ctx, item);
  if (readback.outcome === "failed") return failChange(ctx, item, "provenance-mismatch", ref!);
  if (readback.outcome === "unknown") return unknownChange(ctx, item, ref!);
  if (readback.outcome === "not-found") {
    // Deletion is idempotent: a resumed unknown whose event is now gone has
    // reached the desired end state, so adopt it without a second mutation.
    // A first attempt without an event to verify can never prove ownership.
    if (item.resumeUnknown) {
      return mirrorRemovalApplied(ctx, item, { startsAt: null, durationMinutes: null }, "deleted");
    }
    return failChange(ctx, item, "provenance-mismatch", ref!);
  }
  if (!applyBlockProvenanceMatches(readback.lookup.provenance, provenanceOf(ctx, item))) {
    return failChange(ctx, item, "provenance-mismatch", ref!);
  }
  if ((readback.lookup.attendeeCount ?? 0) > 0) {
    return failChange(ctx, item, "has-attendees", ref!);
  }
  const observed = observedWindow(readback.lookup);
  let removed: Awaited<ReturnType<ChangeExecutionContext["writer"]["removeBlockEvent"]>>;
  try {
    removed = await ctx.writer.removeBlockEvent({ ctx: ctx.toolCtx, eventRef: ref! });
  } catch {
    return unknownChange(ctx, item, ref!);
  }
  // Deleted and already-gone are both applied; anything else definitively
  // failed with no mutation.
  if (!removed.deleted) return failChange(ctx, item, "provider-rejected", ref!);
  return mirrorRemovalApplied(ctx, item, observed, removed.cacheMirror);
}

export async function executeChangeItem(
  ctx: ChangeExecutionContext,
  item: ChangePreparedItem
): Promise<ApplyExecutionReport["items"][number]> {
  return item.kind === "move" ? executeMoveItem(ctx, item) : executeRemoveItem(ctx, item);
}
