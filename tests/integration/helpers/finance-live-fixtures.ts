import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import {
  NS,
  sqlStore,
  type FinanceDb
} from "../../../external-modules/finance/src/domain/index.js";

export async function seedFinanceLive(
  workerDb: Kysely<MossDatabase>,
  appDb: Kysely<MossDatabase>,
  owner: { userId: string },
  member: { userId: string },
  month: string
) {
  await new DataContextRunner(workerDb).withDataContext(
    { actorUserId: owner.userId },
    async (scope) => {
      await sql`select set_config('app.current_module_id', 'finance', true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      const db: FinanceDb = {
        query: async (text, params) => {
          const result = await rpc.query(text, params);
          return { rows: [...result.rows] } as never;
        }
      };
      const store = sqlStore(db);
      await store.putItem({
        itemId: "synthetic-bank",
        institutionId: null,
        institutionName: "Synthetic bank",
        connectedAt: `${month}-01T00:00:00Z`,
        status: "connected"
      });
      await store.putAccount({
        accountId: "synthetic-cash",
        itemId: "synthetic-bank",
        name: "Synthetic checking",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: "0000",
        balanceCents: 100000,
        isoCurrency: "USD",
        updatedAt: `${month}-01T00:00:00Z`
      });
      await store.putTransaction({
        id: "synthetic-market",
        accountId: "synthetic-cash",
        date: `${month}-01`,
        name: "Synthetic weekend market",
        amountCents: 8243,
        isoCurrency: "USD",
        merchant: null,
        plaidCategory: null,
        categoryId: "groceries",
        pending: false,
        pendingTransactionId: null,
        categorizedBy: "user"
      });
      await setModuleKvValue(
        scope,
        {
          moduleId: "finance",
          namespace: NS.meta,
          scope: "user",
          ownerUserId: owner.userId,
          key: "storage:migrated"
        },
        { at: new Date().toISOString() }
      );
    }
  );
  // A second synthetic owner has legacy assignments and two currencies; no real bank is used.
  await new DataContextRunner(appDb).withDataContext(
    { actorUserId: member.userId },
    async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      const store = sqlStore({
        query: async (text, params) => ({
          rows: [...(await rpc.query(text, params)).rows] as never[]
        })
      });
      for (const isoCurrency of ["EUR", "USD"]) {
        await store.manual!.createAccount({
          accountId: `manual:synthetic-${isoCurrency}`,
          name: `Synthetic ${isoCurrency} cash`,
          type: "other",
          subtype: "cash",
          isoCurrency,
          openingDate: `${month}-01`,
          openingBalanceCents: isoCurrency === "EUR" ? 123450 : 999999,
          digest: "a".repeat(64),
          at: `${month}-01T00:00:00Z`
        });
      }
      await store.setAssignment(month, "groceries", 2000);
      await setModuleKvValue(
        scope,
        {
          moduleId: "finance",
          namespace: NS.meta,
          scope: "user",
          ownerUserId: member.userId,
          key: "storage:migrated"
        },
        { at: new Date().toISOString() }
      );
    }
  );
}

export async function seedFirstBudget(db: Kysely<MossDatabase>, userId: string, month: string) {
  const [year, number] = month.split("-").map(Number);
  const previous =
    number === 1 ? `${year! - 1}-12` : `${year}-${String(number! - 1).padStart(2, "0")}`;
  await new DataContextRunner(db).withDataContext({ actorUserId: userId }, async (scope) => {
    const rpc = createModuleStorageRpc(scope, "finance");
    const store = sqlStore({
      query: async (text, params) => ({
        rows: [...(await rpc.query(text, params)).rows] as never[]
      })
    });
    const accountId = "manual:synthetic-first-budget";
    await store.manual!.createAccount({
      accountId,
      name: "Synthetic first budget cash",
      type: "depository",
      subtype: "checking",
      isoCurrency: "USD",
      openingDate: `${previous}-01`,
      openingBalanceCents: 500000,
      digest: "a".repeat(64),
      at: `${month}-01T00:00:00Z`
    });
    for (const [id, amountCents, categoryId] of [
      ["income", -400000, "income"],
      ["groceries", 30000, "groceries"]
    ] as const) {
      await store.manual!.createEntry({
        id: `manual:synthetic-first-${id}`,
        accountId,
        date: `${previous}-15`,
        name: `Synthetic ${id}`,
        amountCents,
        categoryId,
        isoCurrency: "USD",
        notes: "",
        cleared: true,
        digest: (id === "income" ? "b" : "c").repeat(64),
        at: `${month}-01T00:00:00Z`
      });
    }
    await setModuleKvValue(
      scope,
      {
        moduleId: "finance",
        namespace: NS.meta,
        scope: "user",
        ownerUserId: userId,
        key: "storage:migrated"
      },
      { at: new Date().toISOString() }
    );
  });
}
