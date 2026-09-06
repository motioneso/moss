// #743 security finding 7: push jobs are enqueued on the caller's own transaction, so the
// job row cannot be seen by a worker before the notification it points at commits.
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import { createPushQueuePort, scopedJobDatabase } from "@moss/jobs";
import { PUSH_DELIVER_QUEUE, PUSH_SUMMARY_QUEUE } from "@moss/notifications";

function fakeScopedDb() {
  const executeQuery = vi.fn().mockResolvedValue({ rows: [{ id: "job-1" }] });
  const scopedDb = { db: { executeQuery }, [dataContextBrand]: true } as unknown as DataContextDb;
  return { scopedDb, executeQuery };
}

describe("scopedJobDatabase", () => {
  it("runs pg-boss's SQL on the scoped transaction, not on a separate connection", async () => {
    const { scopedDb, executeQuery } = fakeScopedDb();

    const result = await scopedJobDatabase(scopedDb).executeSql("insert into pgboss.job", ["x"]);

    expect(result.rows).toEqual([{ id: "job-1" }]);
    expect(executeQuery).toHaveBeenCalledTimes(1);
    const compiled = executeQuery.mock.calls[0]?.[0] as { sql: string; parameters: unknown[] };
    expect(compiled.sql).toBe("insert into pgboss.job");
    expect(compiled.parameters).toEqual(["x"]);
  });

  it("refuses anything that is not a data-context handle", () => {
    expect(() => scopedJobDatabase({ db: {} } as unknown as DataContextDb)).toThrow(
      /withDataContext/
    );
  });
});

describe("createPushQueuePort", () => {
  it("sends the deliver job with the caller's transaction as pg-boss's db option", async () => {
    const send = vi.fn().mockResolvedValue("job-1");
    const port = createPushQueuePort({ send } as never);
    const { scopedDb, executeQuery } = fakeScopedDb();

    await port.enqueueDeliver(scopedDb, "n1", "11111111-1111-4111-8111-111111111111");

    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { db: { executeSql(text: string, values?: unknown[]): Promise<unknown> } }
    ];
    expect(queue).toBe(PUSH_DELIVER_QUEUE);
    expect(payload).toEqual({
      actorUserId: "11111111-1111-4111-8111-111111111111",
      notificationId: "n1",
      recipientUserId: "11111111-1111-4111-8111-111111111111"
    });
    await options.db.executeSql("select 1", []);
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it("sends the summary job with its singleton key, release time and the transaction", async () => {
    const send = vi.fn().mockResolvedValue("job-2");
    const port = createPushQueuePort({ send } as never);
    const { scopedDb } = fakeScopedDb();
    const releaseAt = new Date("2026-09-05T10:00:00.000Z");

    await port.enqueueSummary(scopedDb, "11111111-1111-4111-8111-111111111111", releaseAt);

    const [queue, payload, options] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>
    ];
    expect(queue).toBe(PUSH_SUMMARY_QUEUE);
    expect(payload).toEqual({
      actorUserId: "11111111-1111-4111-8111-111111111111",
      recipientUserId: "11111111-1111-4111-8111-111111111111",
      releaseAt: "2026-09-05T10:00:00.000Z"
    });
    expect(options.singletonKey).toBe(
      "11111111-1111-4111-8111-111111111111:2026-09-05T10:00:00.000Z"
    );
    expect(options.startAfter).toEqual(releaseAt);
    expect(options.db).toBeDefined();
  });
});
