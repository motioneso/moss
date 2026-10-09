// external-modules/finance/src/worker/handlers/sync.ts
//
// FIN-01 (#1146) Task 6: the sync engine. ONE handler serves both the
// finance.sync-run queue (posted by the finance.sync-sweep schedule) and the
// finance.sync.run-now assistant tool (D3) — the queue's one-job-per-user
// singleton policy is what serializes token-map and chunk access, so the
// handler itself stays a plain sequential loop over connected items.
//
// Durability model: /transactions/sync pages are applied via the pure,
// idempotent reducer (domain/reduce.ts) and the item's cursor is persisted
// only AFTER that page's chunks are written. A crash between the two writes
// replays the page on the next run; the reducer makes the replay a no-op.
import { randomUUID } from "node:crypto";
import { PlaidError } from "../../adapters/plaid.js";
import { FinanceFetchError } from "../../adapters/types.js";
import type { PlaidAccount } from "../../adapters/plaid.js";
import type {
  AccountRecord,
  Category,
  CategorizeAi,
  ChunkMap,
  FinanceKv,
  FinanceStore,
  ItemRecord,
  ReviewPolicy,
  TransactionRecord,
  Rule,
  SortingTier
} from "../../domain/index.js";
import {
  categorize,
  cursorKey,
  DEFAULT_CATEGORIES,
  monthKey,
  normalizePayee,
  NS,
  parseSharedKey,
  prevMonthKey,
  reduceSyncPage,
  sharedMetaKey,
  sharedMonthKey,
  sharedOwnerPrefix,
  toSharedAccountMeta,
  toSharedChunk
} from "../../domain/index.js";
import { buildCategorizeAi } from "../ai-port.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
import { buildPlaid, loadItems } from "./connect.js";

// Plaid pages are capped at count:100 (adapter), so 100 pages = 10000
// transactions per item per run — far above a personal account's churn, low
// enough to bound a runaway loop. Progress is durable (cursor per page), so
// a truncated run simply resumes at the next sweep.
const MAX_PAGES_PER_RUN = 100;

// Plaid invalidates a pagination run when the data changes under it; the
// documented recovery is to restart from the cursor the run began with.
const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
const MAX_PAGINATION_RESTARTS = 3;

// Best-effort lease so the connect poll's first sync and the queued sync never
// write the same months at once. KV has no compare-and-set, so this narrows
// the window rather than closing it; a stale lease expires.
const SYNC_LEASE_KEY = "lock:sync";
const SYNC_LEASE_MS = 15 * 60 * 1000;

type ItemResult = {
  itemId: string;
  status: ItemRecord["status"];
  added: number;
  modified: number;
  removed: number;
  pages: number;
};

type BalanceFailure = {
  code: string;
  type: string | null;
  message: string | null;
  requestId: string | null;
};
type ItemSyncOutcome = Omit<ItemResult, "itemId" | "status"> & { balanceFailure?: BalanceFailure };

/** Loaded once per run and shared across items/pages. */
type CategorizeCtx = {
  rules: Rule[];
  categories: Category[];
  ai: CategorizeAi | null;
  review: ReviewPolicy;
};

/** Fail closed: an unreadable tier means Moss asks instead of confirming. */
async function readTier(ports: WorkerPorts, familyId: string): Promise<SortingTier> {
  try {
    return (await ports.actionPolicy?.get(familyId)) ?? "ask_each_time";
  } catch {
    return "ask_each_time";
  }
}

/** Merchants with confirmed, categorized history, keyed like payee rules. */
async function loadSeenPayeeKeys(store: FinanceStore): Promise<Set<string>> {
  return new Set((await store.listConfirmedPayeeNames()).map(normalizePayee));
}

/**
 * FIN-02 (#1147) Task 9: load the categorization inputs, seeding the default
 * taxonomy on first read — the feed and rules always need a category list to
 * resolve against, and seeding here (the only writer besides the user's own
 * edits) keeps the read path elsewhere side-effect free.
 */
async function loadCategorizeCtx(ports: WorkerPorts, store: FinanceStore): Promise<CategorizeCtx> {
  let stored = (await ports.kv.get(NS.categories, "taxonomy")) as {
    categories: Category[];
  } | null;
  if (stored === null) {
    stored = { categories: [...DEFAULT_CATEGORIES] };
    await ports.kv.set(NS.categories, "taxonomy", stored);
  }
  const rules: Rule[] = [];
  for (const key of await ports.kv.list(NS.rules)) {
    const rule = await ports.kv.get(NS.rules, key);
    if (rule) rules.push(rule as Rule);
  }
  return {
    rules,
    categories: stored.categories,
    ai: buildCategorizeAi(ports.ai),
    review: {
      sortingTier: await readTier(ports, "sorting"),
      sortingNewTier: await readTier(ports, "sorting_new"),
      seenPayeeKeys: await loadSeenPayeeKeys(store)
    }
  };
}

/**
 * Run the pipeline over every record in this page's touched chunks. Settled
 * records (user/prior-run) pass through untouched, so replaying a page stays
 * idempotent; AI failure leaves records uncategorized without blocking sync.
 */
async function categorizeChunks(
  chunks: ChunkMap,
  touched: readonly string[],
  ctx: CategorizeCtx
): Promise<{ chunks: ChunkMap; autoConfirmed: TransactionRecord[] }> {
  const records = touched.flatMap((key) => chunks[key]?.transactions ?? []);
  const before = new Map(records.map((record) => [record.id, record]));
  const updated = await categorize(records, ctx.rules, ctx.categories, ctx.ai, ctx.review);
  const byId = new Map(updated.map((record) => [record.id, record]));
  // Moss's own confirmations: a Plaid-map or AI guess it settled without asking.
  const autoConfirmed = updated.filter(
    (record) =>
      before.get(record.id)?.categoryId === null &&
      record.categoryId !== null &&
      record.reviewState === "confirmed" &&
      (record.categorizedBy === "ai" || record.categorizedBy === "plaid-map")
  );
  const next: ChunkMap = { ...chunks };
  for (const key of touched) {
    next[key] = {
      transactions: (chunks[key]?.transactions ?? []).map((record) => byId.get(record.id) ?? record)
    };
  }
  return { chunks: next, autoConfirmed };
}

async function readCursorRecord(
  kv: FinanceKv,
  itemId: string
): Promise<{ cursor: string | null; paginationStart?: string | null }> {
  const record = await kv.get(NS.connections, cursorKey(itemId));
  const cursor = typeof record?.cursor === "string" ? record.cursor : null;
  if (record && "paginationStart" in record) {
    const start = typeof record.paginationStart === "string" ? record.paginationStart : null;
    return { cursor, paginationStart: start };
  }
  return { cursor };
}

/** Write today's balance into the account's month snapshot, once per day. */
async function appendSnapshots(
  store: FinanceStore,
  accounts: { accountId: string; balanceCents: number }[],
  today: string
): Promise<void> {
  const month = today.slice(0, 7);
  for (const account of accounts) {
    const days = (await store.getSnapshotChunk(account.accountId, month)) ?? {};
    // First write of the day wins: the sweep runs every 6 hours and run-now
    // is user-triggered — re-recording would rewrite history mid-day.
    if (days[today] !== undefined) continue;
    await store.putSnapshotChunk(account.accountId, month, {
      ...days,
      [today]: account.balanceCents
    });
  }
}

async function syncItem(
  ports: WorkerPorts,
  store: FinanceStore,
  plaid: Awaited<ReturnType<typeof buildPlaid>>,
  item: ItemRecord,
  accessToken: string,
  categorizeCtx: CategorizeCtx,
  actorUserId: string
): Promise<ItemSyncOutcome> {
  const nowIso = ports.now().toISOString();
  const today = nowIso.slice(0, 10);

  // Balances first: cheap, and the feed's account cards should be fresh
  // even when the transaction loop later truncates at the page bound. The
  // live balance product is not enabled for every Plaid client (it fails with
  // INVALID_PRODUCT), so any failure except a real login problem falls back
  // to the balances the plain accounts lookup already returns.
  let accounts: PlaidAccount[];
  let balanceFailure: BalanceFailure | undefined;
  try {
    accounts = (await plaid.accountsBalanceGet(accessToken)).accounts;
  } catch (error) {
    if (error instanceof PlaidError && error.code !== "ITEM_LOGIN_REQUIRED") {
      console.warn(
        `finance.sync balance_fallback item=${item.itemId} code=${error.code} http=${error.httpStatus}`
      );
      balanceFailure = { code: error.code, ...error.detail };
    } else if (error instanceof FinanceFetchError) {
      console.warn(`finance.sync balance_fallback item=${item.itemId} code=${error.code}`);
      balanceFailure = { code: error.code, type: null, message: null, requestId: null };
    } else {
      throw error;
    }
    accounts = (await plaid.accountsGet(accessToken)).accounts;
  }
  // Accounts this item shares to the household — drives the mirror writes
  // below (FIN-04 #1149).
  const sharedIds = new Set<string>();
  for (const account of accounts) {
    // The raw Plaid row knows nothing about sharing: read the stored record
    // first and carry the flag forward, or every sweep would silently
    // unshare the account (FIN-04 #1149 — bug found in Task 4 grounding).
    const stored = await store.getAccount(account.accountId);
    const sharedToHousehold = stored?.sharedToHousehold === true;
    const record: AccountRecord = {
      ...account,
      itemId: item.itemId,
      updatedAt: nowIso,
      ...(sharedToHousehold ? { sharedToHousehold: true } : {})
    };
    await store.putAccount(record);
    if (sharedToHousehold) {
      sharedIds.add(account.accountId);
      // Refresh the household meta so members see current balances.
      await ports.mirror.set(
        sharedMetaKey(actorUserId, account.accountId),
        toSharedAccountMeta(actorUserId, record)
      );
    }
  }
  await appendSnapshots(store, accounts, today);

  const stored = await readCursorRecord(ports.kv, item.itemId);
  // Plaid's recovery for a mid-pagination change is to restart from the cursor
  // the whole pagination began with, which may predate this run.
  const paginationStart =
    stored.paginationStart !== undefined ? stored.paginationStart : stored.cursor;
  let cursor = stored.cursor;
  let restarts = 0;
  let hasMore = true;
  let pages: Awaited<ReturnType<typeof plaid.transactionsSync>>[] = [];

  // Fetch first, apply after: a restart then discards pages that never
  // touched storage, so nothing from an abandoned download is left behind.
  while (hasMore && pages.length < MAX_PAGES_PER_RUN) {
    try {
      const page = await plaid.transactionsSync(accessToken, cursor);
      pages.push(page);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    } catch (error) {
      if (
        !(error instanceof PlaidError) ||
        error.code !== MUTATION_DURING_PAGINATION ||
        restarts >= MAX_PAGINATION_RESTARTS
      ) {
        throw error;
      }
      restarts += 1;
      console.warn(`finance.sync pagination_restart item=${item.itemId} attempt=${restarts}`);
      pages = [];
      cursor = paginationStart;
      hasMore = true;
    }
  }

  const counts = { added: 0, modified: 0, removed: 0, pages: 0 };
  for (const [index, page] of pages.entries()) {
    counts.pages += 1;
    // Load exactly the months this page touches, plus each month's
    // predecessor — the only chunk where a posted tx's pending twin can hide.
    // Pairs are tracked alongside the composed keys so the store RMW below
    // never has to re-derive accountId/month by parsing a chunk key (the
    // composed string format stays reduceSyncPage's internal addressing
    // only, per FIN-06c #1166 Task 8).
    const keys = new Set<string>();
    const pairs = new Map<string, { accountId: string; month: string }>();
    for (const tx of [...page.added, ...page.modified]) {
      const targetKey = monthKey(tx.account_id, tx.date);
      const prevKey = prevMonthKey(tx.account_id, tx.date);
      keys.add(targetKey);
      keys.add(prevKey);
      pairs.set(targetKey, { accountId: tx.account_id, month: targetKey.slice(-7) });
      pairs.set(prevKey, { accountId: tx.account_id, month: prevKey.slice(-7) });
    }
    // A removal names only a transaction id, so its month is unknown. Load
    // every month of this item's accounts (no stored index exists) — without
    // this, a batch of only removals would find nothing to delete.
    if (page.removed.length > 0) {
      const months = await store.listTransactionMonths();
      for (const account of accounts) {
        for (const month of months) {
          const key = `${account.accountId}:${month}`;
          keys.add(key);
          pairs.set(key, { accountId: account.accountId, month });
        }
      }
    }
    const chunks: ChunkMap = {};
    for (const key of keys) {
      const pair = pairs.get(key)!;
      const transactions = await store.getTransactionChunk(pair.accountId, pair.month);
      if (transactions) chunks[key] = { transactions };
    }

    const reduced = reduceSyncPage(chunks, page);
    const categorized = await categorizeChunks(reduced.chunks, reduced.touched, categorizeCtx);
    const next = categorized.chunks;
    for (const key of reduced.touched) {
      const pair = pairs.get(key)!;
      await store.putTransactionChunk(pair.accountId, pair.month, next[key]!.transactions);
      // FIN-04 (#1149): mirror the changed month for shared accounts as part
      // of the normal write path.
      if (sharedIds.has(pair.accountId)) {
        await ports.mirror.set(
          sharedMonthKey(actorUserId, pair.accountId, pair.month),
          toSharedChunk(next[key]!)
        );
      }
    }
    for (const record of categorized.autoConfirmed) {
      await store.appendActivity({
        actor: "moss",
        kind: "transaction.categorize",
        params: {
          transactionId: record.id,
          accountId: record.accountId,
          month: record.date.slice(0, 7),
          categoryId: record.categoryId,
          previousCategoryId: null
        },
        undo: {
          transactionId: record.id,
          accountId: record.accountId,
          month: record.date.slice(0, 7),
          categoryId: null
        }
      });
    }
    // Cursor LAST (see header): only after this page's chunks are durable.
    // The pagination start is kept while more pages remain so a later run can
    // still restart from it.
    const finished = index === pages.length - 1 && !hasMore;
    await ports.kv.set(
      NS.connections,
      cursorKey(item.itemId),
      finished ? { cursor: page.nextCursor } : { cursor: page.nextCursor, paginationStart }
    );

    counts.added += page.added.length;
    counts.modified += page.modified.length;
    counts.removed += page.removed.length;
  }
  return balanceFailure ? { ...counts, balanceFailure } : counts;
}

/**
 * FIN-04 (#1149): every sweep GCs the actor's OWN mirror prefix — delete any
 * `{actorUserId}:` key whose account is gone or no longer shared (including
 * malformed own-prefix keys). Foreign prefixes are never touched: each owner
 * self-heals their own keys, no job ever GCs another owner's. This is also
 * the healing path for a crash between the share-flag write and the mirror
 * write in applyShareFlag.
 */
async function reconcileOwnMirror(
  ports: WorkerPorts,
  store: FinanceStore,
  actorUserId: string
): Promise<void> {
  const prefix = sharedOwnerPrefix(actorUserId);
  for (const key of await ports.mirror.list()) {
    if (!key.startsWith(prefix)) continue;
    const parsed = parseSharedKey(key);
    if (parsed === null) {
      await ports.mirror.delete(key);
      continue;
    }
    const account = await store.getAccount(parsed.accountId);
    if (account?.sharedToHousehold !== true) {
      await ports.mirror.delete(key);
    }
  }
}

export const syncRunHandler: ToolFactory = (ports) => async (input) => {
  const lease = await ports.kv.get(NS.connections, SYNC_LEASE_KEY);
  const heldAt = typeof lease?.at === "number" ? lease.at : 0;
  if (ports.now().getTime() - heldAt < SYNC_LEASE_MS) {
    console.warn("finance.sync skipped_busy");
    return { status: "busy", items: [] };
  }
  // Take the lease, read it back, and proceed only if it is still ours. This
  // shrinks the race to near zero but is not atomic (KV has no compare-and-set).
  const owner = randomUUID();
  await ports.kv.set(NS.connections, SYNC_LEASE_KEY, { at: ports.now().getTime(), owner });
  const confirmed = await ports.kv.get(NS.connections, SYNC_LEASE_KEY);
  if (confirmed?.owner !== owner) {
    console.warn("finance.sync skipped_busy");
    return { status: "busy", items: [] };
  }
  try {
    return await runSync(ports, input);
  } finally {
    const current = await ports.kv.get(NS.connections, SYNC_LEASE_KEY);
    if (current?.owner === owner) await ports.kv.delete(NS.connections, SYNC_LEASE_KEY);
  }
};

const runSync: (
  ports: WorkerPorts,
  input: Record<string, unknown>
) => Promise<Record<string, unknown>> = async (ports, input) => {
  // Host-bound identity (spec delta "Host change 2"): the queue envelope and
  // the API host's tool-input injection both deliver actorUserId — required,
  // because the mirror's own-prefix contract hangs off it.
  const actorUserId = readString(input, "actorUserId", { required: true });
  const store = await ports.store();
  const items = await loadItems(store);
  if (items.length === 0) {
    // Still reconcile: removing the LAST item must not strand mirror keys.
    await reconcileOwnMirror(ports, store, actorUserId);
    return { status: "ok", items: [] };
  }

  // D5 clobber guard (same rule as connect.poll): a null token read with
  // items on record is indistinguishable from a transient credential-store
  // failure — abort the run rather than treating every item as token-less.
  const tokens = await ports.tokens.read();
  if (tokens === null) {
    throw new InputError("token_read_failed", "credential read failed; retry sync");
  }

  const plaid = await buildPlaid(ports);
  const categorizeCtx = await loadCategorizeCtx(ports, store);
  const results: ItemResult[] = [];
  for (const item of items) {
    const entry = tokens[item.itemId];
    if (entry === undefined) {
      // Item on record but no token: unrecoverable without a reconnect.
      // TOKEN_MISSING is our own code (Plaid-style casing), not provider prose.
      await store.putItem({
        ...item,
        status: "error",
        lastError: "TOKEN_MISSING"
      });
      results.push({
        itemId: item.itemId,
        status: "error",
        added: 0,
        modified: 0,
        removed: 0,
        pages: 0
      });
      continue;
    }
    try {
      const { balanceFailure, ...counts } = await syncItem(
        ports,
        store,
        plaid,
        item,
        entry.accessToken,
        categorizeCtx,
        actorUserId
      );
      // Success clears any prior failure state — this is also how a
      // reauth-required item returns to connected after Hosted Link update.
      // A balance-check failure that fell back is still worth reading back, so
      // its detail is kept while the item itself reports connected.
      const { lastError: _cleared, lastErrorDetail: _clearedDetail, ...rest } = item;
      await store.putItem({
        ...rest,
        status: "connected",
        lastSyncAt: ports.now().toISOString(),
        ...(balanceFailure ? { lastErrorDetail: balanceFailure } : {})
      });
      results.push({ itemId: item.itemId, status: "connected", ...counts });
    } catch (error) {
      // Item-level isolation: one bank's outage or expired login never
      // blocks the others. Only Plaid's own diagnostic fields are recorded
      // (type, code, message, request id; never tokens or request bodies);
      // everything non-Plaid still aborts the run via wrap.
      if (!(error instanceof PlaidError)) throw error;
      const status: ItemRecord["status"] =
        error.code === "ITEM_LOGIN_REQUIRED" ? "reauth-required" : "error";
      console.warn(
        `finance.sync item_failed item=${item.itemId} status=${status} code=${error.code} ` +
          `http=${error.httpStatus} type=${error.detail.type ?? "-"} ` +
          `request_id=${error.detail.requestId ?? "-"}`
      );
      await store.putItem({
        ...item,
        status,
        lastError: error.code,
        lastErrorDetail: { code: error.code, ...error.detail }
      });
      results.push({ itemId: item.itemId, status, added: 0, modified: 0, removed: 0, pages: 0 });
    }
  }
  await reconcileOwnMirror(ports, store, actorUserId);
  return { status: "ok", items: results };
};
