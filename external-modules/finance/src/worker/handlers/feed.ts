// external-modules/finance/src/worker/handlers/feed.ts
//
// FIN-02 (#1147) Task 10: the feed surface. transactions.query is the web
// page's single read (transactions + categories + accounts in one call, so
// the feed renders off one round-trip); transaction.categorize and
// transaction.categorize-new are the assistant write paths (provenance
// "user", optional notes; the merchant's confirmed history picks which one
// may run, so chat cannot sort a new merchant under the routine family); and
// categorize.apply is the SAME category-set logic behind the
// finance.categorize-apply queue — the web path, which per D4/D6 carries the
// four identifier ids only. Notes never ride a job payload.
import type {
  Category,
  FinanceStore,
  TransactionChunk,
  TransactionRecord
} from "../../domain/index.js";
import {
  contentHash,
  DEFAULT_CATEGORIES,
  legacyRuleKey,
  normalizePayee,
  NS,
  ruleKey,
  parseSharedKey,
  toSharedTransaction
} from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { accountsListHandler } from "./accounts.js";

const MONTH = /^\d{4}-\d{2}$/;

function readMonth(input: Record<string, unknown>, ports: WorkerPorts): string {
  const month = readString(input, "month");
  if (month === undefined) return ports.now().toISOString().slice(0, 7);
  if (!MONTH.test(month)) throw new InputError("month must be YYYY-MM");
  return month;
}

/**
 * Read the stored taxonomy without seeding it — the sync run is the only
 * writer (Task 9 loadCategorizeCtx), so a pre-first-sync feed just sees the
 * defaults. Keeping reads side-effect free also keeps query safe to retry.
 */
export async function loadCategories(ports: WorkerPorts): Promise<Category[]> {
  const stored = (await ports.kv.get(NS.categories, "taxonomy")) as {
    categories: Category[];
  } | null;
  return stored?.categories ?? [...DEFAULT_CATEGORIES];
}

// A feed row: own rows are plain records; rows merged from the household
// mirror carry their owner's id and a shared marker for the web layer.
type FeedRow = TransactionRecord & { ownerUserId?: string; shared?: true };

/** Most rows one transactions.query call returns; the screen asks for more in steps of 200. */
const MAX_QUERY_LIMIT = 2000;

export const transactionsQueryHandler: ToolFactory = (ports) => async (input) => {
  // Host-injected at the dispatch chokepoint (spread LAST over tool input)
  // and host-bound on queue envelopes — never caller-controlled (#1149).
  const actorUserId = readString(input, "actorUserId", { required: true });
  const month = readMonth(input, ports);
  const accountId = readString(input, "accountId");
  const categoryId = readString(input, "categoryId");
  const search = readString(input, "search")?.toLowerCase();
  const pendingOnly = readBool(input, "pendingOnly") ?? false;
  const needsLookOnly = readBool(input, "needsLookOnly") ?? false;
  const limit = readInt(input, "limit", { min: 1, max: MAX_QUERY_LIMIT }) ?? 50;

  // FIN-06c (#1166) Task 9: one store call for the requested month, across
  // every account — store.listMonthTransactions already returns the pinned
  // date-desc/id-asc order, so accountId (when given) is just a filter.
  const store = await ports.store();
  const monthTransactions = await store.listMonthTransactions(month);
  let transactions: FeedRow[] = accountId
    ? monthTransactions.filter((record) => record.accountId === accountId)
    : [...monthTransactions];
  // FIN-04 (#1149): merge OTHER owners' shared month chunks BEFORE the
  // filters below, so category/search/pending treat shared rows exactly like
  // own rows. Own-prefix mirror chunks are skipped (own records above are
  // authoritative); this read stays pure — no mirror writes, no GC-on-read.
  for (const key of await ports.mirror.list()) {
    const parsed = parseSharedKey(key);
    if (!parsed || parsed.suffix !== month) continue;
    if (parsed.ownerUserId === actorUserId) continue;
    if (accountId !== undefined && parsed.accountId !== accountId) continue;
    const chunk = (await ports.mirror.get(key)) as TransactionChunk | null;
    if (!chunk || !Array.isArray(chunk.transactions)) continue;
    for (const record of chunk.transactions) {
      // Re-apply the write-side allowlist on read, then tag with the KEY's
      // owner (not anything stored in the value).
      transactions.push({
        ...toSharedTransaction(record),
        ownerUserId: parsed.ownerUserId,
        shared: true
      });
    }
  }
  if (categoryId !== undefined) {
    transactions = transactions.filter((record) => record.categoryId === categoryId);
  }
  if (search !== undefined) {
    transactions = transactions.filter(
      (record) =>
        record.name.toLowerCase().includes(search) ||
        (record.merchant ?? "").toLowerCase().includes(search)
    );
  }
  if (pendingOnly) transactions = transactions.filter((record) => record.pending);
  // Household rows are read-only here, so only the viewer's own rows can need a look.
  const needsLook = (record: FeedRow): boolean =>
    record.shared !== true && record.reviewState === "needs_look";
  const needsLookCount = transactions.filter(needsLook).length;
  if (needsLookOnly) transactions = transactions.filter(needsLook);
  // Chunks are date-desc/id-asc internally; re-sort after the cross-account
  // merge so the feed order is stable regardless of kv.list order.
  transactions.sort((a, b) =>
    a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const totalCount = transactions.length;
  transactions = transactions.slice(0, limit);

  const accounts = await accountsListHandler(ports)({ actorUserId });
  return {
    month,
    transactions,
    totalCount,
    needsLookCount,
    categories: await loadCategories(ports),
    accounts: (accounts.accounts as unknown[] | undefined) ?? []
  };
};

type ApplyIds = { transactionId: string; accountId: string; month: string; categoryId: string };

function readApplyIds(input: Record<string, unknown>): ApplyIds {
  const month = readString(input, "month", { required: true });
  if (!MONTH.test(month)) throw new InputError("month must be YYYY-MM");
  return {
    transactionId: readString(input, "transactionId", { required: true }),
    accountId: readString(input, "accountId", { required: true }),
    month,
    categoryId: readString(input, "categoryId", { required: true })
  };
}

/**
 * The one category-set path shared by the assistant tool and the queue job:
 * validates the category against the LIVE taxonomy, stamps provenance
 * "user" (both paths are user-initiated), and returns the updated record so
 * callers can layer notes/rules on top before persisting.
 */
type ApplyContext = {
  liveCategoryIds: ReadonlySet<string>;
  chunks: Map<string, TransactionRecord[] | null>;
};

async function loadApplyContext(ports: WorkerPorts): Promise<ApplyContext> {
  const live = (await loadCategories(ports)).filter((category) => !category.archived);
  return { liveCategoryIds: new Set(live.map((category) => category.id)), chunks: new Map() };
}

async function applyCategory(
  ports: WorkerPorts,
  store: FinanceStore,
  ids: ApplyIds,
  context?: ApplyContext
): Promise<{ record: TransactionRecord; previousCategoryId: string | null }> {
  const { liveCategoryIds, chunks } = context ?? (await loadApplyContext(ports));
  if (!liveCategoryIds.has(ids.categoryId)) {
    throw new InputError("invalid_category", "categoryId is not a live category");
  }
  // FIN-06c (#1166) Task 9: locate the record via the chunk read, but write
  // it back through store.putTransaction — the store re-derives the same
  // (accountId, month) chunk from the record itself, so there's no chunk to
  // hand back and re-set anymore.
  const chunkKey = `${ids.accountId}:${ids.month}`;
  if (!chunks.has(chunkKey)) {
    chunks.set(chunkKey, await store.getTransactionChunk(ids.accountId, ids.month));
  }
  const chunk = chunks.get(chunkKey);
  const record = chunk?.find((entry) => entry.id === ids.transactionId);
  if (!chunk || !record) {
    // Names the condition only — ids from a queue payload are still inputs.
    throw new InputError("not_found", "no transaction matches the given ids");
  }
  const previousCategoryId = record.categoryId;
  record.categoryId = ids.categoryId;
  record.categorizedBy = "user";
  // Choosing a category is the user's confirmation, whatever Moss guessed.
  record.reviewState = "confirmed";
  return { record, previousCategoryId };
}

/** Logs a category change; ids only, and undo restores the earlier category. */
async function logCategorize(
  store: FinanceStore,
  actor: "user" | "moss",
  ids: ApplyIds,
  previousCategoryId: string | null
): Promise<void> {
  if (previousCategoryId === ids.categoryId) return;
  await store.appendActivity({
    actor,
    kind: "transaction.categorize",
    params: {
      transactionId: ids.transactionId,
      accountId: ids.accountId,
      month: ids.month,
      categoryId: ids.categoryId,
      previousCategoryId
    },
    undo: {
      transactionId: ids.transactionId,
      accountId: ids.accountId,
      month: ids.month,
      categoryId: previousCategoryId
    }
  });
}

/**
 * Chat write path. `mode` is the family the tool is declared under: "seen"
 * (sorting) refuses a merchant with no confirmed history, "new" (sorting_new)
 * refuses one that has it. The decision reads stored history, never the
 * model's say-so. amountCents must match the stored row, so a stale or
 * invented reference cannot re-sort a different purchase.
 */
function categorizeTool(mode: "seen" | "new"): ToolFactory {
  return (ports) => async (input) => {
    const ids = readApplyIds(input);
    const amountCents = readInt(input, "amountCents", { required: true });
    // Manifest caps notes at 500 chars; 2000 bytes covers 4-byte UTF-8 worst case.
    const notes = readString(input, "notes", { maxBytes: 2000 });

    const store = await ports.store();
    const { record, previousCategoryId } = await applyCategory(ports, store, ids);
    if (record.amountCents !== amountCents) {
      throw new InputError("amount_mismatch", "amountCents does not match the stored transaction");
    }
    const seen = (await store.listConfirmedPayeeNames()).some(
      (name) => normalizePayee(name) === normalizePayee(record.name)
    );
    if (mode === "seen" && !seen) {
      throw new InputError(
        "new_merchant",
        "this merchant has no confirmed history; use finance.transaction.categorize-new"
      );
    }
    if (mode === "new" && seen) {
      throw new InputError(
        "merchant_seen",
        "this merchant already has confirmed history; use finance.transaction.categorize"
      );
    }
    if (notes !== undefined) record.notes = notes;
    await store.putTransaction(record);
    await logCategorize(store, "moss", ids, previousCategoryId);
    return { status: "ok", transaction: record };
  };
}

export const transactionCategorizeHandler: ToolFactory = categorizeTool("seen");
export const transactionCategorizeNewHandler: ToolFactory = categorizeTool("new");

export const categorizeApplyHandler: ToolFactory = (ports) => async (input) => {
  // Queue path (D6): unlike the tool handlers above, this one is invoked with
  // the host's job envelope { actorUserId, jobKind, idempotencyKey, params }
  // (apps/worker/src/external-module-job-handler.ts, same shape job-search's
  // monitorRunHandler consumes) — the four identifier ids ride in `params`,
  // never at the top level. #1147 UAT run 1 regression: reading them flat made
  // every real queued job fail invalid_input while the enqueue still 202'd.
  const jobKind = readString(input, "jobKind", { required: true });
  if (jobKind !== "finance.categorize-apply") {
    throw new InputError("jobKind is not supported");
  }
  const params = input.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  // The manifest paramsSchema rejects extra keys host-side; ignoring the rest
  // here is defense in depth.
  const ids = readApplyIds(params as Record<string, unknown>);
  const store = await ports.store();
  const { record, previousCategoryId } = await applyCategory(ports, store, ids);
  await store.putTransaction(record);
  await logCategorize(store, "user", ids, previousCategoryId);
  return { status: "ok", transaction: record };
};

const REVIEW_BATCH_MAX = 200;

function readIdList(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > REVIEW_BATCH_MAX) {
    throw new InputError(`${key} must list 1 to ${REVIEW_BATCH_MAX} ids`);
  }
  if (!value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new InputError(`${key} must hold strings`);
  }
  return value as string[];
}

/**
 * Queue path for the Transactions screen: confirm or change the category of one
 * or many rows. The lists line up by position. Every row is checked before any
 * is written, so a bad id leaves the whole batch untouched. A merchant rule is
 * made only for a single row and only when asked.
 */
export const reviewApplyHandler: ToolFactory = (ports) => async (input) => {
  const jobKind = readString(input, "jobKind", { required: true });
  if (jobKind !== "finance.review-apply") {
    throw new InputError("jobKind is not supported");
  }
  const params = input.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  const command = params as Record<string, unknown>;
  const transactionIds = readIdList(command, "transactionIds");
  const accountIds = readIdList(command, "accountIds");
  const months = readIdList(command, "months");
  const categoryIds = readIdList(command, "categoryIds");
  const createRule = readBool(command, "createRule") ?? false;
  if (
    accountIds.length !== transactionIds.length ||
    months.length !== transactionIds.length ||
    categoryIds.length !== transactionIds.length
  ) {
    throw new InputError("id lists must be the same length");
  }
  if (createRule && transactionIds.length !== 1) {
    throw new InputError("a merchant rule can only be made for one transaction");
  }

  const store = await ports.store();
  const context = await loadApplyContext(ports);
  const applied: { record: TransactionRecord; ids: ApplyIds; previousCategoryId: string | null }[] =
    [];
  for (let index = 0; index < transactionIds.length; index += 1) {
    const month = months[index]!;
    if (!MONTH.test(month)) throw new InputError("month must be YYYY-MM");
    const ids: ApplyIds = {
      transactionId: transactionIds[index]!,
      accountId: accountIds[index]!,
      month,
      categoryId: categoryIds[index]!
    };
    const { record, previousCategoryId } = await applyCategory(ports, store, ids, context);
    applied.push({ record, ids, previousCategoryId });
  }
  for (const { record, ids, previousCategoryId } of applied) {
    await store.putTransaction(record);
    if (previousCategoryId === ids.categoryId) {
      await store.appendActivity({
        actor: "user",
        kind: "transaction.confirm",
        params: {
          transactionId: ids.transactionId,
          accountId: ids.accountId,
          month: ids.month,
          categoryId: ids.categoryId
        }
      });
    } else {
      await logCategorize(store, "user", ids, previousCategoryId);
    }
  }
  if (createRule) {
    const payeeKey = normalizePayee(applied[0]!.record.name);
    if (payeeKey !== "") {
      const hash = contentHash(payeeKey);
      // One rule per merchant: write the current key format, drop the old bare-hash key.
      await ports.kv.set(NS.rules, ruleKey(payeeKey), {
        payeeKey,
        categoryId: categoryIds[0]!,
        createdAt: ports.now().toISOString()
      });
      await ports.kv.delete(NS.rules, legacyRuleKey(payeeKey));
      await store.appendActivity({
        actor: "user",
        kind: "merchant-rule.set",
        params: { ruleId: hash, categoryId: categoryIds[0]! }
      });
    }
  }
  return { status: "ok", confirmed: applied.length };
};
