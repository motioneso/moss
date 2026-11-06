import { describe, expect, it } from "vitest";
import { createAcpNoToolsReadinessProbe } from "./acp-no-tools-readiness.js";

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

  it("reports not signed in when the runner says the provider needs a login", async () => {
    const probeProvider = async () => ({ status: "needs_login" as const });
    await expect(
      createAcpNoToolsReadinessProbe(() => ({ ...ready, probeProvider }) as never)("user-1")
    ).resolves.toBe("not-signed-in");
  });

  it("does not stop on a sign-in lookup that fails", async () => {
    const probeProvider = async () => {
      throw new Error("timeout");
    };
    await expect(
      createAcpNoToolsReadinessProbe(() => ({ ...ready, probeProvider }) as never)("user-1")
    ).resolves.toBe("available");
  });

  it("reports unavailable for a provider that has not been proven with tools off", async () => {
    await expect(
      createAcpNoToolsReadinessProbe(() => ready)("user-1", undefined, "google")
    ).resolves.toBe("model-unavailable");
  });
});
