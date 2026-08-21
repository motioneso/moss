import { describe, expect, it, vi } from "vitest";

import { createModuleBuildWorker, MODULE_BUILD_QUEUE } from "../../packages/jobs/src/module-build-jobs";

describe("createModuleBuildWorker", () => {
  const fakeBoss = {} as never;

  it("re-sends itself with the returned continuation, using a per-build singleton key", async () => {
    const sendJobSpy = vi.fn();
    const handler = createModuleBuildWorker({
      sendJob: sendJobSpy,
      boss: fakeBoss,
      runStep: async () => ({ deferred: true, continuation: { buildId: "b1", step: "writing_tests" } })
    });

    await handler([{ data: { actorUserId: "u1", buildId: "b1" } }]);

    expect(sendJobSpy).toHaveBeenCalledWith(
      fakeBoss,
      MODULE_BUILD_QUEUE,
      { actorUserId: "u1", buildId: "b1", step: "writing_tests" },
      expect.objectContaining({ singletonKey: "build:b1" })
    );
  });

  it("does not re-send when the step completes without deferring", async () => {
    const sendJobSpy = vi.fn();
    const handler = createModuleBuildWorker({
      sendJob: sendJobSpy,
      boss: fakeBoss,
      runStep: async () => ({ deferred: false })
    });

    await handler([{ data: { actorUserId: "u1", buildId: "b1" } }]);

    expect(sendJobSpy).not.toHaveBeenCalled();
  });
});
