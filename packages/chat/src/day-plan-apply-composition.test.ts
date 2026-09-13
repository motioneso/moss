import { describe, expect, it } from "vitest";

import { DayPlanRepository } from "@moss/calendar";
import { ConnectorsRepository } from "@moss/connectors";

import { buildDayPlanApplyComposition } from "./module-registry/day-plan-apply-composition.js";

function stubDataContext() {
  return {
    withDataContext: (async () => {
      throw new Error("db-down");
    }) as never
  };
}

describe("day plan apply composition", () => {
  it("returns only the shared repository without a connector runtime", () => {
    const composition = buildDayPlanApplyComposition({ dataContext: stubDataContext() });
    expect(composition.dayPlanRepository).toBeInstanceOf(DayPlanRepository);
    expect(composition.applyExecution).toBeUndefined();
  });

  it("returns no callback when only Google services are present", () => {
    const composition = buildDayPlanApplyComposition({
      dataContext: stubDataContext(),
      googleApiClient: undefined,
      googleConnectionService: undefined
    });
    expect(composition.applyExecution).toBeUndefined();
  });

  it("builds an executor that reaches the service before provider work", async () => {
    const composition = buildDayPlanApplyComposition({
      dataContext: stubDataContext(),
      connectorsRepository: new ConnectorsRepository()
    });
    expect(composition.applyExecution).toBeDefined();
    // The service opens its snapshot transaction first, so a dead database
    // fails before any Google service is touched.
    await expect(
      composition.applyExecution!({
        access: { actorUserId: "00000000-0000-4000-8000-000000000001" },
        toolCtx: { actorUserId: "00000000-0000-4000-8000-000000000001", chatSessionId: "s" },
        planId: "00000000-0000-4000-8000-000000000010",
        idempotencyKey: "key"
      } as never)
    ).rejects.toThrow("db-down");
  });
});
