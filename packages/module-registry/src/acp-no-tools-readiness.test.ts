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

  it("reports unavailable when the runner is down", async () => {
    await expect(createAcpNoToolsReadinessProbe(() => down)("user-1")).resolves.toBe(
      "model-unavailable"
    );
  });

  it("reports unavailable when there is no runner connection", async () => {
    await expect(createAcpNoToolsReadinessProbe(() => undefined)("user-1")).resolves.toBe(
      "model-unavailable"
    );
  });

  it("reports unavailable for a provider that has not been proven with tools off", async () => {
    await expect(
      createAcpNoToolsReadinessProbe(() => ready)("user-1", undefined, "google")
    ).resolves.toBe("model-unavailable");
  });
});
