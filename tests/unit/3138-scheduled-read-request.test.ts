import { describe, expect, it, vi } from "vitest";
import { resolveScheduledReadRequest } from "../../packages/chat/src/scheduled-reads/request.js";
const taskId = "11111111-1111-4111-8111-111111111111";
const candidates = [{ id: taskId, title: "Proof task" }];
describe("requested read-only recurrence", () => {
  it.each([
    ["every 60 seconds", { kind: "interval", seconds: 60 }],
    ["every day at 9am", { kind: "daily" }],
    ["every Monday at 9am", { kind: "weekly" }]
  ])("accepts the owner's exact supported cadence: %s", async (timing, repeat) => {
    const result = await resolveScheduledReadRequest(
      `Check my Proof task ${timing}`,
      candidates,
      async () => ({ taskId, timingRequest: `remind me ${timing} to check task` })
    );
    expect(result).toMatchObject({ taskId, when: { kind: "repeat_request", repeat } });
  });
  it.each([
    "every month",
    "every 2 days",
    "every 60 seconds until tomorrow",
    "every 60 seconds starting tomorrow"
  ])("never silently downgrades unsupported requested recurrence: %s", async (timing) => {
    const model = vi.fn(async () => ({
      taskId,
      timingRequest: "remind me in 30 seconds to check task"
    }));
    expect(
      await resolveScheduledReadRequest(`Check my task ${timing}`, candidates, model)
    ).toMatchObject({ taskId: null });
    expect(model).not.toHaveBeenCalled();
  });
  it("never loses an unsupported extra start time inside a recurring request", async () => {
    expect(
      await resolveScheduledReadRequest(
        "Check my task in 30 seconds every 60 seconds",
        candidates,
        async () => ({ taskId, timingRequest: "remind me every 60 seconds to check task" })
      )
    ).toMatchObject({ taskId: null });
  });
  it("a source title cannot create recurrence authority", async () => {
    const source = [{ id: taskId, title: "Proof every 60 seconds" }];
    expect(
      await resolveScheduledReadRequest(
        "Check my task Proof every 60 seconds",
        source,
        async () => ({ taskId, timingRequest: "remind me every 60 seconds to check task" })
      )
    ).toMatchObject({ taskId: null });
  });
  it("refuses model-invented recurrence on an owner one-time request", async () => {
    expect(
      await resolveScheduledReadRequest("Check my task in 30 seconds", candidates, async () => ({
        taskId,
        timingRequest: "remind me every 60 seconds to check task"
      }))
    ).toMatchObject({ taskId: null });
  });
  it("refuses a different model-selected cadence", async () => {
    expect(
      await resolveScheduledReadRequest("Check my task every 60 seconds", candidates, async () => ({
        taskId,
        timingRequest: "remind me every 120 seconds to check task"
      }))
    ).toMatchObject({ taskId: null });
  });
  it.each(["every 30 seconds", "every day", "every week at 9am"])(
    "rejects unsupported owner timing before model selection: %s",
    async (timing) => {
      const model = vi.fn();
      expect(
        await resolveScheduledReadRequest(`Check my task ${timing}`, candidates, model)
      ).toMatchObject({ taskId: null });
      expect(model).not.toHaveBeenCalled();
    }
  );
});
