import { afterEach, describe, expect, it, vi } from "vitest";

import { handleUpgradeCheckJob, UPGRADE_NOTIFY_QUEUE } from "@moss/jobs";

// #1721: the owner lookup now reads a list (ordered, limit 2) rather than a single row, so the
// fake select chain has to answer `orderBy`, `limit` and `execute` too. `owners` is a list for the
// same reason — the duplicate-owner case is the one this issue is about.
function dbWithOwner(...owners: readonly string[]) {
  const ownerIds = owners.length > 0 ? owners : ["00000000-0000-4000-8000-000000000001"];
  const selectExecute = vi.fn(async () => ownerIds.map((id) => ({ id })));
  const execute = vi.fn(async () => undefined);
  const executeTakeFirstOrThrow = vi.fn(async () => ({ value: { version: "1.0.0" } }));
  const db = {
    selectFrom: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      execute: selectExecute,
      executeTakeFirstOrThrow
    })),
    insertInto: vi.fn(() => ({
      values: vi.fn().mockReturnThis(),
      onConflict: vi.fn().mockReturnThis(),
      execute
    }))
  };
  return { db, selectExecute, execute };
}

describe("handleUpgradeCheckJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.JARVIS_APP_VERSION;
  });

  it.each([403, 429, 500])("soft-skips GitHub status %s", async (status) => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status }))
    );
    const boss = { send: vi.fn() };
    const { db } = dbWithOwner();

    await expect(handleUpgradeCheckJob(db as never, boss as never)).resolves.toBeUndefined();

    expect(boss.send).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal timeout to fetch", async () => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    const fetchMock = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => ({
      ok: true,
      json: async () => ({ tag_name: "v1.0.0", body: "" }),
      _init: init
    }));
    vi.stubGlobal("fetch", fetchMock);
    const boss = { send: vi.fn() };
    const { db } = dbWithOwner();

    await handleUpgradeCheckJob(db as never, boss as never);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with a clear error instead of a raw SyntaxError on unparsable JSON", async () => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: () => Promise.reject(new SyntaxError("bad json"))
      }))
    );
    const boss = { send: vi.fn() };
    const { db } = dbWithOwner();

    await expect(handleUpgradeCheckJob(db as never, boss as never)).rejects.toThrow(
      "Invalid release response: unparsable body"
    );
  });

  it("caches a newer release and enqueues one owner-scoped notification job", async () => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: "v1.1.0", body: "notes" })
      }))
    );
    const boss = { send: vi.fn(async () => "job-1") };
    const { db } = dbWithOwner("11111111-1111-4111-8111-111111111111");

    await handleUpgradeCheckJob(db as never, boss as never);

    expect(boss.send).toHaveBeenCalledWith(
      UPGRADE_NOTIFY_QUEUE,
      {
        kind: "upgrade-notify",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        version: "v1.1.0"
      },
      { singletonKey: "upgrade-notify:11111111-1111-4111-8111-111111111111:v1.1.0" }
    );
  });

  // #1721: with two owner rows the old code notified whichever one the database returned first,
  // so the same instance could tell a different person on each run — and the singleton key changed
  // with them, so the "only notify once" guarantee quietly stopped holding. The query now orders
  // by created_at, and this asserts the handler uses the first row rather than any row.
  it("notifies the first ordered owner and logs when a second owner exists", async () => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: "v1.1.0", body: "notes" })
      }))
    );
    const boss = { send: vi.fn(async () => "job-1") };
    const { db } = dbWithOwner(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    );
    const warnings: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      warnings.push(String(chunk));
      return true;
    });

    try {
      await handleUpgradeCheckJob(db as never, boss as never);
    } finally {
      write.mockRestore();
    }

    expect(boss.send).toHaveBeenCalledWith(
      UPGRADE_NOTIFY_QUEUE,
      expect.objectContaining({ actorUserId: "11111111-1111-4111-8111-111111111111" }),
      expect.anything()
    );
    // Notifying is not enough on its own — an instance with two owners is a defect somebody has
    // to find, and the log line is the only place it surfaces.
    expect(warnings.join("")).toContain("upgrade_notify_multiple_owners");
  });
});
