import Fastify from "fastify";
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ids } from "./test-database.js";
import { registerDayPlanRoutes } from "../../packages/calendar/src/day-plan-routes.js";
import {
  applyMixed,
  assertWriterOutsideTransactions,
  buildApp,
  buildQuietService,
  buildService,
  destroyChangesHarness,
  harnessAiRepository,
  harnessApprovalPort,
  harnessDataContext,
  harnessRepository,
  initChangesHarness,
  makeChangeWriterFake,
  nextChangeDay,
  placementRefOf,
  resetChangesProbe,
  seedChangePlan,
  stageBusyInterval,
  storedItems,
  toolCtx,
  userA,
  userB,
  T0,
  T1,
  T3,
  T4,
  TIME_ZONE
} from "./day-plan-apply-changes-harness.js";

describe("apply moves and removals boundary", () => {
  beforeAll(async () => {
    await initChangesHarness();
  });

  afterAll(async () => {
    await destroyChangesHarness();
  });

  afterEach(() => {
    resetChangesProbe();
  });

  it("Accept All reserves additions only; auth runs before validation", async () => {
    const fake = makeChangeWriterFake();
    const created = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.createForDay(scopedDb, { localDay: nextChangeDay(), timeZone: TIME_ZONE })
    );
    const drafted = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.saveDraft(scopedDb, {
        planId: created.id,
        localDay: created.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: created.revision,
        blocks: [
          {
            taskId: null,
            kind: "focus",
            title: "Add me",
            pendingChange: { kind: "add", startsAt: T0, durationMinutes: 30 }
          },
          {
            taskId: null,
            kind: "focus",
            title: "Move me",
            pendingChange: { kind: "move", startsAt: T3, durationMinutes: 30 }
          },
          {
            taskId: null,
            kind: "focus",
            title: "Remove me",
            pendingChange: { kind: "remove" }
          }
        ]
      })
    );
    const service = buildService(fake);
    const app = buildApp(userA(), service);

    // Omitted selection means additions only: the move and removal stay pending.
    const response = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${drafted.id}/apply`,
      payload: { expectedRevision: drafted.revision, idempotencyKey: `accept-all-${randomUUID()}` }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { blockId: string | null; outcome: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.outcome).toBe("applied");
    expect(fake.creates).toHaveLength(1);
    const reloaded = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, drafted.id)
    );
    const byTitle = new Map((reloaded?.blocks ?? []).map((block) => [block.title, block]));
    expect(byTitle.get("Move me")?.pendingChange?.kind).toBe("move");
    expect(byTitle.get("Remove me")?.pendingChange?.kind).toBe("remove");
    assertWriterOutsideTransactions();

    // Auth runs before validation: a bad session beats a malformed body.
    const deniedApp = Fastify();
    registerDayPlanRoutes(deniedApp, {
      resolveAccessContext: async () => {
        throw new Error("Session is missing or expired");
      },
      resolveTimeZone: async () => TIME_ZONE,
      dayPlanRepository: harnessRepository,
      findSourceRun: async () => undefined,
      findTask: async () => undefined,
      findRun: async () => undefined,
      dataContext: harnessDataContext
    });
    const denied = await deniedApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${drafted.id}/apply`,
      payload: { nonsense: true }
    });
    expect(denied.statusCode).toBe(401);

    // A foreign plan reads as 404.
    const foreign = await buildApp(userB(), service).inject({
      method: "POST",
      url: `/api/calendar/day-plans/${drafted.id}/apply`,
      payload: { expectedRevision: drafted.revision, idempotencyKey: `foreign-${randomUUID()}` }
    });
    expect(foreign.statusCode).toBe(404);

    // No execution runtime fails closed with 503 before any reservation.
    const downApp = Fastify();
    registerDayPlanRoutes(downApp, {
      resolveAccessContext: async () => userA(),
      resolveTimeZone: async () => TIME_ZONE,
      dayPlanRepository: harnessRepository,
      findSourceRun: async () => undefined,
      findTask: async () => undefined,
      findRun: async () => undefined,
      dataContext: harnessDataContext
    });
    const down = await downApp.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${drafted.id}/apply`,
      payload: { expectedRevision: drafted.revision, idempotencyKey: `down-${randomUUID()}` }
    });
    expect(down.statusCode).toBe(503);
  });

  it("gates a mixed batch with 202 and replays the same approval id", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);
    const key = `gate-${randomUUID()}`;

    const first = await applyMixed(
      app,
      plan.id,
      plan.revision,
      [blockIds.move, blockIds.remove, blockIds.add],
      key
    );
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as {
      status: string;
      operationId: string;
      approvalId: string;
      changes: {
        blockId: string;
        kind: string;
        calendarEventRef: string | null;
        startsAt: string | null;
        durationMinutes: number | null;
      }[];
    };
    expect(firstBody.status).toBe("confirmation-required");
    expect(firstBody.changes).toHaveLength(3);
    expect(firstBody.changes[0]).toMatchObject({
      blockId: blockIds.move,
      kind: "move",
      startsAt: T3,
      durationMinutes: 30
    });
    expect(firstBody.changes[0]!.calendarEventRef).toMatch(/^jap/);
    expect(firstBody.changes[1]).toMatchObject({
      blockId: blockIds.remove,
      kind: "remove",
      startsAt: null,
      durationMinutes: null
    });
    expect(firstBody.changes[1]!.calendarEventRef).toMatch(/^jap/);
    expect(firstBody.changes[2]).toEqual({
      blockId: blockIds.add,
      kind: "add",
      calendarEventRef: null,
      startsAt: T4,
      durationMinutes: 30
    });
    // Zero provider calls and no item outcome: every item is still pending.
    expect(fake.mutations()).toBe(0);
    expect(fake.lookups).toHaveLength(0);
    const status = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${firstBody.operationId}`
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json() as { status: string; items: { outcome: string }[] };
    expect(statusBody.status).toBe("pending");
    expect(statusBody.items.every((item) => item.outcome === "pending")).toBe(true);

    // Replay with the same idempotency key returns the same pending approval.
    const second = await applyMixed(
      app,
      plan.id,
      plan.revision,
      [blockIds.move, blockIds.remove, blockIds.add],
      key
    );
    expect(second.statusCode).toBe(202);
    expect((second.json() as { approvalId: string }).approvalId).toBe(firstBody.approvalId);
    expect(fake.mutations()).toBe(0);
    const pending = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessApprovalPort.findPendingApprovalForOperation(scopedDb, firstBody.operationId)
    );
    expect(pending?.id).toBe(firstBody.approvalId);
    assertWriterOutsideTransactions();
  });

  it("confirms a mixed batch once: one patch, one delete, one create", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    const stagedPlan = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    const placementOf = (id: string) =>
      stagedPlan?.blocks.find((block) => block.id === id)?.actualPlacement?.calendarEventRef;
    const moveRef = placementOf(blockIds.move)!;
    const removeRef = placementOf(blockIds.remove)!;
    expect(moveRef).toMatch(/^jap/);
    expect(removeRef).toMatch(/^jap/);
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);

    const gated = await applyMixed(app, plan.id, plan.revision, [
      blockIds.move,
      blockIds.remove,
      blockIds.add
    ]);
    expect(gated.statusCode).toBe(202);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(confirmed.statusCode).toBe(200);
    const report = confirmed.json() as {
      operationId: string;
      status: string;
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    expect(report.status).toBe("completed");
    const byBlock = new Map(report.items.map((item) => [item.blockId, item]));
    expect(byBlock.get(blockIds.move)).toMatchObject({ outcome: "applied" });
    expect(byBlock.get(blockIds.remove)).toMatchObject({ outcome: "applied" });
    expect(byBlock.get(blockIds.add)).toMatchObject({ outcome: "applied" });
    const storedResults = await storedItems(plan.id, gatedBody.operationId);
    expect(storedResults.get(blockIds.move)?.result).toMatchObject({
      status: "applied",
      providerEventId: moveRef,
      startsAt: T3,
      durationMinutes: 30,
      blockMirror: "mirrored"
    });
    expect(storedResults.get(blockIds.remove)?.result).toMatchObject({
      status: "applied",
      removed: true,
      providerEventId: removeRef,
      blockMirror: "mirrored"
    });

    // One patch, one delete, one create, each preceded by a provenance readback.
    expect(fake.patches).toEqual([moveRef]);
    expect(fake.deletes).toEqual([removeRef]);
    expect(fake.creates).toHaveLength(1);
    expect(fake.lookups).toContain(moveRef);
    expect(fake.lookups).toContain(removeRef);

    // Blocks mirrored at the new truth and the revision advanced.
    const reloaded = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    expect(reloaded!.revision).toBeGreaterThan(plan.revision);
    const blocks = new Map((reloaded?.blocks ?? []).map((block) => [block.id, block]));
    expect(blocks.get(blockIds.move)?.pendingChange).toBeNull();
    expect(blocks.get(blockIds.move)?.actualPlacement).toMatchObject({
      startsAt: T3,
      durationMinutes: 30,
      calendarEventRef: moveRef
    });
    expect(blocks.get(blockIds.remove)?.pendingChange).toBeNull();
    expect(blocks.get(blockIds.remove)?.actualPlacement).toMatchObject({
      startsAt: null,
      durationMinutes: null,
      calendarEventRef: null
    });

    // Status reports the stored truth for every kind.
    const status = await app.inject({
      method: "GET",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}`
    });
    const statusBody = status.json() as { status: string; items: unknown[] };
    expect(statusBody.status).toBe("completed");
    expect(statusBody.items).toHaveLength(3);

    // The approval resolved to confirmed in the existing action store.
    const stored = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessAiRepository.getAssistantAction(scopedDb, gatedBody.approvalId)
    );
    expect(stored?.status).toBe("confirmed");
    assertWriterOutsideTransactions();

    // Confirming again stops at 409 with nothing stored changing.
    const mutations = fake.mutations();
    const lookups = fake.lookups.length;
    const again = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(again.statusCode).toBe(409);
    expect(fake.mutations()).toBe(mutations);
    expect(fake.lookups).toHaveLength(lookups);

    // Retrying an applied item rejects; recovering touches nothing applied.
    const statusItems = statusBody.items as { itemId: string }[];
    const retryApplied = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/retry`,
      payload: { itemIds: [statusItems[0]!.itemId] }
    });
    expect(retryApplied.statusCode).toBe(409);
    const recover = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/recover`,
      payload: {}
    });
    expect(recover.statusCode).toBe(200);
    expect((recover.json() as { status: string }).status).toBe("completed");
    expect(fake.mutations()).toBe(mutations);
    expect(fake.lookups).toHaveLength(lookups);
  });

  it("stops invalid confirmations at 409 with no writes", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);
    const confirmUrl = (operationId: string) =>
      `/api/calendar/day-plans/${plan.id}/operations/${operationId}/confirm`;

    const gated = await applyMixed(app, plan.id, plan.revision, [
      blockIds.move,
      blockIds.remove,
      blockIds.add
    ]);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };

    // Unknown approval id.
    const unknown = await app.inject({
      method: "POST",
      url: confirmUrl(gatedBody.operationId),
      payload: { approvalId: randomUUID() }
    });
    expect(unknown.statusCode).toBe(409);

    // Approval bound to a different operation.
    const foreign = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessApprovalPort.createPendingApproval(scopedDb, {
        inputSummary: {
          tool: "calendar.applyDayPlanChanges",
          actorUserId: ids.userA,
          planId: plan.id,
          operationId: randomUUID(),
          planRevision: plan.revision,
          changes: []
        }
      })
    );
    const wrongOp = await app.inject({
      method: "POST",
      url: confirmUrl(gatedBody.operationId),
      payload: { approvalId: foreign.id }
    });
    expect(wrongOp.statusCode).toBe(409);

    // Altered change set after the approval: retarget the move, then confirm.
    const current = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.saveDraft(scopedDb, {
        planId: plan.id,
        localDay: current!.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: current!.revision,
        blocks: (current?.blocks ?? []).map((block) => ({
          id: block.id,
          taskId: block.taskId,
          kind: block.kind,
          title: block.title,
          pendingChange:
            block.id === blockIds.move
              ? { kind: "move" as const, startsAt: T4, durationMinutes: 30 }
              : (block.pendingChange ?? null)
        }))
      })
    );
    const altered = await app.inject({
      method: "POST",
      url: confirmUrl(gatedBody.operationId),
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(altered.statusCode).toBe(409);
    expect(fake.mutations()).toBe(0);

    // Rejected approvals never execute.
    await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessAiRepository.resolveAssistantAction(scopedDb, gatedBody.approvalId, {
        status: "rejected"
      })
    );
    const rejected = await app.inject({
      method: "POST",
      url: confirmUrl(gatedBody.operationId),
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(rejected.statusCode).toBe(409);
    expect(fake.mutations()).toBe(0);

    // A second actor reads the operation as foreign: 404, nothing changes.
    const foreignActor = await buildApp(userB(), service).inject({
      method: "POST",
      url: confirmUrl(gatedBody.operationId),
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(foreignActor.statusCode).toBe(404);
    expect(fake.mutations()).toBe(0);
    expect(fake.lookups).toHaveLength(0);
    assertWriterOutsideTransactions();
  });

  it("executes from apply on trusted_auto; attendee moves fail under any tier", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessAiRepository.setActionPolicy(
        scopedDb,
        "calendar",
        "calendar_management",
        "trusted_auto"
      )
    );
    try {
      fake.creates = [];
      fake.lookups = [];
      const service = buildService(fake);
      const app = buildApp(userA(), service);

      // Mark the move's event as attended: the writer must refuse it even
      // though the tier allows automatic execution.
      const stagedPlan = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
        harnessRepository.getById(scopedDb, plan.id)
      );
      const moveRef = stagedPlan?.blocks.find((block) => block.id === blockIds.move)
        ?.actualPlacement?.calendarEventRef;
      if (!moveRef) throw new Error("staged move placement is missing");
      fake.events.get(moveRef)!.attendeeCount = 2;

      const response = await applyMixed(app, plan.id, plan.revision, [
        blockIds.move,
        blockIds.remove,
        blockIds.add
      ]);
      expect(response.statusCode).toBe(200);
      const report = response.json() as {
        status: string;
        operationId: string;
        items: {
          blockId: string | null;
          outcome: string;
          result: Record<string, unknown> | null;
        }[];
      };
      expect(report.status).toBe("completed");
      const byBlock = new Map(report.items.map((item) => [item.blockId, item]));
      expect(byBlock.get(blockIds.move)).toMatchObject({ outcome: "failed" });
      expect(
        (await storedItems(plan.id, report.operationId)).get(blockIds.move)?.result
      ).toMatchObject({
        status: "failed",
        reason: "has-attendees",
        providerEventId: moveRef
      });
      expect(byBlock.get(blockIds.remove)).toMatchObject({ outcome: "applied" });
      expect(byBlock.get(blockIds.add)).toMatchObject({ outcome: "applied" });
      // No patch for the attended event, no approval row either.
      expect(fake.patches).toHaveLength(0);
      const pending = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
        harnessApprovalPort.findPendingApprovalForOperation(scopedDb, report.operationId)
      );
      expect(pending).toBeUndefined();
      assertWriterOutsideTransactions();
    } finally {
      await harnessDataContext.withDataContext(userA(), (scopedDb) =>
        harnessAiRepository.setActionPolicy(
          scopedDb,
          "calendar",
          "calendar_management",
          "always_confirm"
        )
      );
    }
  });

  it("fails every provenance gap with no provider mutation", async () => {
    const fake = makeChangeWriterFake();
    const created = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.createForDay(scopedDb, { localDay: nextChangeDay(), timeZone: TIME_ZONE })
    );
    // Stage two applied blocks, then a third block that was never applied.
    const drafted = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.saveDraft(scopedDb, {
        planId: created.id,
        localDay: created.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: created.revision,
        blocks: [
          {
            taskId: null,
            kind: "focus",
            title: "No provenance",
            pendingChange: { kind: "add", startsAt: T0, durationMinutes: 30 }
          },
          {
            taskId: null,
            kind: "focus",
            title: "Wrong owner",
            pendingChange: { kind: "add", startsAt: T1, durationMinutes: 30 }
          }
        ]
      })
    );
    const staging = buildQuietService(fake);
    const reserved = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.reserveApplyBatch(scopedDb, {
        planId: drafted.id,
        expectedRevision: drafted.revision,
        idempotencyKey: `prov-stage-${randomUUID()}`
      })
    );
    await staging.executeReservedAdditions({
      access: userA(),
      toolCtx: toolCtx(),
      planId: drafted.id,
      idempotencyKey: reserved.idempotencyKey
    });
    const applied = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, drafted.id)
    );
    const refOf = (title: string) => {
      const ref = applied?.blocks.find((block) => block.title === title)?.actualPlacement
        ?.calendarEventRef;
      if (!ref) throw new Error(`staged placement is missing for ${title}`);
      return ref;
    };
    // One event loses its provenance, another gains someone else's.
    fake.events.get(refOf("No provenance"))!.provenance = {};
    fake.events.get(refOf("Wrong owner"))!.provenance = {
      jarvisTool: "applyAddition",
      jarvisActorUserId: ids.userB,
      jarvisPlanId: applied!.id,
      jarvisBlockId: "some-other-block",
      jarvisPlanRevision: "1",
      jarvisOperationId: "op-other"
    };
    const changed = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.saveDraft(scopedDb, {
        planId: drafted.id,
        localDay: created.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: applied!.revision,
        blocks: [
          {
            id: applied!.blocks.find((block) => block.title === "No provenance")!.id,
            taskId: null,
            kind: "focus",
            title: "No provenance",
            pendingChange: { kind: "move", startsAt: T3, durationMinutes: 30 }
          },
          {
            id: applied!.blocks.find((block) => block.title === "Wrong owner")!.id,
            taskId: null,
            kind: "focus",
            title: "Wrong owner",
            pendingChange: { kind: "remove" }
          },
          {
            taskId: null,
            kind: "focus",
            title: "Never applied",
            pendingChange: { kind: "move", startsAt: T4, durationMinutes: 30 }
          }
        ]
      })
    );
    const idsByTitle = new Map(changed.blocks.map((block) => [block.title, block.id]));
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);

    const gated = await applyMixed(app, changed.id, changed.revision, [
      idsByTitle.get("No provenance")!,
      idsByTitle.get("Wrong owner")!,
      idsByTitle.get("Never applied")!
    ]);
    expect(gated.statusCode).toBe(202);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${changed.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(confirmed.statusCode).toBe(200);
    const report = confirmed.json() as {
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    for (const item of report.items) {
      expect(item.outcome).toBe("failed");
    }
    // Real HTTP serialization boundary: the failure reason must survive
    // Fastify response serialization, not just the stored row.
    for (const item of report.items) {
      expect(item.result).toMatchObject({
        status: "failed",
        reason: "provenance-mismatch"
      });
    }
    const storedProv = await storedItems(changed.id, gatedBody.operationId);
    expect(storedProv.size).toBe(3);
    for (const storedItem of storedProv.values()) {
      expect(storedItem.result).toMatchObject({
        status: "failed",
        reason: "provenance-mismatch"
      });
    }
    // Reads happened, mutations never did.
    expect(fake.mutations()).toBe(0);
    expect(fake.lookups).toHaveLength(2);
    assertWriterOutsideTransactions();
  });

  it("rechecks moves per item, adopts settled states, and recovers ambiguity", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    const stagedPlan = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    const moveRef = placementRefOf(stagedPlan, blockIds.move);
    const removeRef = placementRefOf(stagedPlan, blockIds.remove);
    // The move's own event shows up busy at the target: self-exclusion lets
    // it through, while another overlapping event blocks nothing here.
    stageBusyInterval({
      start: T3,
      end: "2026-09-12T20:30:00.000Z",
      title: "Planned block",
      accountLabel: "test",
      eventKey: moveRef
    });
    // The removal is already gone at the provider but still cached here.
    fake.alreadyGone.add(removeRef);
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);

    const gated = await applyMixed(app, plan.id, plan.revision, [
      blockIds.move,
      blockIds.remove,
      blockIds.add
    ]);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    expect(confirmed.statusCode).toBe(200);
    const report = confirmed.json() as {
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    const byBlock = new Map(report.items.map((item) => [item.blockId, item]));
    expect(byBlock.get(blockIds.move)).toMatchObject({ outcome: "applied" });
    expect(byBlock.get(blockIds.remove)).toMatchObject({ outcome: "applied" });
    expect(
      (await storedItems(plan.id, gatedBody.operationId)).get(blockIds.remove)?.result
    ).toMatchObject({ removed: true });
    expect(fake.patches).toEqual([moveRef]);
    expect(fake.deletes).toEqual([removeRef]);
    assertWriterOutsideTransactions();

    // A conflicting stranger at the move target fails only that item.
    const fake2 = makeChangeWriterFake();
    const staged2 = await seedChangePlan(nextChangeDay(), fake2);
    const plan2 = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, staged2.plan.id)
    );
    const moveRef2 = placementRefOf(plan2, staged2.ids.move);
    stageBusyInterval({
      start: T3,
      end: "2026-09-12T20:30:00.000Z",
      title: "Standup",
      accountLabel: "work",
      eventKey: "evt-stranger"
    });
    fake2.creates = [];
    const service2 = buildService(fake2);
    const app2 = buildApp(userA(), service2);
    const gated2 = await applyMixed(app2, staged2.plan.id, staged2.plan.revision, [
      staged2.ids.move,
      staged2.ids.remove,
      staged2.ids.add
    ]);
    const gatedBody2 = gated2.json() as { operationId: string; approvalId: string };
    const confirmed2 = await app2.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${staged2.plan.id}/operations/${gatedBody2.operationId}/confirm`,
      payload: { approvalId: gatedBody2.approvalId }
    });
    const report2 = confirmed2.json() as {
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    const byBlock2 = new Map(report2.items.map((item) => [item.blockId, item]));
    expect(byBlock2.get(staged2.ids.move)).toMatchObject({ outcome: "failed" });
    expect(
      (await storedItems(staged2.plan.id, gatedBody2.operationId)).get(staged2.ids.move)?.result
    ).toMatchObject({
      status: "failed",
      reason: "conflict",
      providerEventId: moveRef2
    });
    expect(byBlock2.get(staged2.ids.remove)).toMatchObject({ outcome: "applied" });
    expect(fake2.patches).toHaveLength(0);
    assertWriterOutsideTransactions();

    // A patch that throws records unknown; once the provider state shows the
    // delete landed, recover adopts it without a second mutation.
    const fake3 = makeChangeWriterFake();
    const staged3 = await seedChangePlan(nextChangeDay(), fake3);
    const plan3 = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, staged3.plan.id)
    );
    const removeRef3 = placementRefOf(plan3, staged3.ids.remove);
    fake3.throwOnMutate.add(removeRef3);
    fake3.creates = [];
    const service3 = buildService(fake3);
    const app3 = buildApp(userA(), service3);
    const gated3 = await applyMixed(app3, staged3.plan.id, staged3.plan.revision, [
      staged3.ids.move,
      staged3.ids.remove,
      staged3.ids.add
    ]);
    const gatedBody3 = gated3.json() as { operationId: string; approvalId: string };
    const confirmed3 = await app3.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${staged3.plan.id}/operations/${gatedBody3.operationId}/confirm`,
      payload: { approvalId: gatedBody3.approvalId }
    });
    const report3 = confirmed3.json() as {
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    const byBlock3 = new Map(report3.items.map((item) => [item.blockId, item]));
    expect(byBlock3.get(staged3.ids.remove)).toMatchObject({ outcome: "unknown" });
    expect(
      (await storedItems(staged3.plan.id, gatedBody3.operationId)).get(staged3.ids.remove)?.result
    ).toMatchObject({
      status: "unknown",
      providerEventId: removeRef3
    });
    // The delete actually landed but the response was lost.
    fake3.events.delete(removeRef3);
    fake3.throwOnMutate.delete(removeRef3);
    const deletesBefore = fake3.deletes.length;
    const recovered = await app3.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${staged3.plan.id}/operations/${gatedBody3.operationId}/recover`,
      payload: {}
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredReport = recovered.json() as {
      status: string;
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    const recoveredByBlock = new Map(recoveredReport.items.map((item) => [item.blockId, item]));
    expect(recoveredByBlock.get(staged3.ids.remove)).toMatchObject({ outcome: "applied" });
    expect(
      (await storedItems(staged3.plan.id, gatedBody3.operationId)).get(staged3.ids.remove)?.result
    ).toMatchObject({ removed: true });
    expect(fake3.deletes).toHaveLength(deletesBefore);
    assertWriterOutsideTransactions();
  });

  it("recovers the remaining move after the removal applied", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    const stagedPlan = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    const moveRef = placementRefOf(stagedPlan, blockIds.move);
    // Only the move fails: its patch throws, so it records unknown while
    // the removal and the addition apply around it.
    fake.throwOnMutate.add(moveRef);
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);

    const gated = await applyMixed(app, plan.id, plan.revision, [
      blockIds.move,
      blockIds.remove,
      blockIds.add
    ]);
    expect(gated.statusCode).toBe(202);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    const report = confirmed.json() as {
      items: { blockId: string | null; outcome: string }[];
    };
    const byBlock = new Map(report.items.map((item) => [item.blockId, item]));
    expect(byBlock.get(blockIds.remove)).toMatchObject({ outcome: "applied" });
    expect(byBlock.get(blockIds.move)).toMatchObject({ outcome: "unknown" });

    // The patch actually landed but the response was lost; the move sits at
    // its target when recovery reads it back.
    fake.events.get(moveRef)!.start = T3;
    fake.events.get(moveRef)!.end = "2026-09-12T20:30:00.000Z";
    fake.throwOnMutate.delete(moveRef);
    const patchesBefore = fake.patches.length;
    const recovered = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/recover`,
      payload: {}
    });
    expect(recovered.statusCode).toBe(200);
    const recoveredReport = recovered.json() as {
      status: string;
      items: { blockId: string | null; outcome: string }[];
    };
    expect(recoveredReport.status).toBe("completed");
    const recoveredByBlock = new Map(recoveredReport.items.map((item) => [item.blockId, item]));
    // The confirmed approval is reused: the settled removal is skipped, the
    // move is adopted with no second patch.
    expect(recoveredByBlock.get(blockIds.move)).toMatchObject({ outcome: "applied" });
    expect(recoveredByBlock.get(blockIds.remove)).toMatchObject({ outcome: "applied" });
    expect(fake.patches).toHaveLength(patchesBefore);
    expect(
      (await storedItems(plan.id, gatedBody.operationId)).get(blockIds.remove)?.result
    ).toMatchObject({ removed: true });
    assertWriterOutsideTransactions();
  });

  it("adopts a move already at its target with no patch", async () => {
    const fake = makeChangeWriterFake();
    const { plan, ids: blockIds } = await seedChangePlan(nextChangeDay(), fake);
    // Retarget the move onto the window it already occupies.
    const current = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    const moveBlock = current?.blocks.find((block) => block.id === blockIds.move);
    if (!moveBlock) throw new Error("staged move block is missing");
    await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.saveDraft(scopedDb, {
        planId: plan.id,
        localDay: current!.localDay,
        timeZone: TIME_ZONE,
        expectedRevision: current!.revision,
        blocks: (current?.blocks ?? []).map((block) => ({
          id: block.id,
          taskId: block.taskId,
          kind: block.kind,
          title: block.title,
          pendingChange:
            block.id === blockIds.move
              ? {
                  kind: "move" as const,
                  startsAt: moveBlock.actualPlacement!.startsAt!,
                  durationMinutes: moveBlock.actualPlacement!.durationMinutes!
                }
              : (block.pendingChange ?? null)
        }))
      })
    );
    const redrafted = await harnessDataContext.withDataContext(userA(), (scopedDb) =>
      harnessRepository.getById(scopedDb, plan.id)
    );
    fake.creates = [];
    fake.lookups = [];
    const service = buildService(fake);
    const app = buildApp(userA(), service);
    const gated = await applyMixed(app, plan.id, redrafted!.revision, [blockIds.move]);
    expect(gated.statusCode).toBe(202);
    const gatedBody = gated.json() as { operationId: string; approvalId: string };
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/calendar/day-plans/${plan.id}/operations/${gatedBody.operationId}/confirm`,
      payload: { approvalId: gatedBody.approvalId }
    });
    const report = confirmed.json() as {
      items: { blockId: string | null; outcome: string; result: Record<string, unknown> | null }[];
    };
    // The pending addition rides along with the explicit move selection.
    expect(report.items).toHaveLength(2);
    const adopted = report.items.find((item) => item.blockId === blockIds.move);
    expect(adopted).toMatchObject({ outcome: "applied" });
    expect(
      (await storedItems(plan.id, gatedBody.operationId)).get(blockIds.move)?.result
    ).toMatchObject({
      status: "applied",
      calendarMirror: "not-checked",
      blockMirror: "mirrored"
    });
    expect(fake.patches).toHaveLength(0);
    assertWriterOutsideTransactions();
  });
});
