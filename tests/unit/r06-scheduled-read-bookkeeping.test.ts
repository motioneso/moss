import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import type { DataContextRunner } from "@moss/db";
import { registerScheduledReadBookkeepingWorker } from "../../packages/chat/src/scheduled-reads/bookkeeping.js";
import {
  CHAT_QUEUE_DEFINITIONS,
  registerChatJobWorkers,
  type RegisterChatJobWorkersOptions
} from "../../packages/chat/src/jobs.js";
import { CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE } from "../../packages/chat/src/scheduled-reads/queue.js";
import { scheduledInterruptionMessage } from "../../packages/chat/src/scheduled-reads/report.js";

describe("provider-independent scheduled read bookkeeping", () => {
  it("registers without a source gateway or report generator", async () => {
    const work = vi.fn(async () => "bookkeeping-worker");
    const dataContext = { withDataContext: vi.fn() } as unknown as DataContextRunner;
    const boss = { work } as unknown as PgBoss;
    expect(await registerScheduledReadBookkeepingWorker(boss, { dataContext })).toBe(
      "bookkeeping-worker"
    );
    expect(work).toHaveBeenCalledWith(
      CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
      expect.objectContaining({ includeMetadata: true }),
      expect.any(Function)
    );
    expect(
      CHAT_QUEUE_DEFINITIONS.find((q) => q.name === CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE)?.options
    ).toMatchObject({ retryLimit: 1, retentionSeconds: 3_456_000, deleteAfterSeconds: 86_400 });
    expect(dataContext.withDataContext).not.toHaveBeenCalled();
  });
  it("production composition registers bookkeeping when both execution providers are absent", async () => {
    const work = vi.fn(async (name: string) => `worker:${name}`);
    const boss = {
      work,
      getSchedules: async () => [],
      getQueue: async () => null
    } as unknown as PgBoss;
    const dataContext = { withDataContext: vi.fn() } as unknown as DataContextRunner;
    const result = await registerChatJobWorkers(boss, dataContext, {
      reminderNotifications: {} as RegisterChatJobWorkersOptions["reminderNotifications"],
      extractFactsDeps: {} as RegisterChatJobWorkersOptions["extractFactsDeps"],
      embeddingProviderFactory: vi.fn()
    });
    expect(result).toContain(`worker:${CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE}`);
    expect(work.mock.calls.map(([name]) => name)).not.toContain("chat.scheduled-read");
    expect(dataContext.withDataContext).not.toHaveBeenCalled();
  });
  it.each(["unknown", "interrupted"] as const)("keeps %s history truthful", (kind) => {
    const text = scheduledInterruptionMessage(kind, true);
    expect(text).toContain("outcome");
    expect(text).toContain("unknown");
    expect(text).toContain("saved cadence");
    expect(text).not.toMatch(/after retrying|I read the task|couldn't read|report.*generated/i);
    expect(scheduledInterruptionMessage(kind, false)).toContain("No further run fits");
  });
});
