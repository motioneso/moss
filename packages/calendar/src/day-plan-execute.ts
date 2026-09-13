// Reserved addition execution (R2.2-T04B). Runs an already-reserved apply batch
// against the provider: one short snapshot transaction, whole-batch facts with
// no service-owned transaction open, provider phase with none open, then one
// short finalization transaction per item. No route exposes this; surfaces
// arrive in later work.
import { createHash } from "node:crypto";

import type { ToolContext } from "@moss/module-sdk";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type {
  ApplyEventProvenance,
  ApplyExecutionReport,
  ApplyItemAppliedResult,
  ApplyItemFailureReason,
  ApplyItemResult,
  DayPlanApplyBatchDto,
  DayPlanDto,
  DayPlanOperationOutcome,
  DayPlanPendingChange
} from "@moss/shared";
import { HttpError } from "@moss/module-sdk";

import { buildDayPlanPreview, type DayPlanPreviewTaskFact } from "./day-plan-preview.js";
import { DayPlanValidationError } from "./day-plan-model.js";
import { pendingChangesEqual } from "./day-plan-apply.js";
import type { DayPlanRepository } from "./day-plan-repository.js";
import type {
  CalendarEventLookup,
  FocusBlockWindow,
  ProposeFocusResult
} from "./calendar-write-service.js";

// Deterministic provider identity for one reserved addition. Same inputs always
// yield the same id, so a retried insert collides instead of duplicating.
export function applyAdditionEventId(input: {
  actorUserId: string;
  planId: string;
  blockId: string;
  planRevision: number;
  operationId: string;
}): string {
  const canonical = [
    input.actorUserId,
    input.planId,
    input.blockId,
    String(input.planRevision),
    input.operationId
  ].join("|");
  const digest = createHash("sha256").update(canonical).digest();
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let out = "";
  for (const byte of digest) {
    out += alphabet[byte & 0x1f];
  }
  return `jap${out}`;
}

// True when the provider-read metadata is exactly the identity we wrote.
export function applyProvenanceMatches(
  actual: Record<string, string>,
  expected: ApplyEventProvenance
): boolean {
  return (
    actual["jarvisTool"] === "applyAddition" &&
    actual["jarvisActorUserId"] === expected.actorUserId &&
    actual["jarvisPlanId"] === expected.planId &&
    actual["jarvisBlockId"] === expected.blockId &&
    actual["jarvisPlanRevision"] === String(expected.planRevision) &&
    actual["jarvisOperationId"] === expected.operationId
  );
}

export interface ApplyExecutionTaskFact {
  readonly id: string;
  readonly ownerUserId: string;
  readonly status: "todo" | "suggested" | "done" | "archived";
}

export interface ApplyBusyInterval {
  readonly start: string;
  readonly end: string;
  readonly title: string;
  readonly accountLabel: string;
  readonly eventKey: string | null;
}

export interface ApplyExecutionAccessGate {
  checkAccess(
    scopedDb: DataContextDb
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface ApplyExecutionFacts {
  readAvailability(window: {
    readonly start: string;
    readonly end: string;
  }): Promise<{ readonly intervals: readonly ApplyBusyInterval[]; readonly complete: boolean }>;
}

// Narrow provider port for apply additions. Carries no database handle: the
// service never lends a transaction to provider I/O, and the composition host
// manages whatever short handle its writer needs internally.
export interface ApplyWriterPort {
  createAddition(input: {
    readonly ctx: ToolContext;
    readonly window: FocusBlockWindow;
    readonly provenance: ApplyEventProvenance;
  }): Promise<ProposeFocusResult>;
  lookupAddition(input: {
    readonly ctx: ToolContext;
    readonly eventId: string;
  }): Promise<CalendarEventLookup>;
}

export interface ApplyExecutionDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly batches: Pick<
    DayPlanRepository,
    "getApplyBatch" | "getApplyBatchById" | "getById" | "recordItemResult" | "mirrorAppliedBlock"
  >;
  readonly findTask: (
    scopedDb: DataContextDb,
    taskId: string
  ) => Promise<ApplyExecutionTaskFact | undefined>;
  readonly accessGate: ApplyExecutionAccessGate;
  readonly facts: ApplyExecutionFacts;
  readonly writer: ApplyWriterPort;
}

export interface ApplyExecutionInput {
  readonly access: AccessContext;
  readonly toolCtx: ToolContext;
  readonly planId: string;
  readonly idempotencyKey: string;
  // Resume by operation id: when present the service loads the batch with
  // getApplyBatchById instead of the idempotency key. Retry and recover pass
  // this; the initial apply does not.
  readonly operationId?: string;
  // Selective retry: only these operation item ids may execute. Omitted
  // means every pending or unknown item.
  readonly itemIds?: readonly string[];
}

interface PreparedItem {
  readonly itemId: string;
  readonly blockId: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly title: string;
}

function endsAtOf(startsAt: string, durationMinutes: number): string {
  return new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();
}

function taskFactOf(status: ApplyExecutionTaskFact["status"]): DayPlanPreviewTaskFact {
  return {
    status: status === "done" ? "done" : status === "archived" ? "archived" : "other",
    dueAt: null
  };
}

function toReportItem(
  itemId: string | null,
  blockId: string | null,
  outcome: DayPlanOperationOutcome,
  result: ApplyItemResult | null
): ApplyExecutionReport["items"][number] {
  return { itemId, blockId, outcome, result };
}

// Route-level execution hook. The selective retry path passes explicit item
// ids; the service rechecks them in its opening snapshot and executes only
// those ids once, leaving every unselected item stored and unchanged.
export interface ApplyExecutionRouteCallback {
  (input: ApplyExecutionInput): Promise<ApplyExecutionReport>;
}

export class ApplyExecutionService {
  constructor(private readonly deps: ApplyExecutionDeps) {}

  async executeReservedAdditions(input: ApplyExecutionInput): Promise<ApplyExecutionReport> {
    // One short snapshot transaction: batch, plan, task ownership and status,
    // and the access gate. It closes before any provider work below.
    const snapshot = await this.deps.dataContext.withDataContext(input.access, (scopedDb) =>
      this.snapshotBatch(scopedDb, input)
    );
    if (snapshot.denied) {
      return this.deniedReport(snapshot.batch, snapshot.reason);
    }
    if (snapshot.pending.length === 0) {
      const settledOnly: ApplyExecutionReport["items"] = snapshot.settled.map((item) =>
        toReportItem(item.id, item.blockId, item.outcome, item.result)
      );
      return {
        operationId: snapshot.batch.id,
        planId: snapshot.batch.planId,
        status: "completed",
        items: settledOnly
      };
    }
    // Whole-batch facts run with no service-owned transaction open: the
    // facts adapter stages its own short reads and runs token refresh and
    // every Google read at transaction depth zero. Incomplete facts deny the
    // whole batch with zero creates.
    const window = {
      start: snapshot.pending.map((item) => item.startsAt).sort()[0]!,
      end: snapshot.pending
        .map((item) => endsAtOf(item.startsAt, item.durationMinutes))
        .sort()
        .at(-1)!
    };
    const availability = await this.deps.facts.readAvailability(window);
    if (!availability.complete) {
      return this.deniedReport(
        snapshot.batch,
        "facts-unavailable: current calendar facts are incomplete"
      );
    }
    const conflict = this.checkConflicts(snapshot.plan, snapshot.pending, snapshot.taskFacts, {
      intervals: availability.intervals
    });
    if (conflict) {
      return this.deniedReport(snapshot.batch, conflict);
    }
    const reports: ApplyExecutionReport["items"] = snapshot.settled.map((item) =>
      toReportItem(item.id, item.blockId, item.outcome, item.result)
    );
    for (const item of snapshot.pending) {
      reports.push(await this.executeItem(input, snapshot.batch, snapshot.plan, item));
    }
    return {
      operationId: snapshot.batch.id,
      planId: snapshot.batch.planId,
      status: "completed",
      items: reports
    };
  }

  private deniedReport(batch: DayPlanApplyBatchDto, reason: string): ApplyExecutionReport {
    const items = batch.items.map((item) =>
      toReportItem(item.id, item.blockId, item.outcome, item.result)
    );
    return {
      operationId: batch.id,
      planId: batch.planId,
      status: "denied",
      denialReason: reason,
      items
    };
  }

  // Pure conflict check over the snapshot plus whole-batch facts. No database
  // or provider work: any failure denies the whole batch with zero writes.
  private checkConflicts(
    plan: DayPlanDto,
    pending: PreparedItem[],
    taskFacts: Map<string, DayPlanPreviewTaskFact>,
    availability: { intervals: readonly ApplyBusyInterval[] }
  ): string | null {
    try {
      const preview = buildDayPlanPreview({
        plan,
        selectedBlockIds: pending.map((item) => item.blockId),
        taskFacts,
        busyIntervals: availability.intervals,
        calendarAvailability: "available",
        calendarAsOf: null,
        now: new Date()
      });
      if (preview.conflicts.length > 0) {
        const detail = preview.conflicts
          .map((conflict) => `${conflict.blockId}:${conflict.kind}`)
          .join(",");
        return `conflict: reserved additions overlap protected time (${detail})`;
      }
      const eligible = new Set(preview.eligibleBlockIds);
      if (!pending.every((item) => eligible.has(item.blockId))) {
        return "task-ineligible: a reserved addition is no longer eligible";
      }
      return null;
    } catch (error) {
      if (error instanceof DayPlanValidationError) {
        return `block-changed: ${error.message}`;
      }
      throw error;
    }
  }

  // Short read-only snapshot transaction: reload the reservation and
  // revalidate every non-applied item before the first provider write. Task
  // ownership and status ride along as immutable facts so later stages never
  // reopen a transaction for them. Any failure denies the whole batch.
  private async snapshotBatch(
    scopedDb: DataContextDb,
    input: ApplyExecutionInput
  ): Promise<
    | { readonly denied: true; readonly reason: string; readonly batch: DayPlanApplyBatchDto }
    | {
        readonly denied: false;
        readonly batch: DayPlanApplyBatchDto;
        readonly plan: DayPlanDto;
        readonly settled: DayPlanApplyBatchDto["items"];
        readonly pending: PreparedItem[];
        readonly taskFacts: Map<string, DayPlanPreviewTaskFact>;
      }
  > {
    const batch =
      input.operationId === undefined
        ? await this.deps.batches.getApplyBatch(scopedDb, {
            planId: input.planId,
            idempotencyKey: input.idempotencyKey
          })
        : await this.deps.batches.getApplyBatchById(scopedDb, {
            planId: input.planId,
            operationId: input.operationId
          });
    if (!batch) throw new HttpError(404, "day plan apply batch is not available");
    const deny = (reason: string) => ({ denied: true as const, reason, batch });
    if (batch.items.some((item) => item.kind !== "add")) {
      return deny("mixed-batch: reserved batch contains a move or removal");
    }
    const plan = await this.deps.batches.getById(scopedDb, batch.planId);
    if (!plan) throw new HttpError(404, "day plan is not available");
    const blockById = new Map(plan.blocks.map((block) => [block.id, block]));
    const selected = input.itemIds === undefined ? undefined : new Set(input.itemIds);
    const settled: DayPlanApplyBatchDto["items"] = [];
    const pending: PreparedItem[] = [];
    for (const item of batch.items) {
      // Selective retry leaves every unselected item stored and unchanged:
      // it is reported as-is and never validated or executed.
      if (selected !== undefined && !selected.has(item.id)) {
        settled.push(item);
        continue;
      }
      if (selected !== undefined) {
        // The route already validated the selection atomically; the snapshot
        // rechecks it so a changed item can never execute on a stale retry.
        // A selected failed or unknown item skips the settled short-circuit
        // below and enters pending classification. A stale selection is a
        // 409, never a denied report.
        if (item.kind !== "add" || (item.outcome !== "failed" && item.outcome !== "unknown")) {
          throw new HttpError(409, "day plan apply retry selection is not eligible");
        }
      } else if (item.outcome === "applied" || item.outcome === "failed") {
        // Applied and failed items are settled facts: only pending and unknown
        // items enter reconciliation and execution, so an ordinary replay makes
        // no facts or provider call for them.
        settled.push(item);
        continue;
      }
      if (item.blockId === null) return deny("block-changed: reserved block is gone");
      const block = blockById.get(item.blockId);
      if (!block || !pendingChangesEqual(block.pendingChange, item.pendingChange)) {
        return deny("block-changed: reserved block no longer matches its frozen change");
      }
      const change = item.pendingChange;
      if (change.kind !== "add" || !change.startsAt || !change.durationMinutes) {
        return deny("block-changed: reserved addition lost its timing");
      }
      if (block.taskId !== null) {
        const task = await this.deps.findTask(scopedDb, block.taskId);
        if (!task || task.ownerUserId !== input.access.actorUserId) {
          return deny("task-unavailable: reserved task is not available");
        }
        if (task.status === "done" || task.status === "archived") {
          return deny("task-ineligible: reserved task is done or archived");
        }
      }
      pending.push({
        itemId: item.id,
        blockId: item.blockId,
        startsAt: change.startsAt,
        durationMinutes: change.durationMinutes,
        title: block.title ?? "Planned block"
      });
    }
    // Nothing left to do: settled outcomes are already recorded, so report
    // them unchanged without consulting task state, the access gate, facts,
    // or the provider. Current policy can never revoke a recorded outcome.
    if (pending.length === 0) {
      return { denied: false, batch, plan, settled, pending, taskFacts: new Map() };
    }
    const taskIds = new Set<string>();
    for (const block of plan.blocks) {
      if (block.taskId !== null) taskIds.add(block.taskId);
    }
    const taskFacts = new Map<string, DayPlanPreviewTaskFact>();
    for (const taskId of taskIds) {
      const task = await this.deps.findTask(scopedDb, taskId);
      if (task) taskFacts.set(taskId, taskFactOf(task.status));
    }
    const gate = await this.deps.accessGate.checkAccess(scopedDb);
    if (!gate.ok) return deny(`access-denied: ${gate.reason}`);
    return { denied: false, batch, plan, settled, pending, taskFacts };
  }

  // One item, no service-owned transaction: reconcile, live-recheck, create,
  // verify, then finalize in a fresh transaction.
  private async executeItem(
    input: ApplyExecutionInput,
    batch: DayPlanApplyBatchDto,
    plan: DayPlanDto,
    item: PreparedItem
  ): Promise<ApplyExecutionReport["items"][number]> {
    const provenance: ApplyEventProvenance = {
      actorUserId: input.access.actorUserId,
      planId: batch.planId,
      blockId: item.blockId,
      planRevision: batch.expectedRevision,
      operationId: batch.id
    };
    const eventId = applyAdditionEventId({
      actorUserId: provenance.actorUserId,
      planId: provenance.planId,
      blockId: provenance.blockId,
      planRevision: provenance.planRevision,
      operationId: provenance.operationId
    });
    const fail = async (
      reason: ApplyItemFailureReason,
      providerEventId?: string
    ): Promise<ApplyExecutionReport["items"][number]> => {
      const result: ApplyItemResult = { status: "failed", reason, providerEventId };
      await this.finalize(input, batch.id, item.itemId, "failed", result);
      return toReportItem(item.itemId, item.blockId, "failed", result);
    };
    const unknown = async (
      reason: ApplyItemFailureReason,
      providerEventId?: string
    ): Promise<ApplyExecutionReport["items"][number]> => {
      const result: ApplyItemResult = { status: "unknown", reason, providerEventId };
      await this.finalize(input, batch.id, item.itemId, "unknown", result);
      return toReportItem(item.itemId, item.blockId, "unknown", result);
    };

    // Reconcile first: an earlier attempt may already own this identity.
    let reconciled: CalendarEventLookup;
    try {
      reconciled = await this.deps.writer.lookupAddition({ ctx: input.toolCtx, eventId });
    } catch {
      return unknown("unknown", eventId);
    }
    if (reconciled.found) {
      if (!applyProvenanceMatches(reconciled.provenance, provenance)) {
        return fail("provenance-mismatch", eventId);
      }
      // The local cache was not verified on this path, so its mirror state
      // stays honestly unchecked rather than borrowing a write outcome.
      return this.applyVerified(
        input,
        batch,
        plan,
        item,
        eventId,
        reconciled.start,
        reconciled.end,
        "not-checked"
      );
    }

    // Fresh live recheck immediately before creation.
    let live: { intervals: readonly ApplyBusyInterval[]; complete: boolean };
    try {
      live = await this.deps.facts.readAvailability({
        start: item.startsAt,
        end: endsAtOf(item.startsAt, item.durationMinutes)
      });
    } catch {
      return fail("facts-unavailable", eventId);
    }
    if (!live.complete) return fail("facts-unavailable", eventId);
    if (
      live.intervals.some(
        (busy) =>
          item.startsAt < busy.end && busy.start < endsAtOf(item.startsAt, item.durationMinutes)
      )
    ) {
      return fail("conflict", eventId);
    }

    let created: ProposeFocusResult;
    try {
      created = await this.deps.writer.createAddition({
        ctx: input.toolCtx,
        window: {
          start: new Date(item.startsAt),
          end: new Date(endsAtOf(item.startsAt, item.durationMinutes)),
          durationMinutes: item.durationMinutes,
          title: item.title
        },
        provenance
      });
    } catch {
      return unknown("unknown", eventId);
    }
    if (!created.created) {
      if (created.conflict === "no-clear-slot") {
        return fail("conflict", created.googleEventId ?? eventId);
      }
      return fail("provider-rejected", created.googleEventId ?? eventId);
    }
    const createdId = created.googleEventId ?? eventId;

    // A duplicate id or ambiguous response only counts after lookup confirms
    // the exact operation metadata; anything else stays unresolved.
    let verified: CalendarEventLookup;
    try {
      verified = await this.deps.writer.lookupAddition({ ctx: input.toolCtx, eventId: createdId });
    } catch {
      return unknown("unknown", createdId);
    }
    if (!verified.found) return unknown("unknown", createdId);
    if (!applyProvenanceMatches(verified.provenance, provenance)) {
      return fail("provenance-mismatch", createdId);
    }
    return this.applyVerified(
      input,
      batch,
      plan,
      item,
      createdId,
      verified.start,
      verified.end,
      created.calendarMirror
    );
  }

  private async applyVerified(
    input: ApplyExecutionInput,
    batch: DayPlanApplyBatchDto,
    plan: DayPlanDto,
    item: PreparedItem,
    providerEventId: string,
    providerStart: string | null,
    providerEnd: string | null,
    calendarMirror: ApplyItemAppliedResult["calendarMirror"]
  ): Promise<ApplyExecutionReport["items"][number]> {
    const startsAt = providerStart ?? item.startsAt;
    const durationMinutes =
      providerStart && providerEnd
        ? Math.round((new Date(providerEnd).getTime() - new Date(providerStart).getTime()) / 60_000)
        : item.durationMinutes;
    const frozen = batch.items.find((entry) => entry.id === item.itemId)?.pendingChange ?? null;
    // Mirror and outcome record share one transaction: a crash between them
    // must never leave a mirrored block with a pending outcome behind. When
    // this transaction fails after the provider create succeeded, the item is
    // recorded unknown with the event id so the next recover adopts it; the
    // response is unknown, never applied, and the batch continues.
    let result: ApplyItemResult;
    try {
      result = await this.deps.dataContext.withDataContext(input.access, async (scopedDb) => {
        const mirror = await this.deps.batches.mirrorAppliedBlock(scopedDb, {
          planId: plan.id,
          blockId: item.blockId,
          expectedPending: frozen as DayPlanPendingChange | null,
          actualPlacement: {
            startsAt,
            durationMinutes,
            calendarEventRef: providerEventId
          }
        });
        const settled: ApplyItemResult = {
          status: "applied",
          providerEventId,
          startsAt,
          durationMinutes,
          calendarMirror,
          blockMirror: mirror === "mirrored" ? "mirrored" : "mismatch-preserved"
        };
        await this.deps.batches.recordItemResult(scopedDb, {
          itemId: item.itemId,
          operationId: batch.id,
          outcome: "applied",
          result: settled
        });
        return settled;
      });
      return toReportItem(item.itemId, item.blockId, "applied", result);
    } catch {
      const unresolved: ApplyItemResult = { status: "unknown", reason: "unknown", providerEventId };
      try {
        await this.finalize(input, batch.id, item.itemId, "unknown", unresolved);
      } catch {
        // The record itself failed: still report unknown, never applied.
      }
      return toReportItem(item.itemId, item.blockId, "unknown", unresolved);
    }
  }

  private async finalize(
    input: ApplyExecutionInput,
    operationId: string,
    itemId: string,
    outcome: DayPlanOperationOutcome,
    result: ApplyItemResult
  ): Promise<void> {
    await this.deps.dataContext.withDataContext(input.access, async (scopedDb) => {
      if (outcome !== "applied") {
        // A concurrent resume may have recorded this item applied after our
        // snapshot: never reset a recorded application with our observation.
        const current = await this.deps.batches.getApplyBatchById(scopedDb, {
          planId: input.planId,
          operationId
        });
        if (current?.items.find((entry) => entry.id === itemId)?.outcome === "applied") return;
      }
      await this.deps.batches.recordItemResult(scopedDb, { itemId, operationId, outcome, result });
    });
  }
}
