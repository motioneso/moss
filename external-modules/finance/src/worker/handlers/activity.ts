// external-modules/finance/src/worker/handlers/activity.ts
//
// #3186: the activity trail on Finance Settings.
//   finance.activity.list   read tool: one window of rows, worded for the screen
//   finance.activity-undo   queue: reverses one row, refusing when the data moved on
// Rows store ids, cents and enum values only. The wording is built here, at read time,
// from the current category and merchant names.

import {
  NS,
  type ActivityRecord,
  type Category,
  type FinanceStore,
  type TransactionRecord
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readInt, readString } from "../validate.js";
import { READY_TO_ASSIGN } from "./budget.js";
import { loadCategories } from "./feed.js";

const QUEUE_UNDO = "finance.activity-undo";
const MAX_ROWS = 200;
const READY_LABEL = "unassigned money";

/** Row kinds that carry enough stored data to be reversed. */
const UNDOABLE_KINDS: ReadonlySet<string> = new Set([
  "budget.assign",
  "budget.move",
  "transaction.categorize",
  "merchant-rule.set",
  "category.add",
  "category.archive"
]);

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

type Params = ActivityRecord["params"];

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

function money(cents: number): string {
  const abs = Math.abs(cents);
  const text = `$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}

function monthLabel(month: string | null): string {
  const match = month === null ? null : /^(\d{4})-(\d{2})$/u.exec(month);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return name === undefined ? "this month" : name;
}

function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

interface Names {
  category(id: string | null): string;
  merchantForRule(ruleId: string | null): Promise<string>;
  transaction(params: Params): Promise<TransactionRecord | null>;
}

async function readRule(
  ports: WorkerPorts,
  ruleId: string
): Promise<{ key: string; value: { categoryId?: string; payeeKey?: string } } | null> {
  for (const key of [`rule:${ruleId}`, ruleId]) {
    const value = (await ports.kv.get(NS.rules, key)) as {
      categoryId?: string;
      payeeKey?: string;
    } | null;
    if (value !== null && value !== undefined) return { key, value };
  }
  return null;
}

async function namesFor(ports: WorkerPorts, store: FinanceStore): Promise<Names> {
  const categories = await loadCategories(ports);
  const byId = new Map(categories.map((category) => [category.id, category.name]));
  const chunks = new Map<string, TransactionRecord[] | null>();
  return {
    category: (id) => (id === null ? "no category" : (byId.get(id) ?? "a category")),
    merchantForRule: async (ruleId) => {
      const rule = ruleId === null ? null : await readRule(ports, ruleId);
      return rule?.value.payeeKey ? titleCase(rule.value.payeeKey) : "a merchant";
    },
    transaction: async (params) => {
      const accountId = str(params.accountId);
      const month = str(params.month);
      const transactionId = str(params.transactionId);
      if (accountId === null || month === null || transactionId === null) return null;
      const key = `${accountId}:${month}`;
      if (!chunks.has(key)) chunks.set(key, await store.getTransactionChunk(accountId, month));
      return chunks.get(key)?.find((entry) => entry.id === transactionId) ?? null;
    }
  };
}

async function describe(row: ActivityRecord, names: Names): Promise<string> {
  const p = row.params;
  switch (row.kind) {
    case "budget.assign":
      return `Set ${names.category(str(p.categoryId))} to ${money(num(p.amountCents) ?? 0)} for ${monthLabel(str(p.month))}`;
    case "budget.move": {
      const from = str(p.fromCategoryId);
      const fromName = from === READY_TO_ASSIGN ? READY_LABEL : names.category(from);
      return `Moved ${money(num(p.amountCents) ?? 0)} from ${fromName} to ${names.category(str(p.toCategoryId))}`;
    }
    case "transaction.categorize":
    case "transaction.confirm": {
      const tx = await names.transaction(p);
      const what = tx ? `${tx.name}, ${money(tx.amountCents)}` : "a purchase";
      const category = names.category(str(p.categoryId));
      if (row.kind === "transaction.confirm") return `Confirmed ${what} as ${category}`;
      return p.previousCategoryId === null || p.previousCategoryId === undefined
        ? `Sorted ${what} into ${category}`
        : `Changed ${what} to ${category}`;
    }
    case "merchant-rule.set":
      return `Made a rule: ${await names.merchantForRule(str(p.ruleId))} goes to ${names.category(str(p.categoryId))}`;
    case "category.add":
      return `Added the category ${names.category(str(p.categoryId))}`;
    case "category.edit":
      return `Changed the category ${names.category(str(p.categoryId))}`;
    case "category.archive":
      return `Archived the category ${names.category(str(p.categoryId))}`;
    default:
      return "Changed something in Finance";
  }
}

/** Read tool behind the Settings activity list. Newest first, one time window per call. */
export const activityListHandler: ToolFactory = (ports) => async (input) => {
  const from = readString(input, "from", { required: true });
  const to = readString(input, "to", { required: true });
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new InputError("from and to must be timestamps");
  }
  const limit = readInt(input, "limit", { min: 1, max: MAX_ROWS }) ?? MAX_ROWS;
  const store = await ports.store();
  const rows = await store.listActivity(
    new Date(from).toISOString(),
    new Date(to).toISOString(),
    limit
  );
  const names = await namesFor(ports, store);
  const activity = [];
  for (const row of rows) {
    activity.push({
      id: row.id,
      at: row.at,
      actor: row.actor,
      summary: await describe(row, names),
      undone: row.undoneAt !== null,
      undoable: row.undoneAt === null && row.undo !== null && UNDOABLE_KINDS.has(row.kind)
    });
  }
  return { status: "ok", activity };
};

function readEnvelopeParams(input: Record<string, unknown>): Record<string, unknown> {
  if (readString(input, "jobKind", { required: true }) !== QUEUE_UNDO) {
    throw new InputError("jobKind is not supported by this handler");
  }
  const params = input.params;
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  return params as Record<string, unknown>;
}

const CHANGED = (): InputError =>
  new InputError("changed_since", "the data changed after this action, so it cannot be undone");

async function currentAssignment(
  store: FinanceStore,
  month: string,
  categoryId: string
): Promise<number> {
  return (await store.getLedger(month))?.assignments[categoryId] ?? 0;
}

async function undoAssign(store: FinanceStore, row: ActivityRecord): Promise<void> {
  const month = str(row.params.month);
  const categoryId = str(row.params.categoryId);
  const after = num(row.params.amountCents);
  const restore = num(row.undo?.amountCents);
  if (month === null || categoryId === null || after === null || restore === null) {
    throw new InputError("not_undoable", "this row has no usable undo data");
  }
  if ((await currentAssignment(store, month, categoryId)) !== after) throw CHANGED();
  await store.setAssignment(month, categoryId, restore);
  await store.appendActivity({
    actor: "user",
    kind: "budget.assign",
    params: { month, categoryId, amountCents: restore, previousCents: after }
  });
}

async function undoMove(store: FinanceStore, row: ActivityRecord): Promise<void> {
  const month = str(row.params.month);
  const from = str(row.params.fromCategoryId);
  const to = str(row.params.toCategoryId);
  const amount = num(row.params.amountCents);
  const toPrevious = num(row.undo?.toPreviousCents);
  const fromPrevious = num(row.undo?.fromPreviousCents);
  if (month === null || from === null || to === null || amount === null || toPrevious === null) {
    throw new InputError("not_undoable", "this row has no usable undo data");
  }
  if ((await currentAssignment(store, month, to)) !== toPrevious + amount) throw CHANGED();
  if (
    fromPrevious !== null &&
    (await currentAssignment(store, month, from)) !== fromPrevious - amount
  ) {
    throw CHANGED();
  }
  await store.setAssignment(month, to, toPrevious);
  if (fromPrevious !== null) await store.setAssignment(month, from, fromPrevious);
}

async function undoCategorize(
  ports: WorkerPorts,
  store: FinanceStore,
  row: ActivityRecord
): Promise<void> {
  const accountId = str(row.params.accountId);
  const month = str(row.params.month);
  const transactionId = str(row.params.transactionId);
  const after = str(row.params.categoryId);
  if (accountId === null || month === null || transactionId === null || after === null) {
    throw new InputError("not_undoable", "this row has no usable undo data");
  }
  const restore = str(row.undo?.categoryId);
  const chunk = await store.getTransactionChunk(accountId, month);
  const record = chunk?.find((entry) => entry.id === transactionId);
  if (!record) throw new InputError("not_found", "the transaction is no longer on record");
  if (record.categoryId !== after) throw CHANGED();
  if (restore !== null) {
    const live = (await loadCategories(ports)).some((c) => c.id === restore && !c.archived);
    if (!live) throw new InputError("invalid_category", "the earlier category is no longer live");
  }
  record.categoryId = restore;
  if (restore === null) {
    record.categorizedBy = null;
    record.reviewState = "needs_look";
  }
  await store.putTransaction(record);
}

async function undoRule(ports: WorkerPorts, row: ActivityRecord): Promise<void> {
  const ruleId = str(row.params.ruleId);
  const after = str(row.params.categoryId);
  if (ruleId === null || after === null) {
    throw new InputError("not_undoable", "this row has no usable undo data");
  }
  const rule = await readRule(ports, ruleId);
  if (rule === null || rule.value.categoryId !== after) throw CHANGED();
  const restore = str(row.undo?.categoryId);
  if (restore === null) {
    await ports.kv.delete(NS.rules, rule.key);
    return;
  }
  const live = (await loadCategories(ports)).some((c) => c.id === restore && !c.archived);
  if (!live) throw new InputError("invalid_category", "the earlier category is no longer live");
  await ports.kv.set(NS.rules, rule.key, { ...rule.value, categoryId: restore });
}

async function saveCategories(ports: WorkerPorts, categories: Category[]): Promise<void> {
  await ports.kv.set(NS.categories, "taxonomy", { categories });
}

async function undoCategory(
  ports: WorkerPorts,
  store: FinanceStore,
  row: ActivityRecord
): Promise<void> {
  const categoryId = str(row.params.categoryId);
  if (categoryId === null) throw new InputError("not_undoable", "this row has no usable undo data");
  const all = await loadCategories(ports);
  const current = all.find((entry) => entry.id === categoryId);
  if (!current) throw new InputError("not_found", "the category is no longer on record");
  if (row.kind === "category.add") {
    if (current.archived) throw CHANGED();
    const month = ports.now().toISOString().slice(0, 7);
    if ((await currentAssignment(store, month, categoryId)) !== 0) throw CHANGED();
    await saveCategories(
      ports,
      all.map((entry) => (entry.id === categoryId ? { ...entry, archived: true } : entry))
    );
    return;
  }
  if (!current.archived) throw CHANGED();
  await saveCategories(
    ports,
    all.map((entry) => (entry.id === categoryId ? { ...entry, archived: false } : entry))
  );
}

/** Queue handler. Reverses one activity row, or throws when the data moved on since. */
export const activityUndoHandler: ToolFactory = (ports) => async (input) => {
  const params = readEnvelopeParams(input);
  const activityId = readString(params, "activityId", { required: true });
  const store = await ports.store();
  const row = await store.getActivity(activityId);
  if (row === null) throw new InputError("not_found", "no activity row matches the given id");
  if (row.undoneAt !== null) return { status: "ok", undone: true, alreadyUndone: true };
  if (row.undo === null || !UNDOABLE_KINDS.has(row.kind)) {
    throw new InputError("not_undoable", "this row cannot be undone");
  }

  switch (row.kind) {
    case "budget.assign":
      await undoAssign(store, row);
      break;
    case "budget.move":
      await undoMove(store, row);
      break;
    case "transaction.categorize":
      await undoCategorize(ports, store, row);
      break;
    case "merchant-rule.set":
      await undoRule(ports, row);
      break;
    default:
      await undoCategory(ports, store, row);
  }
  await store.markActivityUndone(activityId, ports.now().toISOString());
  return { status: "ok", undone: true };
};
