import { describe, expect, it, vi } from "vitest";
import type { RpcConnection } from "@moss/chat";
import { createConstrainedCliReadinessProbe } from "@moss/module-registry";

function connection() {
  return { probeProvider: vi.fn<RpcConnection["probeProvider"]>() };
}

describe("shared constrained CLI readiness", () => {
  it("resolves late-bound API connections per call without retaining an absent or stale connection", async () => {
    let current: ReturnType<typeof connection> | undefined;
    const probe = createConstrainedCliReadinessProbe(() => current);
    await expect(probe("owner")).resolves.toBe("model-unavailable");
    current = connection();
    current.probeProvider.mockResolvedValue({ status: "ready" });
    await expect(probe("owner")).resolves.toBe("available");
    const previous = current;
    current = connection();
    current.probeProvider.mockResolvedValue({ status: "not_installed" });
    await expect(probe("owner")).resolves.toBe("model-unavailable");
    expect(previous.probeProvider).toHaveBeenCalledOnce();
    expect(current.probeProvider).toHaveBeenCalledOnce();
  });

  it.each([
    ["ready", "available"],
    ["needs_login", "model-unavailable"],
    ["not_installed", "model-unavailable"],
    ["multiplexer_unavailable", "model-unavailable"],
    ["error", "model-unavailable"]
  ] as const)(
    "maps %s while preserving the actor, deadline and signal",
    async (status, expected) => {
      const rpc = connection();
      rpc.probeProvider.mockResolvedValue({ status });
      const signal = new AbortController().signal;
      const probe = createConstrainedCliReadinessProbe(() => rpc);
      await expect(probe("owner", signal)).resolves.toBe(expected);
      expect(rpc.probeProvider).toHaveBeenCalledExactlyOnceWith(
        { provider: "anthropic", constrainedStructured: true },
        "owner",
        { timeoutMs: 5_000, signal }
      );
    }
  );

  it("prioritizes the isolation restriction even when the provider reports ready", async () => {
    const rpc = connection();
    rpc.probeProvider.mockResolvedValue({
      status: "ready",
      constrainedUnavailableReason: "per_user_isolation_required"
    });
    await expect(createConstrainedCliReadinessProbe(() => rpc)("owner")).resolves.toBe(
      "subscription-isolation-unavailable"
    );
  });

  it("propagates cancellation and RPC failures without treating either as readiness", async () => {
    const rpc = connection();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const failure = new Error("RPC unavailable");
    rpc.probeProvider
      .mockRejectedValueOnce(controller.signal.reason)
      .mockRejectedValueOnce(failure);
    const probe = createConstrainedCliReadinessProbe(() => rpc);
    await expect(probe("owner", controller.signal)).rejects.toBe(controller.signal.reason);
    await expect(probe("owner")).rejects.toBe(failure);
  });
});
