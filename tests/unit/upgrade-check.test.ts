import { afterEach, describe, expect, it, vi } from "vitest";

import { handleUpgradeCheckJob, UPGRADE_NOTIFY_QUEUE } from "@moss/jobs";

// #1721, #3221: the handler calls two database functions through raw SQL, so the fake exposes the
// executor Kysely resolves for raw queries. `owners` is a list because the duplicate-owner case is
// the one #1721 is about.
function dbWithOwner(...owners: readonly string[]) {
  const ownerIds = owners.length > 0 ? owners : ["00000000-0000-4000-8000-000000000001"];
  const statements: string[] = [];
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => ({ statement: JSON.stringify(node) }),
    executeQuery: async (query: { statement: string }) => {
      statements.push(query.statement);
      return {
        rows: query.statement.includes("upgrade_notify_owner_ids")
          ? ownerIds.map((id) => ({ id }))
          : []
      };
    }
  };
  const db = { getExecutor: () => executor };
  return { db, statements };
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
    const { db, statements } = dbWithOwner("11111111-1111-4111-8111-111111111111");

    await handleUpgradeCheckJob(db as never, boss as never);

    expect(statements.some((statement) => statement.includes("record_latest_release"))).toBe(true);
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
