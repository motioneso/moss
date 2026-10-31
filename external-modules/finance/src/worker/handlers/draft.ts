import { assertEnvelopeDraft } from "./flex-guards.js";
// external-modules/finance/src/worker/handlers/draft.ts
//
// #3180 (Finance R1): the first-budget draft. Three entry points share one record.
//   finance.budget.draft.get  read tool: the draft as the screen and Moss see it
//   finance.draft-build       queue: builds the draft from the stored history
//   finance.draft-start       queue: turns the draft into this month's budget
// Reviewed host tools and legacy queues share the stored draft. Start and edits
// require current review tokens; the host confirmation guards starting a budget.
import {
  budgetRows,
  CATEGORY_GROUP_NAMES,
  DRAFT_AMOUNT_MAX_CENTS,
  DRAFT_CATEGORY_KEY_RE,
  DRAFT_LINE_GROUPS,
  applyLineEdit,
  buildDraft,
  draftTotalCents,
  draftUnplannedCents,
  linePlanCents,
  pickBasisMonths,
  type ActivityInput,
  type BudgetDraft,
  type BudgetReview,
  type Category,
  type TransactionRecord
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import {
  readBudgetReview,
  requireBudgetPolicy,
  requireSameReview,
  staleBudget
} from "./budget-context.js";
import { today } from "./manual-ledger.js";
import { loadCategories } from "./feed.js";

const QUEUE_BUILD = "finance.draft-build";
const QUEUE_START = "finance.draft-start";
const QUEUE_SET = "finance.draft-set";

/** Categories money is never budgeted into. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(["income", "transfers"]);

export interface DraftViewLine {
  categoryKey: string;
  isoCurrency?: string;
  categoryName: string;
  basisMonthlyCents: number;
  planCents: number;
  dropped: boolean;
  /** Set only when Moss changed the line in chat; typed changes carry no badge. */
  changedByMoss: boolean;
  proposedCents: number;
}

export interface DraftView {
  isoCurrency?: string;
  id: string;
  status: BudgetDraft["status"];
  basisFrom: string;
  basisTo: string;
  monthlyIncomeCents: number;
  totalCents: number;
  unplannedCents: number;
  groups: { name: string; lines: DraftViewLine[] }[];
}

/** Render a stored draft for the screen. Totals come from the lines, never from a second source. */
export function draftView(draft: BudgetDraft, isoCurrency?: string): DraftView {
  const order = (name: string): number => {
    const index = (CATEGORY_GROUP_NAMES as readonly string[]).indexOf(name);
    return index === -1 ? CATEGORY_GROUP_NAMES.length : index;
  };
  const groups = new Map<string, DraftViewLine[]>();
  for (const line of draft.lines) {
    const lines = groups.get(line.groupName) ?? [];
    lines.push({
      categoryKey: line.categoryKey,
      isoCurrency,
      categoryName: line.categoryName,
      basisMonthlyCents: line.basisMonthlyCents,
      planCents: linePlanCents(line),
      dropped: line.dropped,
      changedByMoss: line.adjustedBy === "moss",
      proposedCents: line.proposedCents
    });
    groups.set(line.groupName, lines);
  }
  return {
    id: draft.id,
    isoCurrency,
    status: draft.status,
    basisFrom: draft.basisFrom,
    basisTo: draft.basisTo,
    monthlyIncomeCents: draft.monthlyIncomeCents,
    totalCents: draftTotalCents(draft.lines),
    unplannedCents: draftUnplannedCents(draft),
    groups: [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([name, lines]) => ({ name, lines }))
  };
}

export const draftGetHandler: ToolFactory = (ports) => async () => {
  const store = await ports.store();
  const policy = await store.budgetPolicy?.get();
  if (!policy) return { setupRequired: true, hasSynced: false, hasBudget: false, draft: null };
  if (!policy.taxonomyReady) await requireBudgetPolicy(store);
  const latest = await store.getLatestDraft();
  const items = await store.listItems();
  const hasBudget = (await store.listAssignmentMonths()).length > 0;
  const hasSynced =
    items.some((item) => item.lastSyncAt !== undefined) ||
    (await store.listAccounts()).some((account) => account.source === "manual");
  requireSameReview(policy, await requireBudgetPolicy(store));
  return {
    hasSynced,
    hasBudget,
    revision: policy.revision,
    fingerprint: policy.fingerprint,
    isoCurrency: policy.isoCurrency,
    draft: latest && latest.status !== "discarded" ? draftView(latest, policy.isoCurrency) : null
  };
};

export interface DraftEditResult extends Record<string, unknown> {
  status: "ok";
  draftId: string;
  categoryKey: string;
  categoryName: string;
  /** The line before the edit; null when the edit added the line. */
  before: { planCents: number; dropped: boolean } | null;
  after: { planCents: number; dropped: boolean };
  totalBeforeCents: number;
  totalAfterCents: number;
  unplannedAfterCents: number;
  monthlyIncomeCents: number;
}

/**
 * Change one line of the open draft and report the line and the draft total before and
 * after. Both the assistant tool and the screen's typed save come through here, so the
 * total they report is always the sum of the stored lines.
 */
async function editDraftLine(
  ports: WorkerPorts,
  args: {
    draftId: string;
    categoryKey: string;
    edit: Parameters<typeof applyLineEdit>[2];
    by: "user" | "moss";
    expected: BudgetReview;
  }
): Promise<DraftEditResult> {
  const store = await ports.store();
  requireSameReview(args.expected, await requireBudgetPolicy(store));
  const draft = await store.getLatestDraft();
  if (draft === null || draft.id !== args.draftId) {
    throw new InputError("draft_not_found", "draftId does not name the current draft");
  }
  if (draft.status !== "open") {
    throw new InputError("draft_not_open", "the draft has already been started");
  }
  if (PROTECTED_KEYS.has(args.categoryKey)) {
    throw new InputError("protected_category", "income and transfers cannot be budgeted");
  }
  const archivedKeys = (await loadCategories(ports))
    .filter((category) => category.archived)
    .map((category) => category.id);
  if (archivedKeys.includes(args.categoryKey)) {
    throw new InputError("archived_category", "that category is archived; unarchive it first");
  }
  const existing = draft.lines.find((line) => line.categoryKey === args.categoryKey);
  if (existing === undefined) {
    if (!DRAFT_CATEGORY_KEY_RE.test(args.categoryKey)) {
      throw new InputError("categoryKey must be a short lowercase slug");
    }
    const { categoryName, groupName, amountCents } = args.edit;
    if (!categoryName || !groupName || amountCents === undefined) {
      throw new InputError(
        "category_not_in_draft",
        "categoryKey is not in the draft; to add a line give categoryName, groupName and amountCents"
      );
    }
  }
  if (
    args.edit.groupName !== undefined &&
    !(DRAFT_LINE_GROUPS as readonly string[]).includes(args.edit.groupName)
  ) {
    throw new InputError("groupName must be Bills, Everyday, Fun or Savings");
  }
  if (args.edit.categoryName !== undefined && args.edit.categoryName.trim() === "") {
    throw new InputError("categoryName must not be empty");
  }

  const line = applyLineEdit(args.categoryKey, existing, args.edit, args.by);
  const totalBeforeCents = draftTotalCents(draft.lines);
  if (!(await store.saveDraftLine(draft.id, line, args.expected))) throw staleBudget();

  const after = await store.getLatestDraft();
  if (after === null || after.id !== draft.id || after.status !== "open") {
    throw new InputError("draft_not_open", "the draft has already been started");
  }
  return {
    status: "ok",
    draftId: draft.id,
    categoryKey: line.categoryKey,
    categoryName: line.categoryName,
    before: existing ? { planCents: linePlanCents(existing), dropped: existing.dropped } : null,
    after: { planCents: linePlanCents(line), dropped: line.dropped },
    totalBeforeCents,
    totalAfterCents: draftTotalCents(after.lines),
    unplannedAfterCents: draftUnplannedCents(after),
    monthlyIncomeCents: after.monthlyIncomeCents
  };
}

/** Assistant tool: change one draft line. It cannot start a budget. */
export const draftUpdateHandler: ToolFactory = (ports) => async (input) => {
  const draftId = readString(input, "draftId", { required: true });
  const categoryKey = readString(input, "categoryKey", { required: true });
  const amountCents = readInt(input, "amountCents", { min: 0, max: DRAFT_AMOUNT_MAX_CENTS });
  const categoryName = readString(input, "categoryName", { maxBytes: 80 });
  const groupName = readString(input, "groupName", { maxBytes: 20 });
  const dropped = readBool(input, "dropped");
  if (
    amountCents === undefined &&
    categoryName === undefined &&
    groupName === undefined &&
    dropped === undefined
  ) {
    throw new InputError("give at least one of amountCents, categoryName, groupName or dropped");
  }
  return editDraftLine(ports, {
    draftId,
    categoryKey,
    edit: {
      ...(amountCents !== undefined ? { amountCents } : {}),
      ...(categoryName !== undefined ? { categoryName } : {}),
      ...(groupName !== undefined ? { groupName } : {}),
      ...(dropped !== undefined ? { dropped } : {})
    },
    by: "moss",
    expected: readBudgetReview(input)
  });
};

/** Queue handler behind a plan amount typed on the draft screen. */
export const draftSetHandler: ToolFactory = (ports) => async (input) => {
  const params = readEnvelopeParams(input, QUEUE_SET);
  const draftId = readString(params, "draftId", { required: true });
  const categoryKey = readString(params, "categoryKey", { required: true });
  const amountCents = readInt(params, "amountCents", {
    required: true,
    min: 0,
    max: DRAFT_AMOUNT_MAX_CENTS
  });
  return editDraftLine(ports, {
    draftId,
    categoryKey,
    edit: { amountCents },
    by: "user",
    expected: readBudgetReview(params)
  });
};

function readEnvelopeParams(
  input: Record<string, unknown>,
  jobKind: string
): Record<string, unknown> {
  if (readString(input, "jobKind", { required: true }) !== jobKind) {
    throw new InputError("jobKind is not supported by this handler");
  }
  const params = input.params;
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new InputError("params must be an object");
  }
  return params as Record<string, unknown>;
}

/** Queue handler. Builds the draft once; an existing draft or budget is never overwritten. */
export const draftBuildHandler: ToolFactory = (ports) => async (input) => {
  readEnvelopeParams(input, QUEUE_BUILD);
  const store = await ports.store();
  const policy = await requireBudgetPolicy(store);
  const previous = await store.getLatestDraft();
  if (previous && previous.status !== "discarded") return { status: "ok", built: false };
  if ((await store.listAssignmentMonths()).length > 0) {
    return { status: "ok", built: false, reason: "has-budget" };
  }

  const currentDate = today(ports);
  const currentMonth = currentDate.slice(0, 7);
  await assertEnvelopeDraft(store, currentMonth);
  const accounts = await store.listAccounts();
  const transactionsByMonth: Record<string, TransactionRecord[]> = {};
  for (const month of pickBasisMonths(await store.listTransactionMonths(), currentMonth)) {
    transactionsByMonth[month] = budgetRows(
      accounts,
      policy.isoCurrency,
      await store.listMonthTransactions(month),
      currentDate
    );
  }
  const build = buildDraft({
    transactionsByMonth,
    categories: await loadCategories(ports),
    currentMonth
  });
  if (build === null) return { status: "ok", built: false, reason: "no-history" };

  if (!(await store.createDraft(build, ports.now().toISOString(), policy))) throw staleBudget();
  return { status: "ok", built: true, lines: build.lines.length };
};

export const draftBuildToolHandler: ToolFactory = (ports) => async () =>
  draftBuildHandler(ports)({ jobKind: QUEUE_BUILD });

// Table group name to the legacy group id the stored taxonomy uses.
const LEGACY_GROUP: Readonly<Record<string, string>> = {
  Bills: "fixed",
  Everyday: "everyday",
  Fun: "personal",
  Savings: "savings-goals",
  Income: "income"
};

/**
 * Make sure every planned line has a live category. A line whose category is
 * missing (for example one added while adjusting the draft) is created in the
 * stored taxonomy and in the categories table; existing categories are untouched.
 */
async function plannedCategories(ports: WorkerPorts, draft: BudgetDraft): Promise<Category[]> {
  const live = await loadCategories(ports);
  const byId = new Map(live.map((category) => [category.id, category]));
  return draft.lines
    .filter((line) => !line.dropped && linePlanCents(line) > 0)
    .map((line) => {
      if (PROTECTED_KEYS.has(line.categoryKey))
        throw new InputError("protected_category", "income and transfers cannot be budgeted");
      const existing = byId.get(line.categoryKey);
      if (existing?.archived)
        throw new InputError(
          "archived_category",
          "a planned line points at an archived category; drop the line or unarchive the category"
        );
      return (
        existing ?? {
          id: line.categoryKey,
          name: line.categoryName,
          group: LEGACY_GROUP[line.groupName] ?? "everyday",
          archived: false
        }
      );
    });
}

/**
 * Starts a reviewed draft through one SQL revision gate. Missing categories,
 * assignment totals, activity and the started state commit together. A stale
 * review or competing edit leaves every dependent row unchanged.
 */
async function startDraft(ports: WorkerPorts, params: Record<string, unknown>) {
  const draftId = readString(params, "draftId", { required: true });
  const store = await ports.store();
  await assertEnvelopeDraft(store, today(ports).slice(0, 7));
  const expected = readBudgetReview(params);
  requireSameReview(expected, await requireBudgetPolicy(store));
  const draft = await store.getLatestDraft();
  if (draft === null || draft.id !== draftId) {
    throw new InputError("draft_not_found", "draftId does not name the current draft");
  }
  if (draft.status === "started") return { status: "ok", started: true, alreadyStarted: true };

  const categories = await plannedCategories(ports, draft);

  // Every line's total, its activity row and the started mark land in one atomic write. A
  // failure part-way changes nothing, and a retry reads the same inputs and writes the same rows.
  const month = today(ports).slice(0, 7);
  const ledger = (await store.getLedger(month))?.assignments ?? {};
  const assignments: { categoryId: string; amountCents: number }[] = [];
  const activity: ActivityInput[] = [];
  for (const line of draft.lines) {
    const amountCents = linePlanCents(line);
    if (line.dropped || amountCents <= 0) continue;
    const previousCents = ledger[line.categoryKey] ?? 0;
    assignments.push({ categoryId: line.categoryKey, amountCents });
    if (previousCents !== amountCents) {
      activity.push({
        actor: "user",
        kind: "budget.assign",
        params: { month, categoryId: line.categoryKey, amountCents, previousCents },
        undo: { month, categoryId: line.categoryKey, amountCents: previousCents }
      });
    }
  }

  const applied = await store.commitBudgetChange({
    expected,
    categories,
    month,
    assignments,
    activity,
    startDraft: { draftId: draft.id, at: ports.now().toISOString() }
  });
  if (!applied) throw staleBudget();
  return { status: "ok", started: true, assigned: assignments.length };
}
export const draftStartHandler: ToolFactory = (ports) => async (input) =>
  startDraft(ports, readEnvelopeParams(input, QUEUE_START));
export const draftStartToolHandler: ToolFactory = (ports) => async (input) =>
  startDraft(ports, input);
