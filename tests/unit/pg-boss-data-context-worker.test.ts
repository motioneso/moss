// #743 security finding 8: a worker may ask pg-boss for a retry only after its transaction
// has committed, so the bookkeeping it wrote (delivery marks, removed devices) survives the
// retry. The after-commit hook is the one place a throw fails the job without a rollback.
import { describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { registerDataContextWorker, type PgBoss } from "@moss/jobs";

const ACTOR = "11111111-1111-4111-8111-111111111111";

type Handler = (jobs: readonly unknown[]) => Promise<unknown>;

function fakeBoss() {
  let captured: Handler | undefined;
  const work = vi.fn(async (_name: string, _options: unknown, handler: Handler) => {
    captured = handler;
    return "worker-1";
  });
  return {
    boss: { work } as unknown as PgBoss,
    work,
    handler: (): Handler => {
      if (!captured) {
        throw new Error("boss.work was not called");
      }
      return captured;
    }
  };
}

function fakeDataContext(events: string[]) {
  return {
    withDataContext: vi.fn(
      async (_context: unknown, fn: (scopedDb: unknown) => Promise<unknown>) => {
        const result = await fn({ db: {} });
        events.push("committed");
        return result;
      }
    )
  } as unknown as DataContextRunner;
}

describe("registerDataContextWorker after-commit hook", () => {
  it("runs the hook after the transaction has committed, with the handler's result", async () => {
    const events: string[] = [];
    const { boss, work, handler } = fakeBoss();
    const afterCommit = vi.fn((result: { retry: boolean }) => {
      events.push(`hook:${result.retry}`);
    });

    await registerDataContextWorker(
      boss,
      "q",
      fakeDataContext(events),
      async () => {
        events.push("handler");
        return { retry: true };
      },
      { pollingIntervalSeconds: 2, includeMetadata: true },
      { afterCommit }
    );

    expect(work).toHaveBeenCalledWith(
      "q",
      { pollingIntervalSeconds: 2, includeMetadata: true },
      expect.any(Function)
    );
    const result = await handler()([{ id: "job-1", data: { actorUserId: ACTOR } }]);
    expect(events).toEqual(["handler", "committed", "hook:true"]);
    expect(result).toEqual({ retry: true });
  });

  it("a throw from the hook fails the job after the commit, never before it", async () => {
    const events: string[] = [];
    const { boss, handler } = fakeBoss();

    await registerDataContextWorker(
      boss,
      "q",
      fakeDataContext(events),
      async () => {
        events.push("handler");
        return "done";
      },
      { pollingIntervalSeconds: 2 },
      {
        afterCommit: () => {
          throw new Error("retry please");
        }
      }
    );

    await expect(handler()([{ id: "job-1", data: { actorUserId: ACTOR } }])).rejects.toThrow(
      "retry please"
    );
    expect(events).toEqual(["handler", "committed"]);
  });

  it("hands the job's retry metadata to the handler", async () => {
    const { boss, handler } = fakeBoss();
    const seen = vi.fn();

    await registerDataContextWorker(
      boss,
      "q",
      fakeDataContext([]),
      async (job) => {
        seen(job.retryCount, job.retryLimit);
      },
      { pollingIntervalSeconds: 2, includeMetadata: true }
    );

    await handler()([{ id: "job-1", data: { actorUserId: ACTOR }, retryCount: 1, retryLimit: 3 }]);
    expect(seen).toHaveBeenCalledWith(1, 3);
  });

  it("works without a hook, exactly as before", async () => {
    const events: string[] = [];
    const { boss, handler } = fakeBoss();

    await registerDataContextWorker(boss, "q", fakeDataContext(events), async () => "ok");

    await expect(handler()([{ id: "job-1", data: { actorUserId: ACTOR } }])).resolves.toBe("ok");
    expect(events).toEqual(["committed"]);
  });
});
