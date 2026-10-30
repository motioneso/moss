import { sql, type Kysely } from "kysely";
import {
  createModuleStorageRpc,
  DataContextRunner,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  getModuleKvValue,
  setModuleKvValue,
  deleteModuleKvKey,
  listModuleKvKeys
} from "@moss/settings";
import {
  NS,
  sqlStore,
  type FinanceDb,
  type FinanceKv,
  type TransactionRecord
} from "../../../external-modules/finance/src/domain/index.js";
import type { PlaidClient, PlaidTx } from "../../../external-modules/finance/src/adapters/plaid.js";
import type { WorkerPorts } from "../../../external-modules/finance/src/worker/ports.js";
import { syncRunHandler } from "../../../external-modules/finance/src/worker/handlers/sync.js";
export const handoffItem = "handoff-synthetic-item",
  handoffAccount = "handoff-synthetic-checking";
export const handoffPending: TransactionRecord = {
  id: "handoff:pending",
  accountId: handoffAccount,
  date: "2026-09-30",
  amountCents: 1000,
  isoCurrency: "USD",
  name: "Synthetic pending market",
  merchant: null,
  plaidCategory: null,
  categoryId: "groceries",
  pending: true,
  pendingTransactionId: null,
  categorizedBy: "user",
  reviewState: "confirmed",
  notes: "Synthetic private pending context"
};
export const handoffPosted: PlaidTx = {
  transaction_id: "handoff:posted",
  account_id: handoffAccount,
  date: "2026-10-01",
  amount: 12,
  iso_currency_code: "USD",
  name: "Synthetic settled market",
  merchant_name: null,
  personal_finance_category: null,
  pending: false,
  pending_transaction_id: handoffPending.id
};
export type FeedPage = Awaited<ReturnType<PlaidClient["transactionsSync"]>>;
export const feedPage = (over: Partial<FeedPage> = {}): FeedPage => ({
  added: [],
  modified: [],
  removed: [],
  nextCursor: "complete",
  hasMore: false,
  ...over
});
/** Fake provider/credential ports only. Each actual SQL/KV RPC commits independently. */
export function providerFeed(
  db: Kysely<MossDatabase>,
  actor: string,
  options: {
    page: (cursor: string | null) => Promise<FeedPage>;
    beforeQuery?: (text: string) => void;
    beforeSet?: (key: string, value: Record<string, unknown>) => void;
    beforeMirror?: (key: string, value: Record<string, unknown>) => void;
  }
) {
  const runner = new DataContextRunner(db);
  const port: FinanceDb = {
    query: async (text, params) => {
      options.beforeQuery?.(text);
      return runner.withDataContext({ actorUserId: actor }, async (scope) => ({
        rows: [
          ...(await createModuleStorageRpc(scope, "finance").query(text, params)).rows
        ] as never[]
      }));
    }
  };
  const store = sqlStore(port);
  const withKvContext = <T>(fn: (scope: DataContextDb) => Promise<T>) =>
    runner.withDataContext({ actorUserId: actor }, async (scope) => {
      // Match the real host's Finance module identity, including worker-role KV RLS.
      await sql`select set_config('app.current_module_id', 'finance', true)`.execute(scope.db);
      return fn(scope);
    });
  const key = (namespace: string, k: string) => ({
    moduleId: "finance",
    namespace,
    scope: "user" as const,
    ownerUserId: actor,
    key: k
  });
  const kv: FinanceKv = {
    get: (namespace, k) => withKvContext((scope) => getModuleKvValue(scope, key(namespace, k))),
    set: async (namespace, k, value) => {
      options.beforeSet?.(k, value);
      await withKvContext((scope) => setModuleKvValue(scope, key(namespace, k), value));
    },
    delete: (namespace, k) => withKvContext((scope) => deleteModuleKvKey(scope, key(namespace, k))),
    list: (namespace) =>
      withKvContext((scope) =>
        listModuleKvKeys(scope, {
          moduleId: "finance",
          namespace,
          scope: "user",
          ownerUserId: actor
        })
      )
  };
  const mirrors = new Map<string, Record<string, unknown>>();
  const account = {
    accountId: handoffAccount,
    name: "Synthetic provider checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: null,
    balanceCents: 198800,
    isoCurrency: "USD"
  };
  const client = {
    accountsGet: async () => ({ institutionId: null, accounts: [account] }),
    accountsBalanceGet: async () => ({ accounts: [account] }),
    transactionsSync: async (_token: string, cursor: string | null) => options.page(cursor)
  } as unknown as PlaidClient;
  const ports = {
    kv,
    store: async () => store,
    ai: null,
    db: null,
    isAdmin: false,
    now: () => new Date("2026-10-30T12:00:00Z"),
    plaid: () => client,
    // Inert in-memory stubs: no credential slot is created or written and no network request occurs.
    creds: { get: async () => ({ clientId: "synthetic-unused", secret: "synthetic-unused" }) },
    settings: { getEnvironment: async () => "sandbox" },
    tokens: {
      read: async () => ({
        [handoffItem]: { accessToken: "synthetic-unused", institutionId: null }
      }),
      write: async () => {
        throw new Error("No credential writes in synthetic feed");
      }
    },
    mirror: {
      get: async (k: string) => mirrors.get(k) ?? null,
      set: async (k: string, value: Record<string, unknown>) => {
        options.beforeMirror?.(k, value);
        mirrors.set(k, structuredClone(value));
      },
      delete: async (k: string) => mirrors.delete(k),
      list: async () => [...mirrors.keys()]
    }
  } as unknown as WorkerPorts;
  return {
    store,
    kv,
    mirrors,
    run: () => syncRunHandler(ports)({ actorUserId: actor }),
    seed: async (shared = false) => {
      await store.budgetPolicy!.configure("USD", false, "2026-10-01T00:00:00Z");
      await store.putItem({
        itemId: handoffItem,
        institutionId: null,
        institutionName: "Synthetic provider",
        connectedAt: "2026-09-01T00:00:00Z",
        status: "connected"
      });
      await store.putAccount({
        ...account,
        balanceCents: 200000,
        itemId: handoffItem,
        updatedAt: "2026-10-01T00:00:00Z",
        ...(shared ? { sharedToHousehold: true } : {})
      });
      await store.putTransaction(handoffPending);
      await kv.set(NS.meta, "storage:migrated", { at: "2026-10-01T00:00:00Z" });
    }
  };
}
