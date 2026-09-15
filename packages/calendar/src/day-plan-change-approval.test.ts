import { describe, expect, it } from "vitest";

import type { DayPlanApplyBatchDto, DayPlanDto } from "@moss/shared";

import type { ApplyChangeAuth } from "./day-plan-change-approval.js";
import {
  applyBlockProvenanceMatches,
  batchHasChanges,
  buildChangeBinding,
  buildLiveChangeBinding,
  buildOperationChangeSet,
  changeApprovalSummary,
  changeBindingsEqual,
  changeTierRequiresConfirmation,
  checkChangeGate,
  readChangeBinding,
  resolveChangeTier
} from "./day-plan-change-approval.js";

const ACTOR = "actor-1";
const PLAN_ID = "plan-1";
const OPERATION_ID = "op-1";
const BLOCK_MOVE = "block-move";
const BLOCK_REMOVE = "block-remove";
const BLOCK_ADD = "block-add";
const MOVE_REF = "jap-move-1";
const REMOVE_REF = "jap-remove-1";

function planFixture(): DayPlanDto {
  return {
    id: PLAN_ID,
    revision: 4,
    blocks: [
      {
        id: BLOCK_MOVE,
        taskId: null,
        title: "Move me",
        actualPlacement: {
          startsAt: "2026-09-12T16:00:00.000Z",
          durationMinutes: 30,
          calendarEventRef: MOVE_REF
        },
        pendingChange: {
          kind: "move",
          startsAt: "2026-09-12T18:00:00.000Z",
          durationMinutes: 30
        }
      },
      {
        id: BLOCK_REMOVE,
        taskId: null,
        title: "Remove me",
        actualPlacement: {
          startsAt: "2026-09-12T19:00:00.000Z",
          durationMinutes: 30,
          calendarEventRef: REMOVE_REF
        },
        pendingChange: { kind: "remove" }
      },
      {
        id: BLOCK_ADD,
        taskId: null,
        title: "Add me",
        actualPlacement: null,
        pendingChange: { kind: "add", startsAt: "2026-09-12T20:00:00.000Z", durationMinutes: 30 }
      }
    ]
  } as unknown as DayPlanDto;
}

function batchFixture(): DayPlanApplyBatchDto {
  return {
    id: OPERATION_ID,
    planId: PLAN_ID,
    idempotencyKey: "k1",
    operationKey: null,
    expectedRevision: 4,
    outcome: "pending",
    selection: [],
    items: [
      {
        id: "item-move",
        blockId: BLOCK_MOVE,
        kind: "move",
        pendingChange: {
          blockId: BLOCK_MOVE,
          kind: "move",
          startsAt: "2026-09-12T18:00:00.000Z",
          durationMinutes: 30
        },
        outcome: "pending",
        result: null
      },
      {
        id: "item-remove",
        blockId: BLOCK_REMOVE,
        kind: "remove",
        pendingChange: {
          blockId: BLOCK_REMOVE,
          kind: "remove",
          startsAt: null,
          durationMinutes: null
        },
        outcome: "pending",
        result: null
      },
      {
        id: "item-add",
        blockId: BLOCK_ADD,
        kind: "add",
        pendingChange: {
          blockId: BLOCK_ADD,
          kind: "add",
          startsAt: "2026-09-12T20:00:00.000Z",
          durationMinutes: 30
        },
        outcome: "pending",
        result: null
      }
    ]
  };
}

describe("change binding", () => {
  it("binds actor, plan, operation, revision and the full change set", () => {
    const binding = buildChangeBinding({
      actorUserId: ACTOR,
      batch: batchFixture(),
      plan: planFixture()
    });
    expect(binding).toEqual({
      actorUserId: ACTOR,
      planId: PLAN_ID,
      operationId: OPERATION_ID,
      planRevision: 4,
      changes: [
        {
          blockId: BLOCK_MOVE,
          kind: "move",
          calendarEventRef: MOVE_REF,
          startsAt: "2026-09-12T18:00:00.000Z",
          durationMinutes: 30
        },
        {
          blockId: BLOCK_REMOVE,
          kind: "remove",
          calendarEventRef: REMOVE_REF,
          startsAt: null,
          durationMinutes: null
        },
        {
          blockId: BLOCK_ADD,
          kind: "add",
          calendarEventRef: null,
          startsAt: "2026-09-12T20:00:00.000Z",
          durationMinutes: 30
        }
      ]
    });
  });

  it("needs every entry to match exactly", () => {
    const binding = buildChangeBinding({
      actorUserId: ACTOR,
      batch: batchFixture(),
      plan: planFixture()
    });
    expect(changeBindingsEqual(binding, structuredClone(binding))).toBe(true);
    const wrongRef = structuredClone(binding);
    wrongRef.changes[0]!.calendarEventRef = "jap-other";
    expect(changeBindingsEqual(binding, wrongRef)).toBe(false);
    const wrongRevision = { ...structuredClone(binding), planRevision: 5 };
    expect(changeBindingsEqual(binding, wrongRevision)).toBe(false);
    const wrongActor = { ...structuredClone(binding), actorUserId: "actor-2" };
    expect(changeBindingsEqual(binding, wrongActor)).toBe(false);
    const reordered = {
      ...structuredClone(binding),
      changes: [binding.changes[1]!, binding.changes[0]!, binding.changes[2]!]
    };
    expect(changeBindingsEqual(binding, reordered)).toBe(false);
  });

  it("round-trips through the stored summary and rejects foreign rows", () => {
    const binding = buildChangeBinding({
      actorUserId: ACTOR,
      batch: batchFixture(),
      plan: planFixture()
    });
    const summary = changeApprovalSummary(binding);
    expect(readChangeBinding(summary)).toEqual(binding);
    expect(readChangeBinding({ tool: "gateway.somethingElse" })).toBeNull();
    expect(readChangeBinding(null)).toBeNull();
    const tampered = structuredClone(summary) as Record<string, unknown>;
    (tampered.changes as Record<string, unknown>[])[0]!["startsAt"] = "2026-09-12T21:00:00.000Z";
    expect(readChangeBinding(tampered)).not.toEqual(binding);
  });

  it("detects draft drift for the confirm entry", () => {
    const batch = batchFixture();
    const plan = planFixture();
    const frozen = buildChangeBinding({ actorUserId: ACTOR, batch, plan });
    expect(buildLiveChangeBinding({ actorUserId: ACTOR, batch, plan })).toEqual(frozen);
    const drifted = structuredClone(plan);
    drifted.blocks[0]!.pendingChange = {
      kind: "move",
      startsAt: "2026-09-12T21:00:00.000Z",
      durationMinutes: 30
    };
    expect(buildLiveChangeBinding({ actorUserId: ACTOR, batch, plan: drifted })).toBeNull();
  });

  it("detects batches holding moves or removals", () => {
    expect(batchHasChanges(batchFixture())).toBe(true);
    const addsOnly = batchFixture();
    addsOnly.items = addsOnly.items.filter((item) => item.kind === "add");
    expect(batchHasChanges(addsOnly)).toBe(false);
  });

  it("reads a null reference for a move whose block was never applied", () => {
    const plan = planFixture();
    const block = plan.blocks.find((entry) => entry.id === BLOCK_MOVE)!;
    (block as { actualPlacement: unknown }).actualPlacement = null;
    const changes = buildOperationChangeSet(batchFixture(), plan);
    expect(changes[0]!.calendarEventRef).toBeNull();
  });
});

describe("change tier", () => {
  it("confirms on every tier except trusted_auto", () => {
    expect(changeTierRequiresConfirmation("always_confirm")).toBe(true);
    expect(changeTierRequiresConfirmation("ask_each_time")).toBe(true);
    expect(changeTierRequiresConfirmation("trusted_auto")).toBe(false);
  });

  it("reads calendar_management and falls back to the manifest default", () => {
    expect(
      resolveChangeTier([
        { moduleId: "calendar", actionFamilyId: "calendar_management", tier: "trusted_auto" }
      ])
    ).toBe("trusted_auto");
    expect(
      resolveChangeTier([
        { moduleId: "calendar", actionFamilyId: "calendar_writeback", tier: "trusted_auto" }
      ])
    ).toBe("always_confirm");
    expect(resolveChangeTier([])).toBe("always_confirm");
  });

  it("lets additions through and gates moves and removals", () => {
    const batch = batchFixture();
    const binding = buildChangeBinding({ actorUserId: ACTOR, batch, plan: planFixture() });
    const gate = (
      executingItemIds: readonly string[],
      auth: ApplyChangeAuth | undefined,
      current = binding
    ) => checkChangeGate({ batch, executingItemIds, binding: current, auth });
    expect(gate(["item-add"], undefined)).toEqual({ ok: true });
    expect(gate(["item-add", "item-move"], undefined).ok).toBe(false);
    expect(gate(["item-remove"], { tier: "trusted_auto", approval: null })).toEqual({ ok: true });
    expect(
      gate(["item-move"], { tier: "always_confirm", approval: structuredClone(binding) })
    ).toEqual({ ok: true });
    expect(gate(["item-move"], { tier: "always_confirm", approval: null }).ok).toBe(false);
  });

  it("compares only executing items, so settled mirrors never block recovery", () => {
    const batch = batchFixture();
    const approval = buildChangeBinding({ actorUserId: ACTOR, batch, plan: planFixture() });
    // The removal applied and cleared its stored reference; the move is
    // still unknown and about to execute.
    const driftedPlan = planFixture();
    const removed = driftedPlan.blocks.find((block) => block.id === BLOCK_REMOVE)!;
    (removed as { actualPlacement: unknown }).actualPlacement = null;
    removed.pendingChange = null as never;
    const current = buildChangeBinding({ actorUserId: ACTOR, batch, plan: driftedPlan });
    const auth = { tier: "always_confirm", approval };
    // Recovering the move passes: the settled removal is skipped, never trusted.
    expect(
      checkChangeGate({ batch, executingItemIds: ["item-move"], binding: current, auth })
    ).toEqual({ ok: true });
    // An executing entry that differs from the approval still denies.
    const tampered = structuredClone(approval);
    tampered.changes[0]!.calendarEventRef = "jap-other";
    expect(
      checkChangeGate({
        batch,
        executingItemIds: ["item-move"],
        binding: current,
        auth: { tier: "always_confirm", approval: tampered }
      }).ok
    ).toBe(false);
  });
});

describe("block provenance", () => {
  it("matches actor, plan and block across revisions and operations", () => {
    const recorded = {
      jarvisTool: "applyAddition",
      jarvisActorUserId: ACTOR,
      jarvisPlanId: PLAN_ID,
      jarvisBlockId: BLOCK_MOVE,
      jarvisPlanRevision: "2",
      jarvisOperationId: "op-0"
    };
    expect(
      applyBlockProvenanceMatches(recorded, {
        actorUserId: ACTOR,
        planId: PLAN_ID,
        blockId: BLOCK_MOVE
      })
    ).toBe(true);
    expect(
      applyBlockProvenanceMatches(recorded, {
        actorUserId: ACTOR,
        planId: PLAN_ID,
        blockId: BLOCK_REMOVE
      })
    ).toBe(false);
    expect(
      applyBlockProvenanceMatches(
        { ...recorded, jarvisActorUserId: "actor-2" },
        { actorUserId: ACTOR, planId: PLAN_ID, blockId: BLOCK_MOVE }
      )
    ).toBe(false);
    expect(
      applyBlockProvenanceMatches(
        { ...recorded, jarvisTool: "createEvent" },
        { actorUserId: ACTOR, planId: PLAN_ID, blockId: BLOCK_MOVE }
      )
    ).toBe(false);
    expect(
      applyBlockProvenanceMatches({}, { actorUserId: ACTOR, planId: PLAN_ID, blockId: BLOCK_MOVE })
    ).toBe(false);
  });
});
