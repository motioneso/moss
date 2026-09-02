import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway, ConfirmationRegistry, SessionTokenRegistry } from "@moss/ai";

interface FixtureRow {
  id: string;
  ownerUserId: string;
  status: "pending" | "confirmed" | "rejected" | "cancelled";
}

interface ScopedDbStub {
  actorUserId: string;
}

// Mimics RLS: getAssistantAction/resolveAssistantAction only "see" the row when the scoped DB
// (derived from the AccessContext passed to withDataContext) carries the owning actor.
function createGateway(row: FixtureRow) {
  const getAssistantAction = vi.fn(async (scopedDb: ScopedDbStub, actionId: string) => {
    if (actionId !== row.id || scopedDb.actorUserId !== row.ownerUserId) return undefined;
    return { ...row };
  });
  const resolveAssistantAction = vi.fn(
    async (scopedDb: ScopedDbStub, actionId: string, input: { status: string }) => {
      if (actionId !== row.id || scopedDb.actorUserId !== row.ownerUserId) return undefined;
      if (row.status !== "pending") return undefined;
      row.status = input.status as FixtureRow["status"];
      return { ...row };
    }
  );
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    repository: { getAssistantAction, resolveAssistantAction } as never,
    runner: {
      withDataContext: async (
        access: { actorUserId: string },
        work: (db: ScopedDbStub) => Promise<unknown>
      ) => work({ actorUserId: access.actorUserId })
    } as never,
    tokens: new SessionTokenRegistry(),
    confirmations,
    notifier: { emit: () => undefined },
    confirmTimeoutMs: 5
  });
  return { gateway, confirmations, getAssistantAction, resolveAssistantAction, row };
}

describe("resolveActionRequest owner scope (#1591)", () => {
  it("non-owner confirm is identical whether or not a live waiter exists", async () => {
    const { gateway, confirmations, getAssistantAction, resolveAssistantAction, row } =
      createGateway({
        id: "action-1",
        ownerUserId: "owner-1",
        status: "pending"
      });
    const resolveSpy = vi.spyOn(confirmations, "resolve");

    // (a) no waiter registered for this action at all.
    await expect(gateway.resolveActionRequest("attacker-2", row.id, "confirmed")).resolves.toBe(
      "not_found"
    );
    expect(getAssistantAction).toHaveBeenCalledTimes(1);
    expect(resolveAssistantAction).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();

    // (b) a live waiter exists for this action (e.g. the real owner is mid-confirm elsewhere).
    const pending = confirmations.awaitResolution(row.id, 10_000);
    try {
      await expect(gateway.resolveActionRequest("attacker-2", row.id, "confirmed")).resolves.toBe(
        "not_found"
      );
      expect(getAssistantAction).toHaveBeenCalledTimes(2);
      expect(resolveAssistantAction).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      confirmations.resolve(row.id, "cancelled");
      await pending;
    }
  });

  it("owner confirm still distinguishes real liveness (#1256 regression guard)", async () => {
    const { gateway, confirmations, resolveAssistantAction, row } = createGateway({
      id: "action-2",
      ownerUserId: "owner-1",
      status: "pending"
    });

    // No live waiter: falls through to the fail-closed timeout guard, row stays pending.
    await expect(gateway.resolveActionRequest("owner-1", row.id, "confirmed")).resolves.toBe(
      "expired"
    );
    expect(row.status).toBe("pending");
    expect(resolveAssistantAction).not.toHaveBeenCalled();

    // Live waiter: resolves for real, row transitions, resolveAssistantAction runs once.
    const pending = confirmations.awaitResolution(row.id, 10_000);
    const resolution = gateway.resolveActionRequest("owner-1", row.id, "confirmed");
    await expect(pending).resolves.toBe("confirmed");
    confirmations.markDone(row.id);
    await expect(resolution).resolves.toBe("resolved");
    expect(row.status).toBe("confirmed");
    expect(resolveAssistantAction).toHaveBeenCalledOnce();
  });
});
