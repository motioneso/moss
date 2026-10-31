import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import {
  sqlStore,
  type FinanceDb,
  type TransactionRecord
} from "../../../external-modules/finance/src/domain/index.js";
export async function seedReportDetails(
  db: Kysely<MossDatabase>,
  ownerId: string,
  memberId: string,
  month: string
) {
  const transaction = (id: string, extra: Partial<TransactionRecord> = {}): TransactionRecord => ({
    id,
    accountId: "synthetic-cash",
    date: `${month}-04`,
    name: "Synthetic report income",
    amountCents: -10000,
    isoCurrency: "USD",
    merchant: null,
    plaidCategory: null,
    categoryId: "income",
    pending: false,
    pendingTransactionId: null,
    categorizedBy: "user",
    notes: "Synthetic report private note",
    ...extra
  });
  for (const actorUserId of [ownerId, memberId])
    await new DataContextRunner(db).withDataContext({ actorUserId }, async (scope) => {
      await sql`select set_config('app.current_module_id','finance',true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      const port: FinanceDb = {
        query: async (text, params) => ({
          rows: [...(await rpc.query(text, params)).rows] as never[]
        })
      };
      const store = sqlStore(port);
      if (actorUserId === ownerId) {
        await store.putTransaction(transaction("report:income"));
        await store.putTransaction(
          transaction("report:pending", {
            name: "Synthetic pending expense",
            amountCents: 345,
            categoryId: "groceries",
            pending: true
          })
        );
        await store.putAccount({
          accountId: "synthetic-eur",
          itemId: null,
          name: "Synthetic EUR tracking",
          officialName: null,
          type: "other",
          subtype: "asset",
          mask: null,
          balanceCents: 10000,
          isoCurrency: "EUR",
          updatedAt: `${month}-04T00:00:00Z`
        });
        await store.putTransaction(
          transaction("report:eur", {
            accountId: "synthetic-eur",
            name: "Synthetic EUR expense",
            isoCurrency: "EUR",
            amountCents: 999,
            categoryId: "groceries"
          })
        );
      } else {
        const shared = transaction("report:shared", {
          accountId: "synthetic-shared",
          name: "Synthetic household groceries",
          amountCents: 700,
          categoryId: "groceries",
          notes: "Synthetic malformed-mirror private note"
        });
        await store.putTransaction(shared);
        await store.putTransaction(
          transaction("report:member-private", {
            name: "Synthetic member private purchase",
            amountCents: 40000,
            categoryId: "groceries"
          })
        );
        for (const [key, value] of [
          [`${memberId}:synthetic-shared:${month}`, { transactions: [shared] }],
          [
            `${memberId}:synthetic-shared:meta`,
            {
              accountId: "synthetic-shared",
              ownerUserId: memberId,
              name: "Synthetic shared cash",
              officialName: null,
              type: "depository",
              subtype: "checking",
              mask: null,
              balanceCents: 50000,
              isoCurrency: "USD",
              updatedAt: `${month}-04T00:00:00Z`
            }
          ]
        ] as const)
          await setModuleKvValue(
            scope,
            {
              moduleId: "finance",
              namespace: "finance.shared",
              scope: "instance",
              ownerUserId: null,
              key
            },
            value
          );
      }
    });
}
