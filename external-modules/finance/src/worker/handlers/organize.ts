import { setCanonicalMerchantRule } from "../merchant-rules.js";
import { assertCategoryFunding } from "./flex-guards.js";
// external-modules/finance/src/worker/handlers/organize.ts
//
// #3185: the assistant writes that reshape how money is sorted: merchant rules and
// the category list. Each returns a before-and-after block and logs an activity row
// holding ids and enum values only (never a merchant or category name).

import type { Category, ActivityInput, BudgetReview } from "../../domain/index.js";
import {
  CATEGORY_GROUP_NAMES,
  contentHash,
  legacyRuleKey,
  normalizePayee,
  NS,
  ruleKey,
  tableGroupFor,
  type CategoryGroupName
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readEnum, readString } from "../validate.js";
import { requireBudgetPolicy, staleBudget, budgetContext } from "./budget-context.js";
import { today } from "./manual-ledger.js";
import { loadCategories } from "./feed.js";

/** Group name shown on screens to the legacy group id the stored list uses. */
const LEGACY_GROUP: Readonly<Record<CategoryGroupName, string>> = {
  Bills: "fixed",
  Everyday: "everyday",
  Fun: "personal",
  Savings: "savings-goals",
  Income: "income"
};

/** Categories the app itself depends on; they cannot be archived. */
const PROTECTED_IDS: ReadonlySet<string> = new Set(["income", "transfers"]);

const NAME_MAX_BYTES = 60;

function readName(input: Record<string, unknown>): string {
  const name = readString(input, "name", { required: true, maxBytes: NAME_MAX_BYTES }).trim();
  if (name === "") throw new InputError("name must not be empty");
  return name;
}

/** Plain-English statement of what the rule did, returned in the tool result for the chat to show. */
function ruleSetMessage(
  merchant: string,
  categoryName: string,
  previousName: string | null,
  unchanged: boolean
): string {
  const name = merchant.trim();
  const where =
    "You can see or undo it in Finance settings: the Merchant rules list, or Recent activity.";
  if (unchanged)
    return `Nothing changed. A rule already sends ${name} to ${categoryName}. No existing transactions were changed. ${where}`;
  const replaced =
    previousName === null
      ? ""
      : ` It replaces the earlier rule that sent ${name} to ${previousName}.`;
  return `I made a rule: ${name} always goes to ${categoryName}. Future transactions from ${name} will be sorted into ${categoryName} automatically.${replaced} No existing transactions were changed. ${where}`;
}

/**
 * Sets the category a merchant always goes to. Replaces any earlier rule for the
 * same merchant, and the old category rides in `before`.
 */
export const ruleSetHandler: ToolFactory = (ports) => async (input) => {
  const merchant = readString(input, "merchant", { required: true, maxBytes: 200 });
  const categoryId = readString(input, "categoryId", { required: true });
  const all = await loadCategories(ports);
  const live = all.filter((entry) => !entry.archived);
  const target = live.find((entry) => entry.id === categoryId);
  if (!target) {
    throw new InputError("invalid_category", "categoryId is not a live category");
  }
  const nameOf = (id: string | null): string | null =>
    id === null ? null : (all.find((entry) => entry.id === id)?.name ?? null);
  const payeeKey = normalizePayee(merchant);
  if (payeeKey === "") {
    throw new InputError("invalid_merchant", "merchant has no letters to match on");
  }

  const selectedStore = await ports.store();
  if (selectedStore.rules) {
    const { ruleId, previousCategoryId } = await setCanonicalMerchantRule(
      ports,
      selectedStore,
      merchant,
      categoryId,
      "moss"
    );
    return {
      status: "ok",
      ruleId,
      before: { categoryId: previousCategoryId },
      after: { categoryId },
      message: ruleSetMessage(
        merchant,
        target.name,
        nameOf(previousCategoryId),
        previousCategoryId === categoryId
      )
    };
  }

  const key = ruleKey(payeeKey);
  const existing = ((await ports.kv.get(NS.rules, key)) ??
    (await ports.kv.get(NS.rules, legacyRuleKey(payeeKey)))) as { categoryId?: string } | null;
  const previousCategoryId = typeof existing?.categoryId === "string" ? existing.categoryId : null;

  await ports.kv.set(NS.rules, key, {
    payeeKey,
    categoryId,
    createdAt: ports.now().toISOString()
  });
  await ports.kv.delete(NS.rules, legacyRuleKey(payeeKey));

  const ruleId = contentHash(payeeKey);
  if (previousCategoryId !== categoryId) {
    const store = await ports.store();
    await store.appendActivity({
      actor: "moss",
      kind: "merchant-rule.set",
      params: { ruleId, categoryId, previousCategoryId },
      undo: { ruleId, categoryId: previousCategoryId }
    });
  }
  return {
    status: "ok",
    ruleId,
    before: { categoryId: previousCategoryId },
    after: { categoryId },
    message: ruleSetMessage(
      merchant,
      target.name,
      nameOf(previousCategoryId),
      previousCategoryId === categoryId
    )
  };
};

async function saveCategory(
  ports: WorkerPorts,
  category: Category,
  expected: BudgetReview,
  activity: ActivityInput[]
): Promise<void> {
  if (
    !(await (
      await ports.store()
    ).commitBudgetChange({
      expected,
      month: today(ports).slice(0, 7),
      assignments: [],
      categories: [category],
      activity
    }))
  )
    throw staleBudget();
}

function slugFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "category";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** Adds a category (no id) or renames or regroups one (id given). */
export const categoryUpsertHandler: ToolFactory = (ports) => async (input) => {
  const id = readString(input, "id");
  const name = readName(input);
  const groupName = readEnum(input, "groupName", CATEGORY_GROUP_NAMES, { required: true });

  const store = await ports.store();
  const expected = await requireBudgetPolicy(store);
  const all = await loadCategories(ports);
  const duplicate = all.find(
    (entry) => !entry.archived && entry.id !== id && entry.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    throw new InputError("duplicate_name", "a live category already has that name");
  }

  if (id === undefined) {
    const created: Category = {
      id: slugFor(name, new Set(all.map((entry) => entry.id))),
      group: LEGACY_GROUP[groupName],
      name,
      archived: false
    };
    await saveCategory(ports, created, expected, [
      {
        actor: "moss",
        kind: "category.add",
        params: { categoryId: created.id, groupName },
        undo: { categoryId: created.id }
      }
    ]);
    return {
      status: "ok",
      categoryId: created.id,
      before: null,
      after: { name, groupName }
    };
  }

  const current = all.find((entry) => entry.id === id);
  if (!current || current.archived) {
    throw new InputError("invalid_category", "id is not a live category");
  }
  const before = { name: current.name, groupName: tableGroupFor(current.group) };
  await saveCategory(
    ports,
    { ...current, name, group: LEGACY_GROUP[groupName] },
    expected,
    before.name !== name || before.groupName !== groupName
      ? [
          {
            actor: "moss",
            kind: "category.edit",
            params: { categoryId: id, groupName, previousGroupName: before.groupName }
          }
        ]
      : []
  );
  return { status: "ok", categoryId: id, before, after: { name, groupName } };
};

/** Archives a category. Refuses while the current month still has money assigned to it. */
export const categoryArchiveHandler: ToolFactory = (ports) => async (input) => {
  const id = readString(input, "id", { required: true });
  if (PROTECTED_IDS.has(id)) {
    throw new InputError("protected_category", "this category cannot be archived");
  }
  const store = await ports.store();
  const expected = await requireBudgetPolicy(store);
  const all = await loadCategories(ports);
  const current = all.find((entry) => entry.id === id);
  if (!current || current.archived) {
    throw new InputError("invalid_category", "id is not a live category");
  }
  const month = today(ports).slice(0, 7);
  await assertCategoryFunding(store, month, [id]);
  const assigned = (await store.getLedger(month))?.assignments[id] ?? 0;
  if (assigned !== 0) {
    throw new InputError(
      "has_assignments",
      "this category has money assigned this month; move it first"
    );
  }
  const context = await budgetContext(ports, store, month);
  if (!context.setupRequired && (context.state.categories[id]?.availableCents ?? 0) !== 0)
    throw new InputError(
      "has_assignments",
      "This category has money available or overspending; resolve it before archiving"
    );
  for (const future of (await store.listAssignmentMonths()).filter((m) => m > month)) {
    if (((await store.getLedger(future))?.assignments[id] ?? 0) !== 0)
      throw new InputError(
        "has_assignments",
        "This category has future assignments; move them before archiving"
      );
  }
  await saveCategory(ports, { ...current, archived: true }, expected, [
    {
      actor: "moss",
      kind: "category.archive",
      params: { categoryId: id },
      undo: { categoryId: id }
    }
  ]);
  return {
    status: "ok",
    categoryId: id,
    before: { archived: false },
    after: { archived: true }
  };
};
