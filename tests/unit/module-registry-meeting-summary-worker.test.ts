import { describe, expect, it, vi } from "vitest";
import { getBuiltInModuleRegistrations } from "@moss/module-registry";
import { createMeetingOutputRuntime } from "../../packages/module-registry/src/meeting-output-runtime.js";

vi.mock("../../packages/module-registry/src/meeting-output-runtime.js", () => ({
  createMeetingOutputRuntime: vi.fn(() => ({ generator: vi.fn() }))
}));

describe("automatic meeting summary worker composition", () => {
  it("passes the worker-owned constrained adapter and readiness probe to the same output runtime", async () => {
    const createConstrainedCliStructuredAdapter = vi.fn();
    const probeConstrainedCli = vi.fn(async () => "available" as const);
    const dataContext = {} as never;
    const work = vi.fn(async () => "summary-worker");
    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === "meetings"
    );
    expect(registration).toBeDefined();
    await expect(
      registration!.registerWorkers!({ work } as never, {
        rootDb: {} as never,
        dataContext,
        createConstrainedCliStructuredAdapter,
        probeConstrainedCli
      })
    ).resolves.toEqual(["summary-worker"]);
    expect(createMeetingOutputRuntime).toHaveBeenCalledExactlyOnceWith({
      dataContext,
      createConstrainedCliStructuredAdapter,
      probeConstrainedCli,
      resolveActiveModules: expect.any(Function)
    });
    expect(work).toHaveBeenCalledWith(
      "meetings.stop-summary",
      expect.any(Object),
      expect.any(Function)
    );
  });
});
