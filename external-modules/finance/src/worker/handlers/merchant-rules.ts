import { contentHash, normalizePayee, NS, isCalendarMonth } from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import { RULES_MIGRATED_KEY } from "../merchant-rules.js";
import { InputError, readString, readInt, readBool } from "../validate.js";
import { loadCategories } from "./feed.js";
function merchant(input: Record<string, unknown>): string {
  const value = readString(input, "merchant", { required: true, maxBytes: 200 }).trim();
  if (!normalizePayee(value))
    throw new InputError("invalid_merchant", "Enter a merchant name containing letters");
  return value;
}
export const rulesListHandler: ToolFactory = (ports) => async (input) => {
  const search = readString(input, "search", { maxBytes: 200 })?.trim() ?? "";
  const limit = readInt(input, "limit", { min: 1, max: 1000 }) ?? 50;
  const store = await ports.store();
  if (!store.rules) return { supported: false, ready: false };
  if (!(await ports.kv.get(NS.meta, RULES_MIGRATED_KEY))) return { supported: true, ready: false };
  const key = normalizePayee(search);
  const rows = (await store.rules.all()).filter(
    (r) => !search || (key !== "" && r.payeeKey.includes(key))
  );
  return {
    supported: true,
    ready: true,
    rules: rows.slice(0, limit),
    total: rows.length,
    limit,
    categories: await loadCategories(ports)
  };
};
export const rulesPreviewHandler: ToolFactory = (ports) => async (input) => {
  const name = merchant(input),
    payeeKey = normalizePayee(name);
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("invalid_month", "Choose a valid month");
  const store = await ports.store();
  if (!store.rules || !(await ports.kv.get(NS.meta, RULES_MIGRATED_KEY)))
    throw new InputError(
      "storage_upgrade_required",
      "Rules are getting ready; check saved rules after initialization"
    );
  const rows = (await store.listMonthTransactions(month)).filter(
    (r) => normalizePayee(r.name) === payeeKey
  );
  const categories = await loadCategories(ports);
  return {
    payeeKey,
    month,
    total: rows.length,
    limit: 20,
    existing: (await store.rules.all()).find((r) => r.id === contentHash(payeeKey)) ?? null,
    examples: rows.slice(0, 20).map((r) => ({
      id: r.id,
      name: r.name,
      date: r.date,
      amountCents: r.amountCents,
      isoCurrency: r.isoCurrency,
      categoryId: r.categoryId,
      categoryName: categories.find((c) => c.id === r.categoryId)?.name ?? "Uncategorized",
      alreadyCategorized: r.categoryId !== null || r.categorizedBy !== null
    }))
  };
};
export const rulesUpdateHandler: ToolFactory = (ports) => async (input) => {
  const name = merchant(input),
    payeeKey = normalizePayee(name),
    id = contentHash(payeeKey);
  const categoryId = readString(input, "categoryId", { required: true });
  const enabled = readBool(input, "enabled", { required: true });
  const expectedRevision = readString(input, "expectedRevision");
  if (expectedRevision !== undefined && !/^[0-9a-f]{32}$/.test(expectedRevision))
    throw new InputError("invalid_revision", "Check saved rules before reviewing this change");
  const store = await ports.store();
  if (!store.rules || !(await ports.kv.get(NS.meta, RULES_MIGRATED_KEY)))
    throw new InputError(
      "storage_upgrade_required",
      "Rules are getting ready; check saved rules after initialization"
    );
  if (
    !(await store.rules.apply({
      id,
      payeeKey,
      categoryId,
      enabled,
      expectedRevision: expectedRevision ?? null,
      actor: "user",
      at: ports.now().toISOString()
    }))
  )
    throw new InputError(
      "stale_rules",
      "The rule or category changed. Nothing was saved; check saved rules and review again"
    );
  return { status: "ok", ruleId: id, enabled };
};
