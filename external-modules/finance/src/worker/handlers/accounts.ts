// external-modules/finance/src/worker/handlers/accounts.ts
//
// FIN-01 (#1146) Task 7: finance.accounts.list — the read tool behind "what
// are my balances". Pure store read (accounts joined with each account's
// item record for status/institution — FIN-06c #1166 Task 8 moved this off
// KV onto the store port); never builds a Plaid client and never touches the
// token map. Balances are as-of the last sync (updatedAt says when), which is
// the module's design: reads are instant, freshness comes from the 6-hour
// sweep or finance.sync.run-now.
//
// FIN-04 (#1149) Task 5: the same read also merges OTHER owners' shared
// accounts from the finance.shared mirror, appended after own accounts and
// tagged { ownerUserId, shared: true }. The actor's own mirror prefix is
// skipped — their user-scoped records above are authoritative. Read-risk
// tool: the mirror is only ever list/get here (the host rejects mutation
// from read tools with forbidden_kv_mutation).
import { parseSharedKey } from "../../domain/index.js";
import type { ItemRecord, SharedAccountMeta } from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { readString } from "../validate.js";

type AccountView = {
  accountId: string;
  itemId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  balanceCents: number;
  isoCurrency: string;
  institutionId: string | null;
  itemStatus: ItemRecord["status"];
  updatedAt: string;
  // FIN-04 (#1149): the web share toggle renders off this flag.
  sharedToHousehold: boolean;
};

/**
 * One connected bank (Plaid item) for the Accounts screen. `message` is the
 * stored Plaid display message from the last failure (#3161), null when the
 * bank is healthy or no message was stored.
 */
export type BankView = {
  itemId: string;
  institutionId: string | null;
  institutionName: string | null;
  status: ItemRecord["status"];
  lastSyncAt: string | null;
  message: string | null;
};

// Household view of someone else's account: the mirror meta allowlist minus
// officialName (own views drop it too) — deliberately no itemStatus or
// institutionId, which never enter the mirror (Plaid plumbing).
type SharedAccountView = {
  accountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  balanceCents: number;
  isoCurrency: string;
  updatedAt: string;
  ownerUserId: string;
  shared: true;
};

async function listSharedAccounts(
  ports: WorkerPorts,
  actorUserId: string
): Promise<SharedAccountView[]> {
  const shared: SharedAccountView[] = [];
  for (const key of await ports.mirror.list()) {
    const parsed = parseSharedKey(key);
    // Tolerate junk keys and non-meta suffixes (month chunks) silently — the
    // mirror is a disposable projection, not a place to throw from a read.
    if (!parsed || parsed.suffix !== "meta") continue;
    if (parsed.ownerUserId === actorUserId) continue;
    const stored = (await ports.mirror.get(key)) as SharedAccountMeta | null;
    if (!stored || typeof stored.accountId !== "string" || typeof stored.name !== "string") {
      continue;
    }
    shared.push({
      // Allowlist copy, field by field — never spread mirror values into a
      // response (same posture as the shared-pool projectors).
      accountId: stored.accountId,
      name: stored.name,
      mask: stored.mask ?? null,
      type: stored.type,
      subtype: stored.subtype ?? null,
      balanceCents: stored.balanceCents,
      isoCurrency: stored.isoCurrency,
      updatedAt: stored.updatedAt,
      // Attribution comes from the KEY prefix, not the stored value — the
      // key is what the write policy scoped; the value could drift.
      ownerUserId: parsed.ownerUserId,
      shared: true
    });
  }
  shared.sort((a, b) =>
    a.accountId !== b.accountId
      ? a.accountId < b.accountId
        ? -1
        : 1
      : a.ownerUserId < b.ownerUserId
        ? -1
        : a.ownerUserId > b.ownerUserId
          ? 1
          : 0
  );
  return shared;
}

export const accountsListHandler: ToolFactory = (ports) => async (input) => {
  // Host-injected at the dispatch chokepoint (spread LAST over tool input)
  // and host-bound on queue envelopes — never caller-controlled (#1149).
  const actorUserId = readString(input, "actorUserId", { required: true });

  // FIN-06c (#1166) Task 8: one store call replaces the list+get loop — the
  // store port already returns full records, so the old "deleted between
  // list and get" race no longer applies.
  const store = await ports.store();
  const accountRecords = await store.listAccounts();

  // Item records are few (one per bank); memoize per itemId so a bank with
  // many accounts costs one connections read.
  const itemCache = new Map<string, ItemRecord | null>();
  const loadItem = async (itemId: string): Promise<ItemRecord | null> => {
    if (!itemCache.has(itemId)) {
      itemCache.set(itemId, await store.getItem(itemId));
    }
    return itemCache.get(itemId)!;
  };

  const own: AccountView[] = [];
  for (const account of accountRecords) {
    const item = await loadItem(account.itemId);
    own.push({
      accountId: account.accountId,
      itemId: account.itemId,
      name: account.name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      balanceCents: account.balanceCents,
      isoCurrency: account.isoCurrency,
      // Orphaned account (item record gone) is surfaced as an error rather
      // than hidden — hiding money is worse than showing a broken link.
      institutionId: item?.institutionId ?? null,
      itemStatus: item?.status ?? "error",
      updatedAt: account.updatedAt,
      sharedToHousehold: account.sharedToHousehold === true
    });
  }
  // store.listAccounts() order is storage-dependent; pin a stable order.
  own.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

  // One entry per bank that holds an own account, ordered by itemId. An
  // orphaned account (no item record) reports status "error" like its row.
  const banks: BankView[] = [...new Set(own.map((account) => account.itemId))]
    .sort()
    .map((itemId) => {
      const item = itemCache.get(itemId) ?? null;
      return {
        itemId,
        institutionId: item?.institutionId ?? null,
        institutionName: item?.institutionName ?? null,
        status: item?.status ?? "error",
        lastSyncAt: item?.lastSyncAt ?? null,
        message: item?.lastErrorDetail?.message ?? null
      };
    });

  const accounts: (AccountView | SharedAccountView)[] = [
    ...own,
    ...(await listSharedAccounts(ports, actorUserId))
  ];
  // nextStep keys off OWN accounts: a member seeing only shared accounts
  // still hasn't connected a bank of their own.
  return own.length === 0
    ? { accounts, banks, nextStep: "connect a bank with finance.connect.start" }
    : { accounts, banks };
};
