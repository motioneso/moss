import {
  categorizeApplyHandler,
  reviewApplyHandler,
  transactionCategorizeNewHandler
} from "../../external-modules/finance/src/worker/handlers/feed.js";
import { activityUndoHandler } from "../../external-modules/finance/src/worker/handlers/activity.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { PlaidError } from "../../external-modules/finance/src/adapters/plaid.js";
import {
  providerFeed,
  feedPage,
  handoffItem,
  handoffAccount,
  handoffPending,
  handoffPosted
} from "./helpers/finance-provider-feed.js";
import { NS } from "../../external-modules/finance/src/domain/index.js";
import {
  createDatabase,
  DataContextRunner,
  createModuleStorageRpc,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import { installModule } from "../../scripts/module-install.js";
import { sqlStore, type FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import {
  connectionStrings,
  ids,
  resetFoundationDatabase,
  grantModuleMembershipAtSetup,
  revokeModuleMembershipAtTeardown,
  dropModuleRolesAtTeardown
} from "./test-database.js";
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let ownedTables: string[];
let setupReady = false;
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => ({ rows: [...(await rpc.query(text, params)).rows] as never[] })
  };
  return sqlStore(port);
}
const owner = <T>(
  fn: (s: ReturnType<typeof store>) => Promise<T>,
  actorUserId: string = ids.userA
) => runner.withDataContext({ actorUserId }, (scope) => fn(store(scope)));
beforeAll(async () => {
  await resetFoundationDatabase();
  setupReady = true;
  const manifest = JSON.parse(
    await readFile("external-modules/finance/jarvis.module.json", "utf8")
  );
  ownedTables = manifest.database.ownedTables;
  await installModule({
    moduleId: "finance",
    manifest,
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/finance/sql"
  });
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  runner = new DataContextRunner(db);
});
afterAll(async () => {
  if (!setupReady) return;
  await db?.destroy();
  await revokeModuleMembershipAtTeardown([`REVOKE ${runtimeRole} FROM jarvis_app_runtime`]);
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    for (const table of ownedTables ?? [])
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${runtimeRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${runtimeRole}`
    );
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${installRole} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${installRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${installRole} CASCADE`
    );
    await dropModuleRolesAtTeardown([installRole, runtimeRole]);
    await client.query("DELETE FROM app.module_installs WHERE module_id = 'finance'");
    await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = 'finance'");
  } finally {
    await client.end();
  }
});

const at = "2026-10-30T05:00:00Z";
const bankRow = {
  id: "metadata:bank",
  accountId: "metadata:checking",
  date: "2026-10-01",
  name: "Synthetic bank purchase",
  amountCents: 1000,
  isoCurrency: "USD",
  categoryId: "groceries",
  pending: false,
  pendingTransactionId: null,
  merchant: null,
  plaidCategory: null,
  categorizedBy: "ai",
  reviewState: "needs_look",
  notes: "Synthetic old note"
} as const;
beforeAll(async () => {
  await owner(async (s) => {
    await s.budgetPolicy!.configure("USD", false, at);
    await s.putAccount({
      accountId: bankRow.accountId,
      itemId: null,
      name: "Synthetic imported checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: null,
      balanceCents: 200000,
      isoCurrency: "USD",
      updatedAt: at
    });
  });
});
describe("reviewed transaction metadata", () => {
  it("keeps current user category and notes when a stale provider window writes new money", async () => {
    await owner((s) => s.putTransaction(bankRow));
    const snapshot = (await owner((s) => s.getTransactionChunk(bankRow.accountId, "2026-10")))![0]!;
    await owner((s) =>
      s.putTransaction({
        ...snapshot,
        categoryId: "dining",
        notes: "Synthetic newer user note",
        categorizedBy: "user",
        reviewState: "confirmed"
      })
    );
    await owner((s) =>
      s.putTransactionChunk(bankRow.accountId, "2026-10", [{ ...snapshot, amountCents: 1200 }])
    );
    const saved = (await owner((s) => s.getTransactionChunk(bankRow.accountId, "2026-10")))![0]!;
    expect(saved).toMatchObject({
      amountCents: 1200,
      categoryId: "dining",
      notes: "Synthetic newer user note",
      categorizedBy: "user",
      reviewState: "needs_look"
    });
    expect((await owner((s) => s.getAccount(bankRow.accountId)))!.balanceCents).toBe(200000);
  });
});

const seed = (id: string, extra: Partial<TransactionRecord> = {}) =>
  owner((s) => s.putTransaction({ ...bankRow, id, ...extra }));
const read = (id: string, actor: string = ids.userA) =>
  owner(
    async (s) => (await s.metadata!.rows(bankRow.accountId, "2026-10")).find((r) => r.id === id)!,
    actor
  );
const patch = async (id: string) => {
  const row = await read(id);
  return { id, writeRevision: row.writeRevision, categoryId: "dining" };
};
const activity = () => owner((s) => s.listActivity("2026-10-01", "2026-11-01", 200));
describe("metadata-only compare and set", () => {
  it("changes category and explicit notes, preserves every financial field and logs no notes", async () => {
    await seed("metadata:exact");
    const before = await read("metadata:exact");
    const count = (await activity()).length;
    expect(
      await owner((s) =>
        s.metadata!.apply(
          [{ ...before, categoryId: "dining", notes: "Synthetic private edit" }],
          "moss",
          at
        )
      )
    ).toBe(true);
    const after = await read(before.id);
    expect(after).toEqual({
      ...before,
      categoryId: "dining",
      categorizedBy: "user",
      reviewState: "confirmed",
      notes: "Synthetic private edit",
      writeRevision: after.writeRevision
    });
    expect(after.writeRevision).not.toBe(before.writeRevision);
    const logged = await activity();
    expect(logged).toHaveLength(count + 1);
    expect(JSON.stringify(logged)).not.toContain("Synthetic private edit");
    expect(
      await owner((s) => s.metadata!.apply([{ ...after, categoryId: "groceries" }], "user", at))
    ).toBe(true);
    expect((await read(before.id)).notes).toBe("Synthetic private edit");
    const latest = await read(before.id);
    expect(
      await owner((s) =>
        s.metadata!.apply([{ ...latest, categoryId: "groceries", notes: "" }], "user", at)
      )
    ).toBe(true);
    expect((await read(before.id)).notes).toBe("");
  });
  it("rejects stale batches atomically, including their activity", async () => {
    await seed("metadata:batch-a");
    await seed("metadata:batch-b");
    const a = await patch("metadata:batch-a"),
      b = await patch("metadata:batch-b");
    await seed(b.id, { amountCents: 1000 });
    const count = (await activity()).length;
    expect(await owner((s) => s.metadata!.apply([a, b], "user", at))).toBe(false);
    expect((await read(a.id)).categoryId).toBe("groceries");
    expect((await activity()).length).toBe(count);
  });
  it("rejects empty, oversized, duplicate, missing and invalid-category batches", async () => {
    await seed("metadata:bounds");
    const good = await patch("metadata:bounds");
    for (const rows of [
      [],
      [good, good],
      Array.from({ length: 201 }, () => good),
      [good, { ...good, id: "missing" }],
      [{ ...good, categoryId: "missing" }]
    ])
      expect(await owner((s) => s.metadata!.apply(rows, "user", at))).toBe(false);
    expect((await read(good.id)).categoryId).toBe("groceries");
  });
  it("keeps owner records private from another member and an administrator", async () => {
    await seed("metadata:private");
    const row = await patch("metadata:private");
    for (const actor of [ids.userB, ids.adminUser]) {
      expect(await read(row.id, actor)).toBeUndefined();
      expect(await owner((s) => s.metadata!.apply([row], "user", at), actor)).toBe(false);
    }
    expect((await read(row.id)).categoryId).toBe("groceries");
  });
  it("preserves edited metadata after sync when money has not changed", async () => {
    await seed("metadata:same-money");
    const snapshot = await read("metadata:same-money");
    expect(
      await owner((s) =>
        s.metadata!.apply(
          [{ ...snapshot, categoryId: "dining", notes: "Synthetic latest" }],
          "user",
          at
        )
      )
    ).toBe(true);
    const current = await read(snapshot.id);
    const rows = (await owner((s) => s.getTransactionChunk(bankRow.accountId, "2026-10")))!;
    await owner((s) =>
      s.putTransactionChunk(
        bankRow.accountId,
        "2026-10",
        rows.map((r) => (r.id === snapshot.id ? snapshot : r))
      )
    );
    expect(await read(snapshot.id)).toMatchObject({
      categoryId: current.categoryId,
      notes: current.notes,
      reviewState: "confirmed"
    });
  });
});

async function sql(text: string, params: readonly unknown[] = []) {
  return runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
}
describe("metadata eligibility and lock ordering", () => {
  it("refuses split records and archived destinations, retaining pending metadata compatibility", async () => {
    await seed("metadata:split", { splits: [{ categoryId: "groceries", amountCents: 1000 }] });
    const split = await patch("metadata:split");
    expect(await owner((s) => s.metadata!.apply([split], "user", at))).toBe(false);
    await seed("metadata:pending", { pending: true });
    const pending = await patch("metadata:pending");
    expect(await owner((s) => s.metadata!.apply([pending], "user", at))).toBe(true);
    expect((await read(pending.id)).pending).toBe(true);
    await seed("metadata:archived");
    const archived = await patch("metadata:archived");
    await sql("UPDATE app.finance_categories SET archived_at=now() WHERE id=$1", ["dining"]);
    try {
      expect(await owner((s) => s.metadata!.apply([archived], "user", at))).toBe(false);
    } finally {
      await sql("UPDATE app.finance_categories SET archived_at=NULL WHERE id=$1", ["dining"]);
    }
  });
});

it("rejects a captured edit after provider money changes while it waits on the row lock", async () => {
  await seed("metadata:race");
  const captured = await patch("metadata:race");
  let acquired!: () => void, release!: () => void;
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const advance = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
    await createModuleStorageRpc(scope, "finance").query(
      "SELECT id FROM app.finance_transactions WHERE id=$1 FOR UPDATE",
      [captured.id]
    );
    acquired();
    await advance;
    await store(scope).putTransaction({ ...bankRow, id: captured.id, amountCents: 4321 });
  });
  await locked;
  const pending = owner((s) => s.metadata!.apply([captured], "user", at));
  const observer = new Client({ connectionString: connectionStrings.bootstrap });
  await observer.connect();
  let waiting = false;
  let settled!: [PromiseSettledResult<void>, PromiseSettledResult<boolean>];
  try {
    for (let i = 0; i < 80; i++) {
      const rows = await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE $1",
        ["%WITH requested AS (%"]
      );
      if (rows.rows[0].n > 0) {
        waiting = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  } finally {
    release();
    await observer.end();
    settled = await Promise.allSettled([holder, pending]);
  }
  expect(waiting).toBe(true);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  expect(settled[1]).toEqual({ status: "fulfilled", value: false });
  expect(await read(captured.id)).toMatchObject({ amountCents: 4321, categoryId: "groceries" });
});

it("refuses linked transfer metadata and ignores manual records in provider-window persistence", async () => {
  const fromAccountId = "metadata:transfer-from",
    toAccountId = "metadata:transfer-to";
  await owner(async (s) => {
    for (const accountId of [fromAccountId, toAccountId])
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic metadata transfer",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-10-01",
        openingBalanceCents: 10000,
        digest: "a".repeat(64),
        at
      });
    const accounts = await s.transfers!.accounts();
    expect(
      await s.transfers!.create({
        operationId: "89000000-0000-4000-8000-000000000001",
        fromAccountId,
        toAccountId,
        fromRevision: accounts.find((a) => a.accountId === fromAccountId)!.revision,
        toRevision: accounts.find((a) => a.accountId === toAccountId)!.revision,
        date: "2026-10-15",
        today: "2026-10-30",
        amountCents: 123,
        isoCurrency: "USD",
        cleared: true,
        digest: "b".repeat(64),
        at
      })
    ).toBe("created");
    const rows = await s.metadata!.rows(fromAccountId, "2026-10");
    expect(rows).toHaveLength(1);
    const before = rows[0]!;
    expect(
      await s.metadata!.apply(
        [{ ...before, categoryId: "dining", notes: "Synthetic refused note" }],
        "user",
        at
      )
    ).toBe(false);
    await s.putTransactionChunk(fromAccountId, "2026-10", [
      { ...before, notes: "Synthetic stale snapshot" }
    ]);
    expect(await s.metadata!.rows(fromAccountId, "2026-10")).toEqual(rows);
    expect((await s.getAccount(fromAccountId))!.balanceCents).toBe(9877);
    expect((await s.getAccount(toAccountId))!.balanceCents).toBe(10123);
  });
});

describe("atomic metadata undo", () => {
  it("restores a category without changing notes/money and marks history once", async () => {
    await seed("metadata:undo");
    const before = await read("metadata:undo");
    expect(
      await owner((s) =>
        s.metadata!.apply(
          [{ ...before, categoryId: "dining", notes: "Synthetic note retained by undo" }],
          "user",
          at
        )
      )
    ).toBe(true);
    const action = (await activity()).find((a) => a.params.transactionId === before.id && a.undo)!;
    const current = await read(before.id);
    const count = (await activity()).length;
    expect(await owner((s) => s.metadata!.undo(action.id, current.writeRevision, at))).toBe(true);
    const after = await read(before.id);
    expect(after).toEqual({
      ...current,
      categoryId: "groceries",
      writeRevision: after.writeRevision
    });
    expect((await owner((s) => s.getActivity(action.id)))!.undoneAt).not.toBeNull();
    expect((await activity()).length).toBe(count + 1);
    expect(await owner((s) => s.metadata!.undo(action.id, after.writeRevision, at))).toBe(false);
    expect((await activity()).length).toBe(count + 1);
  });
  it("refuses stale or foreign undo without changing history and can restore uncategorized state", async () => {
    await seed("metadata:undo-null", { categoryId: null, categorizedBy: null });
    const before = await read("metadata:undo-null");
    expect(
      await owner((s) => s.metadata!.apply([{ ...before, categoryId: "dining" }], "user", at))
    ).toBe(true);
    const action = (await activity()).find((a) => a.params.transactionId === before.id && a.undo)!;
    const current = await read(before.id);
    expect(
      await owner((s) => s.metadata!.undo(action.id, current.writeRevision, at), ids.adminUser)
    ).toBe(false);
    await seed(before.id, { categoryId: "dining", amountCents: 4321 });
    expect(await owner((s) => s.metadata!.undo(action.id, current.writeRevision, at))).toBe(false);
    expect((await owner((s) => s.getActivity(action.id)))!.undoneAt).toBeNull();
    const changed = await read(before.id);
    expect(await owner((s) => s.metadata!.undo(action.id, changed.writeRevision, at))).toBe(true);
    expect(await read(before.id)).toMatchObject({
      categoryId: null,
      categorizedBy: null,
      reviewState: "needs_look",
      amountCents: 4321
    });
  });
});

describe("SQL worker metadata routes", () => {
  const ports = (s: ReturnType<typeof store>) =>
    ({ store: async () => s, now: () => new Date(at) }) as unknown as WorkerPorts;
  it("persists a queued category batch atomically without duplicate activity", async () => {
    await seed("metadata:job-a");
    await seed("metadata:job-b");
    const count = (await activity()).length;
    await owner(async (s) => {
      expect(
        await reviewApplyHandler(ports(s))({
          jobKind: "finance.review-apply",
          params: {
            transactionIds: ["metadata:job-a", "metadata:job-b"],
            accountIds: [bankRow.accountId, bankRow.accountId],
            months: ["2026-10", "2026-10"],
            categoryIds: ["dining", "groceries"],
            createRule: false
          }
        })
      ).toEqual({ status: "ok", confirmed: 2 });
    });
    expect((await activity()).length).toBe(count + 2);
    expect(await read("metadata:job-a")).toMatchObject({
      amountCents: 1000,
      categoryId: "dining",
      notes: bankRow.notes
    });
    expect(await read("metadata:job-b")).toMatchObject({
      amountCents: 1000,
      categoryId: "groceries",
      reviewState: "confirmed",
      notes: bankRow.notes
    });
  });
  it("routes individual/chat notes and Undo through the SQL metadata capability", async () => {
    await seed("metadata:chat", { name: "Synthetic unique metadata merchant" });
    const count = (await activity()).length;
    await owner(async (s) => {
      const result = await transactionCategorizeNewHandler(ports(s))({
        transactionId: "metadata:chat",
        accountId: bankRow.accountId,
        month: "2026-10",
        categoryId: "dining",
        amountCents: 1000,
        notes: ""
      });
      expect(result.status).toBe("ok");
      expect(result.transaction).not.toHaveProperty("writeRevision");
    });
    const action = (await activity()).find(
      (a) => a.params.transactionId === "metadata:chat" && a.undo
    )!;
    expect((await activity()).length).toBe(count + 1);
    expect(await read("metadata:chat")).toMatchObject({
      categoryId: "dining",
      notes: "",
      amountCents: 1000
    });
    await owner(async (s) =>
      expect(
        await activityUndoHandler(ports(s))({
          jobKind: "finance.activity-undo",
          params: { activityId: action.id }
        })
      ).toEqual({ status: "ok", undone: true })
    );
    expect((await activity()).length).toBe(count + 2);
    expect(await read("metadata:chat")).toMatchObject({
      categoryId: "groceries",
      notes: "",
      amountCents: 1000
    });
    await owner(async (s) => {
      const result = await categorizeApplyHandler(ports(s))({
        jobKind: "finance.categorize-apply",
        params: {
          transactionId: "metadata:chat",
          accountId: bankRow.accountId,
          month: "2026-10",
          categoryId: "dining"
        }
      });
      expect(result.status).toBe("ok");
      expect(result.transaction).not.toHaveProperty("writeRevision");
    });
    expect((await activity()).length).toBe(count + 3);
  });
});

it("retains category Undo for the confirmed native single-row bulk writer", async () => {
  await seed("metadata:native-undo");
  const before = await read("metadata:native-undo");
  expect(
    await owner((s) =>
      s.bulk!.categorize([{ id: before.id, writeRevision: before.writeRevision }], "dining")
    )
  ).toBe(true);
  const action = (await activity()).find((a) => a.params.transactionId === before.id)!;
  expect(action.undo).toMatchObject({ categoryId: "groceries", transactionId: before.id });
  const current = await read(before.id);
  expect(await owner((s) => s.metadata!.undo(action.id, current.writeRevision, at))).toBe(true);
  expect(await read(before.id)).toMatchObject({
    categoryId: before.categoryId,
    amountCents: before.amountCents,
    notes: before.notes
  });
});

describe("committed provider pending handoffs", () => {
  const twoPages = async (cursor: string | null) =>
    cursor === "middle"
      ? feedPage({ added: [handoffPosted] })
      : feedPage({
          removed: [{ transaction_id: handoffPending.id }],
          nextCursor: "middle",
          hasMore: true
        });
  const postedRows = async (feed: ReturnType<typeof providerFeed>) =>
    (await feed.store.getTransactionChunk(handoffAccount, "2026-10")) ?? [];
  const captured = (feed: ReturnType<typeof providerFeed>) =>
    feed.store.providerHandoffs!.load(handoffItem, [handoffPending.id]);
  const expectSettled = async (feed: ReturnType<typeof providerFeed>) => {
    expect(await postedRows(feed)).toEqual([
      expect.objectContaining({
        id: handoffPosted.transaction_id,
        amountCents: 1200,
        categoryId: "groceries",
        notes: handoffPending.notes,
        reviewState: "needs_look"
      })
    ]);
    expect(await feed.store.getTransactionChunk(handoffAccount, "2026-09")).toBe(null);
    expect(await captured(feed)).toEqual([]);
    expect(await feed.kv.get(NS.connections, `cursor:${handoffItem}`)).toEqual({
      cursor: "complete"
    });
  };
  beforeEach(async () => {
    await runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query("DELETE FROM app.finance_provider_handoffs WHERE item_id=$1", [handoffItem]);
      await rpc.query("DELETE FROM app.finance_transactions WHERE account_id=ANY($1::text[])", [
        [handoffAccount, "handoff-other-account"]
      ]);
      await rpc.query("DELETE FROM app.finance_accounts WHERE account_id=ANY($1::text[])", [
        [handoffAccount, "handoff-other-account"]
      ]);
      await rpc.query("DELETE FROM app.finance_items WHERE item_id=$1", [handoffItem]);
    });
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    await feed.kv.delete(NS.connections, `cursor:${handoffItem}`);
    await feed.seed();
  });
  it("preserves user metadata across a removal-first page, exact money and a replayed update", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    expect(await feed.run()).toMatchObject({
      status: "ok",
      items: [expect.objectContaining({ status: "connected", pages: 2 })]
    });
    await expectSettled(feed);
    const before = await postedRows(feed);
    await feed.run();
    expect(await postedRows(feed)).toEqual(before);
  });
  it.each(["chunk", "mirror", "cursor"] as const)(
    "recovers an independently committed %s failure without losing private metadata",
    async (fault) => {
      let failed = false;
      const fail = () => {
        failed = true;
        throw new Error("Synthetic committed handoff interruption");
      };
      const feed = providerFeed(db, ids.userA, {
        page: twoPages,
        beforeQuery: (text) => {
          if (
            !failed &&
            fault === "chunk" &&
            text.startsWith("INSERT INTO app.finance_transactions")
          )
            fail();
        },
        beforeMirror: (_key, value) => {
          if (!failed && fault === "mirror" && Array.isArray(value.transactions)) fail();
        },
        beforeSet: (key) => {
          if (!failed && fault === "cursor" && key === `cursor:${handoffItem}`) fail();
        }
      });
      await feed.store.putAccount({
        ...(await feed.store.getAccount(handoffAccount))!,
        sharedToHousehold: true
      });
      await expect(feed.run()).rejects.toThrow("Synthetic committed handoff interruption");
      expect(failed).toBe(true);
      expect(await captured(feed)).toEqual([
        expect.objectContaining({ id: handoffPending.id, notes: handoffPending.notes })
      ]);
      await feed.run();
      await expectSettled(feed);
      expect(JSON.stringify([...feed.mirrors.values()])).not.toContain(handoffPending.notes);
      expect(
        [...feed.mirrors.values()].flatMap((v) =>
          Array.isArray(v.transactions) ? v.transactions : []
        )
      ).toEqual([
        expect.objectContaining({ id: handoffPosted.transaction_id, categoryId: "groceries" })
      ]);
    }
  );
  it("retains the handoff across the 100-page limit and a subsequent pagination restart", async () => {
    let restart = false;
    const feed = providerFeed(db, ids.userA, {
      page: async (cursor) => {
        if (cursor === "c100") {
          restart = true;
          throw new PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400);
        }
        if (restart) return feedPage({ added: [handoffPosted] });
        const index = cursor ? Number(cursor.slice(1)) : 0;
        return feedPage({
          ...(index === 0 ? { removed: [{ transaction_id: handoffPending.id }] } : {}),
          nextCursor: `c${index + 1}`,
          hasMore: true
        });
      }
    });
    expect(await feed.run()).toMatchObject({ items: [expect.objectContaining({ pages: 100 })] });
    expect(await captured(feed)).toHaveLength(1);
    expect(await feed.kv.get(NS.connections, `cursor:${handoffItem}`)).toEqual({
      cursor: "c100",
      paginationStart: null
    });
    await feed.run();
    await expectSettled(feed);
  });
  it("preserves a newer posted user review after the final cursor write fails", async () => {
    let failed = false;
    const feed = providerFeed(db, ids.userA, {
      page: twoPages,
      beforeSet: (key, value) => {
        if (!failed && key === `cursor:${handoffItem}` && value.cursor === "complete") {
          failed = true;
          throw new Error("Synthetic final checkpoint interruption");
        }
      }
    });
    await expect(feed.run()).rejects.toThrow("Synthetic final checkpoint interruption");
    expect(await captured(feed)).toEqual([]);
    const row = (await feed.store.metadata!.rows(handoffAccount, "2026-10"))[0]!;
    expect(
      await feed.store.metadata!.apply(
        [
          {
            id: row.id,
            writeRevision: row.writeRevision,
            categoryId: "dining",
            notes: "Synthetic newer posted choice"
          }
        ],
        "user",
        at
      )
    ).toBe(true);
    await feed.run();
    expect(await postedRows(feed)).toEqual([
      expect.objectContaining({
        id: handoffPosted.transaction_id,
        amountCents: 1200,
        categoryId: "dining",
        notes: "Synthetic newer posted choice",
        reviewState: "confirmed"
      })
    ]);
    expect(await feed.kv.get(NS.connections, `cursor:${handoffItem}`)).toEqual({
      cursor: "complete"
    });
  });
  it("clears an unmatched pending authorization at completion without resurrecting it", async () => {
    const feed = providerFeed(db, ids.userA, {
      page: async () => feedPage({ removed: [{ transaction_id: handoffPending.id }] })
    });
    await feed.run();
    expect(await feed.store.getTransactionChunk(handoffAccount, "2026-09")).toBe(null);
    expect(await captured(feed)).toEqual([]);
  });
  it("uses an exact older source month without amount-based matching", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    await feed.store.putTransaction({ ...handoffPending, date: "2026-07-31" });
    await feed.run();
    await expectSettled(feed);
    expect(await feed.store.getTransactionChunk(handoffAccount, "2026-07")).toBe(null);
  });
  it.each(["USD", "EUR"])(
    "retains split allocations for repair after a changed %s settlement",
    async (currency) => {
      const splitId = "handoff:split-pending";
      const feed = providerFeed(db, ids.userA, {
        page: async (cursor) =>
          cursor === "middle"
            ? feedPage({
                added: [
                  { ...handoffPosted, pending_transaction_id: splitId, iso_currency_code: currency }
                ]
              })
            : feedPage({
                removed: [{ transaction_id: splitId }],
                nextCursor: "middle",
                hasMore: true
              })
      });
      const splits = [
        { categoryId: "groceries", amountCents: 500 },
        { categoryId: "dining", amountCents: 500 }
      ];
      // Legacy pending-split fixture: insert a new source. Normal pending split edits stay prohibited.
      await feed.store.putTransaction({ ...handoffPending, id: splitId, categoryId: null, splits });
      expect(
        (await feed.store.getTransactionChunk(handoffAccount, "2026-09"))!.find(
          (row) => row.id === splitId
        )!.splits
      ).toEqual(splits);
      await feed.run();
      expect(await postedRows(feed)).toEqual([
        expect.objectContaining({
          amountCents: 1200,
          isoCurrency: currency,
          splits,
          categoryId: null,
          notes: handoffPending.notes,
          reviewState: "needs_look"
        })
      ]);
      expect(await feed.store.providerHandoffs!.load(handoffItem, [splitId])).toEqual([]);
    }
  );
  it("does not capture posted, different-account or different-item sources", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    const secondAccount = {
      ...(await feed.store.getAccount(handoffAccount))!,
      accountId: "handoff-other-account"
    };
    await feed.store.putAccount(secondAccount);
    await feed.store.putTransaction({
      ...handoffPending,
      id: "handoff:other-account",
      accountId: secondAccount.accountId
    });
    await feed.store.putTransaction({
      ...handoffPending,
      id: "handoff:already-posted",
      pending: false
    });
    const protectedRows = await feed.store.getTransactionChunk(handoffAccount, "2026-09");
    await feed.store.providerHandoffs!.capture(
      handoffItem,
      [],
      [
        { id: "handoff:other-account", accountId: handoffAccount },
        { id: "handoff:already-posted", accountId: handoffAccount }
      ],
      at
    );
    await feed.store.providerHandoffs!.capture("handoff-other-item", [handoffPending.id], [], at);
    expect(await feed.store.getTransactionChunk(handoffAccount, "2026-09")).toEqual(protectedRows);
    expect(await feed.store.getTransactionChunk(secondAccount.accountId, "2026-09")).toHaveLength(
      1
    );
    expect(await captured(feed)).toEqual([]);
  });
  it("refuses a stale pending metadata edit after canonical capture", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    const row = (await feed.store.metadata!.rows(handoffAccount, "2026-09"))[0]!;
    await feed.store.providerHandoffs!.capture(handoffItem, [handoffPending.id], [], at);
    expect(
      await feed.store.metadata!.apply(
        [
          {
            id: row.id,
            writeRevision: row.writeRevision,
            categoryId: "dining",
            notes: "Synthetic stale edit"
          }
        ],
        "user",
        at
      )
    ).toBe(false);
    expect(await captured(feed)).toEqual([
      expect.objectContaining({ notes: handoffPending.notes })
    ]);
  });
  it("rolls back source removal if its durable snapshot cannot commit", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    // Explicit malformed legacy fixture: an account outlives its deleted connection item.
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "DELETE FROM app.finance_items WHERE item_id=$1",
        [handoffItem]
      )
    );
    await expect(
      feed.store.providerHandoffs!.capture(handoffItem, [handoffPending.id], [], at)
    ).rejects.toThrow();
    expect(await feed.store.getTransactionChunk(handoffAccount, "2026-09")).toEqual([
      expect.objectContaining(handoffPending)
    ]);
    expect(await captured(feed)).toEqual([]);
  });
  it("captures the latest committed pending user fields while a metadata edit holds its row", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    let held!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      held = resolve;
    });
    const continueEdit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const edit = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      // Explicit synthetic holder for the canonical pending metadata row; no financial fields change.
      await createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_transactions SET notes='Synthetic latest pending context' WHERE id=$1",
        [handoffPending.id]
      );
      held();
      await continueEdit;
    });
    await entered;
    const capture = feed.store.providerHandoffs!.capture(handoffItem, [handoffPending.id], [], at);
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        const result = await observer.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE $1",
          ["%WITH pending AS MATERIALIZED%"]
        );
        if (result.rows[0].n > 0) {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
    } finally {
      release();
      await Promise.all([edit, capture]);
      await observer.end();
    }
    expect(waiting, "Capture reached the held canonical row lock").toBe(true);
    expect(await captured(feed)).toEqual([
      expect.objectContaining({ notes: "Synthetic latest pending context" })
    ]);
  });
  it("keeps snapshot content private from another owner and an admin", async () => {
    const feed = providerFeed(db, ids.userA, { page: twoPages });
    await feed.store.providerHandoffs!.capture(handoffItem, [handoffPending.id], [], at);
    const negative = process.env.MOSS_FINANCE_HANDOFF_RLS_NEGATIVE === "1";
    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      if (negative)
        await bootstrap.query(
          "ALTER TABLE app.finance_provider_handoffs DISABLE ROW LEVEL SECURITY"
        );
      for (const actor of [ids.userB, ids.adminUser]) {
        const foreign = providerFeed(db, actor, { page: twoPages });
        expect(
          await foreign.store.providerHandoffs!.load(handoffItem, [handoffPending.id])
        ).toEqual([]);
        await foreign.store.providerHandoffs!.clear(handoffItem);
      }
      expect(await captured(feed)).toHaveLength(1);
    } finally {
      if (negative)
        await bootstrap.query(
          "ALTER TABLE app.finance_provider_handoffs ENABLE ROW LEVEL SECURITY; ALTER TABLE app.finance_provider_handoffs FORCE ROW LEVEL SECURITY"
        );
      await bootstrap.end();
    }
  });
});
