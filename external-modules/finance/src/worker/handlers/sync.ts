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
import { PlaidError } from "../../adapters/plaid.js";
import type { PlaidAccount } from "../../adapters/plaid.js";
import type {
  AccountRecord,
  Category,
  CategorizeAi,
  ChunkMap,
  FinanceKv,
  FinanceStore,
  ItemRecord,
  Rule
} from "../../domain/index.js";
import {
  categorize,
  cursorKey,
  DEFAULT_CATEGORIES,
  monthKey,
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

// Plaid pages are capped at count:100 (adapter), so 20 pages = 2000
// transactions per item per run — far above a personal account's churn, low
// enough to bound a runaway loop. Progress is durable (cursor per page), so
// a truncated run simply resumes at the next sweep.
const MAX_PAGES_PER_RUN = 20;

// Plaid invalidates a pagination run when the data changes under it; the
// documented recovery is to restart from the cursor the run began with.
const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
const MAX_PAGINATION_RESTARTS = 3;

type ItemResult = {
  itemId: string;
  status: ItemRecord["status"];
  added: number;
  modified: number;
  removed: number;
  pages: number;
};

/** Loaded once per run and shared across items/pages. */
type CategorizeCtx = { rules: Rule[]; categories: Category[]; ai: CategorizeAi | null };

/**
 * FIN-02 (#1147) Task 9: load the categorization inputs, seeding the default
 * taxonomy on first read — the feed and rules always need a category list to
 * resolve against, and seeding here (the only writer besides the user's own
 * edits) keeps the read path elsewhere side-effect free.
 */
async function loadCategorizeCtx(ports: WorkerPorts): Promise<CategorizeCtx> {
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
  return { rules, categories: stored.categories, ai: buildCategorizeAi(ports.ai) };
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
): Promise<ChunkMap> {
  const records = touched.flatMap((key) => chunks[key]?.transactions ?? []);
  const updated = await categorize(records, ctx.rules, ctx.categories, ctx.ai);
  const byId = new Map(updated.map((record) => [record.id, record]));
  const next: ChunkMap = { ...chunks };
  for (const key of touched) {
    next[key] = {
      transactions: (chunks[key]?.transactions ?? []).map((record) => byId.get(record.id) ?? record)
    };
  }
  return next;
}

async function readCursor(kv: FinanceKv, itemId: string): Promise<string | null> {
  const record = await kv.get(NS.connections, cursorKey(itemId));
  return typeof record?.cursor === "string" ? record.cursor : null;
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
): Promise<Omit<ItemResult, "itemId" | "status">> {
  const nowIso = ports.now().toISOString();
  const today = nowIso.slice(0, 10);

  // Balances first: cheap, and the feed's account cards should be fresh
  // even when the transaction loop later truncates at the page bound. The
  // live balance product is not enabled for every Plaid client (it fails with
  // INVALID_PRODUCT), so any failure except a real login problem falls back
  // to the balances the plain accounts lookup already returns.
  let accounts: PlaidAccount[];
  try {
    accounts = (await plaid.accountsBalanceGet(accessToken)).accounts;
  } catch (error) {
    if (!(error instanceof PlaidError) || error.code === "ITEM_LOGIN_REQUIRED") throw error;
    console.warn(
      `finance.sync balance_fallback item=${item.itemId} code=${error.code} http=${error.httpStatus}`
    );
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

  const startCursor = await readCursor(ports.kv, item.itemId);
  let cursor = startCursor;
  let counts = { added: 0, modified: 0, removed: 0, pages: 0 };
  let restarts = 0;
  let hasMore = true;
  while (hasMore && counts.pages < MAX_PAGES_PER_RUN) {
    let page: Awaited<ReturnType<typeof plaid.transactionsSync>>;
    try {
      page = await plaid.transactionsSync(accessToken, cursor);
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
      await ports.kv.set(NS.connections, cursorKey(item.itemId), { cursor: startCursor });
      cursor = startCursor;
      counts = { added: 0, modified: 0, removed: 0, pages: 0 };
      hasMore = true;
      continue;
    }
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
    const next = await categorizeChunks(reduced.chunks, reduced.touched, categorizeCtx);
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
    // Cursor LAST (see header): only after this page's chunks are durable.
    await ports.kv.set(NS.connections, cursorKey(item.itemId), { cursor: page.nextCursor });

    counts.added += page.added.length;
    counts.modified += page.modified.length;
    counts.removed += page.removed.length;
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }
  return counts;
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
  const categorizeCtx = await loadCategorizeCtx(ports);
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
      const counts = await syncItem(
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
      const { lastError: _cleared, lastErrorDetail: _clearedDetail, ...rest } = item;
      await store.putItem({
        ...rest,
        status: "connected",
        lastSyncAt: ports.now().toISOString()
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
