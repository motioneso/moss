import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "@moss/jobs";
import { registerVoiceRequestWorker } from "../../packages/chat/src/voice-request-jobs.js";

const actorUserId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
type Handler = (jobs: readonly unknown[]) => Promise<unknown>;

async function fixture() {
  let handler: Handler | undefined;
  const boss = {
    work: vi.fn(async (_name: string, _options: unknown, callback: Handler) => {
      handler = callback;
      return "worker";
    })
  } as unknown as PgBoss;
  const process = vi.fn(async () => {});
  await registerVoiceRequestWorker(boss, { process });
  return {
    process,
    deliver: (data: unknown) => {
      if (!handler) throw new Error("Worker not registered");
      return handler([{ id: "job", data }]);
    }
  };
}

describe("Main voice queue metadata", () => {
  it("passes only the actor, receipt id and request identity to the API-owned service", async () => {
    const { deliver, process } = await fixture();
    await deliver({ actorUserId, resourceId });
    expect(process).toHaveBeenCalledExactlyOnceWith({ actorUserId, requestId: "job" }, resourceId);
  });
  it.each([
    null,
    {},
    { actorUserId },
    { actorUserId, resourceId: "invalid" },
    { actorUserId: "invalid", resourceId },
    { actorUserId, resourceId, transcript: "private audio" }
  ])("rejects invalid or content-bearing metadata: %j", async (data) => {
    const { deliver, process } = await fixture();
    await expect(deliver(data)).rejects.toThrow("Invalid voice request metadata");
    expect(process).not.toHaveBeenCalled();
  });
  it("lets pre-dispatch availability errors fail the job for a durable retry", async () => {
    const { deliver, process } = await fixture();
    process.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(deliver({ actorUserId, resourceId })).rejects.toThrow("provider unavailable");
  });
});
