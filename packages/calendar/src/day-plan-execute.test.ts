import { describe, expect, it } from "vitest";

import type { ApplyEventProvenance } from "@moss/shared";

import { applyAdditionEventId, applyProvenanceMatches } from "./day-plan-execute.js";

const PROVENANCE: ApplyEventProvenance = {
  actorUserId: "actor-1",
  planId: "plan-1",
  blockId: "block-1",
  planRevision: 2,
  operationId: "op-1"
};

describe("apply addition identity", () => {
  it("derives a stable provider-shaped id", () => {
    const first = applyAdditionEventId(PROVENANCE);
    expect(applyAdditionEventId({ ...PROVENANCE })).toBe(first);
    expect(first).toMatch(/^jap[0-9a-v]{32}$/);
  });

  it("separates identities by every reference", () => {
    const base = applyAdditionEventId(PROVENANCE);
    expect(applyAdditionEventId({ ...PROVENANCE, blockId: "block-2" })).not.toBe(base);
    expect(applyAdditionEventId({ ...PROVENANCE, planRevision: 3 })).not.toBe(base);
    expect(applyAdditionEventId({ ...PROVENANCE, operationId: "op-2" })).not.toBe(base);
    expect(applyAdditionEventId({ ...PROVENANCE, actorUserId: "actor-2" })).not.toBe(base);
  });

  it("matches only the exact recorded metadata", () => {
    const recorded = {
      jarvisTool: "applyAddition",
      jarvisActorUserId: "actor-1",
      jarvisPlanId: "plan-1",
      jarvisBlockId: "block-1",
      jarvisPlanRevision: "2",
      jarvisOperationId: "op-1"
    };
    expect(applyProvenanceMatches(recorded, PROVENANCE)).toBe(true);
    expect(applyProvenanceMatches({ ...recorded, jarvisTool: "createEvent" }, PROVENANCE)).toBe(
      false
    );
    expect(applyProvenanceMatches({ ...recorded, jarvisBlockId: "block-9" }, PROVENANCE)).toBe(
      false
    );
    expect(applyProvenanceMatches({}, PROVENANCE)).toBe(false);
  });
});
