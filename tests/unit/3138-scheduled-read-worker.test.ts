import { describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  db: {},
  now: new Date("2026-10-13T09:00:00Z"),
  reminder: {
    id: "check",
    ownerUserId: "owner",
    threadId: "main",
    destinationTitle: null,
    reservedMessageId: "message",
    text: "Check task status",
    state: "queued",
    version: 1,
    dueAt: new Date("2026-10-13T08:59:00Z"),
    deadlineAt: null,
    repeat: { kind: "interval", seconds: 60 },
    localDue: null,
    timeZone: null
  },
  quiet: vi.fn(),
  observation: vi.fn(),
  posted: vi.fn(),
  stopRenewal: vi.fn(async () => {})
}));
vi.mock("../../packages/chat/src/reminders/repository.js", () => ({
  ReminderRepository: class {
    async lockForDelivery() {
      return fixture.reminder;
    }
    async now() {
      return fixture.now;
    }
  }
}));
vi.mock("../../packages/chat/src/repository.js", () => ({
  ChatRepository: class {
    async lockThreadSelection() {}
  }
}));
vi.mock("../../packages/chat/src/reminders/destination.js", () => ({
  lockReminderDestination: async () => ({ id: "main" })
}));
vi.mock("../../packages/chat/src/scheduled-reads/repository.js", () => ({
  readScheduledOperation: async () => ({
    owner_user_id: "owner",
    operation: "tasks.get",
    item_id: "task",
    observation_key: null,
    failure_streak: 0
  }),
  recordScheduledObservation: fixture.observation,
  recordReadOutcome: vi.fn()
}));
vi.mock("../../packages/chat/src/scheduled-reads/recurring.js", () => ({
  persistQuietScheduledRun: fixture.quiet
}));
// Persistence/authority/rollback behavior is exercised with real owner-scoped DBs in R06.
vi.mock("../../packages/chat/src/scheduled-reads/attempts.js", () => ({
  admitScheduledReadAttempt: async () => ({
    messageId: "message",
    token: "token",
    ordinal: 1,
    version: 1
  }),
  validScheduledReadAttempt: async () => true,
  dispatchScheduledReadRecovery: vi.fn(),
  startScheduledReadRenewal: () => fixture.stopRenewal,
  finishScheduledReadAttempt: vi.fn()
}));
vi.mock("../../packages/chat/src/reminders/deliver.js", () => ({
  persistReminderResult: fixture.posted
}));
import { registerScheduledReadWorker } from "../../packages/chat/src/scheduled-reads/runner.js";
import type { PgBoss } from "pg-boss";
import type { DataContextRunner } from "@moss/db";

describe("registered recurring read worker composition", () => {
  it("passes the actual boss through metadata-only run handling to recurrence enqueue", async () => {
    const work = vi.fn(
      async (_name: string, _options: unknown, _handler: (jobs: unknown[]) => Promise<void>) =>
        "registered"
    );
    const boss = { work, send: vi.fn() } as unknown as PgBoss;
    const model = vi.fn();
    const read = vi.fn(async () => ({
      ok: true as const,
      data: {},
      structuredData: { task: { id: "task", title: "Proof", status: "todo" } }
    }));
    const dataContext = {
      withDataContext: async (_access: unknown, action: (db: unknown) => Promise<unknown>) =>
        action(fixture.db)
    } as unknown as DataContextRunner;
    await registerScheduledReadWorker(boss, {
      dataContext,
      gateway: { runBackgroundReadForActor: read },
      generateReport: model
    });
    expect(work).toHaveBeenCalledWith(
      "chat.scheduled-read",
      { pollingIntervalSeconds: 1, includeMetadata: true },
      expect.any(Function)
    );
    const handler = work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
    await handler([
      {
        data: { actorUserId: "owner", resourceId: "check", version: 1 },
        retryCount: 0,
        retryLimit: 2
      }
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(model).not.toHaveBeenCalled();
    expect(fixture.stopRenewal).toHaveBeenCalledTimes(1);
    expect(fixture.posted).not.toHaveBeenCalled();
    expect(fixture.quiet).toHaveBeenCalledExactlyOnceWith(
      fixture.db,
      fixture.reminder,
      "quiet",
      fixture.now,
      expect.anything(),
      boss
    );
  });
});
