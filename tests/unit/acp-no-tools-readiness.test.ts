import { describe, expect, it, vi } from "vitest";
import { createAcpNoToolsReadinessProbe } from "../../packages/module-registry/src/acp-no-tools-readiness.js";

const ready = { assertReady: () => undefined };
const down = {
  assertReady: () => {
    throw new Error("cli-runner is not ready for dispatch");
  }
};

describe("ACP no-tools readiness probe", () => {
  it("reports available only when the runner is ready and the row serves the profile", async () => {
    await expect(createAcpNoToolsReadinessProbe(() => ready)("user-1")).resolves.toBe("available");
  });

  it("reports the runner offline when it is down", async () => {
    await expect(createAcpNoToolsReadinessProbe(() => down)("user-1")).resolves.toBe(
      "runner-offline"
    );
  });

  it("reports the runner offline when there is no runner connection", async () => {
    await expect(createAcpNoToolsReadinessProbe(() => undefined)("user-1")).resolves.toBe(
      "runner-offline"
    );
  });

  it("does not consult sign-in state, so a signed-out helper still reads as available", async () => {
    const probeProvider = vi.fn(async () => ({ status: "needs_login" as const }));
    await expect(
      createAcpNoToolsReadinessProbe(() => ({ ...ready, probeProvider }) as never)("user-1")
    ).resolves.toBe("available");
    expect(probeProvider).not.toHaveBeenCalled();
  });

  it("connects an idle runner connection before judging it", async () => {
    let connected = false;
    const idle = {
      ensureConnected: async () => {
        connected = true;
      },
      assertReady: () => {
        if (!connected) throw new Error("not ready");
      }
    };
    await expect(createAcpNoToolsReadinessProbe(() => idle as never)("user-1")).resolves.toBe(
      "available"
    );
  });

  it("reports the runner offline when connecting fails", async () => {
    const broken = {
      ensureConnected: async () => {
        throw new Error("ENOENT");
      },
      assertReady: () => {
        throw new Error("not ready");
      }
    };
    await expect(createAcpNoToolsReadinessProbe(() => broken as never)("user-1")).resolves.toBe(
      "runner-offline"
    );
  });

  it("reports unavailable for a provider that has not been proven with tools off", async () => {
    await expect(
      createAcpNoToolsReadinessProbe(() => ready)("user-1", undefined, "google")
    ).resolves.toBe("model-unavailable");
  });
});
