import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveScheduledReadRequest } from "../../packages/chat/src/scheduled-reads/request.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const candidates = [{ id: taskId, title: "Proof task" }];
afterEach(() => vi.restoreAllMocks());

describe("scheduled source request boundary", () => {
  it.each([
    [null, "output_shape"],
    [{ taskId: "", timingRequest: "" }, "item_selection"],
    [{ taskId, timingRequest: "check task in 30 seconds" }, "timing"]
  ])("records a bounded validation reason without model content", async (output, stage) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await resolveScheduledReadRequest(
      "Check my private task in 30 seconds",
      candidates,
      async () => output
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "chat.scheduled_read_refused",
        stage,
        errorClass: "ValidationError"
      })
    );
  });
  it.each([
    "check the oven at 5",
    "can you check my grammar",
    "tasks for today look heavy",
    "check the task in this essay",
    "I check task status at home"
  ])("leaves everyday chat alone: %s", async (request) => {
    const interpret = vi.fn();
    expect(await resolveScheduledReadRequest(request, candidates, interpret)).toBeUndefined();
    expect(interpret).not.toHaveBeenCalled();
  });
  it("freezes an owned item and validated timing instead of model prose", async () => {
    expect(
      await resolveScheduledReadRequest(
        "Check the status of my Proof task in 30 seconds",
        candidates,
        async () => ({ taskId, timingRequest: "remind me in 30 seconds to check task" })
      )
    ).toMatchObject({
      kind: "scheduled_read",
      taskId,
      title: "Proof task",
      when: { kind: "request", delaySeconds: 30 }
    });
  });
  it.each([
    {
      taskId: "22222222-2222-4222-8222-222222222222",
      timingRequest: "remind me in 30 seconds to check task"
    },
    { taskId, timingRequest: "remind me every day to check task" },
    { taskId, timingRequest: "remind me in 30 seconds to check task", operation: "tasks.update" },
    { taskId, timingRequest: "remind me in 30 seconds to check task", recipient: "someone else" }
  ])("refuses model output outside the frozen read contract", async (output) => {
    expect(
      await resolveScheduledReadRequest(
        "Check my task status in 30 seconds",
        candidates,
        async () => output
      )
    ).toMatchObject({ kind: "scheduled_read", taskId: null });
  });
  it("refuses recurring and mutating requests without a model call", async () => {
    const interpret = vi.fn();
    for (const request of [
      "Check my task status every day at 5 pm",
      "Check my task in 30 seconds and delete it"
    ])
      expect(await resolveScheduledReadRequest(request, candidates, interpret)).toMatchObject({
        taskId: null
      });
    expect(interpret).not.toHaveBeenCalled();
  });
});
