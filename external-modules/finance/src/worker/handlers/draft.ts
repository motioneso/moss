// external-modules/finance/src/worker/handlers/draft.ts
//
// #3180 (Finance R1): the first-budget draft. Three entry points share one record.
//   finance.budget.draft.get  read tool: the draft as the screen and Moss see it
//   finance.draft-build       queue: builds the draft from the stored history
//   finance.draft-start       queue: turns the draft into this month's budget
// There is deliberately no assistant tool that starts a draft. Starting runs only
// from the screen's button, through the queue (spec: First budget, step 7).
import {
  CATEGORY_GROUP_NAMES,
  DEFAULT_CATEGORIES,
  NS,
  DRAFT_AMOUNT_MAX_CENTS,
  DRAFT_CATEGORY_KEY_RE,
  DRAFT_LINE_GROUPS,
  applyLineEdit,
  buildDraft,
  draftTotalCents,
  draftUnplannedCents,
  linePlanCents,
  pickBasisMonths,
  tableGroupFor,
  type BudgetDraft,
  type Category,
  type TransactionRecord
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

const QUEUE_BUILD = "finance.draft-build";
const QUEUE_START = "finance.draft-start";
const QUEUE_SET = "finance.draft-set";

export interface DraftViewLine {
  categoryKey: string;
  categoryName: string;
  basisMonthlyCents: number;
  planCents: number;
  dropped: boolean;
  /** Set only when Moss changed the line in chat; typed changes carry no badge. */
  changedByMoss: boolean;
  proposedCents: number;
}

export interface DraftView {
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
export function draftView(draft: BudgetDraft): DraftView {
  const order = (name: string): number => {
    const index = (CATEGORY_GROUP_NAMES as readonly string[]).indexOf(name);
    return index === -1 ? CATEGORY_GROUP_NAMES.length : index;
  };
  const groups = new Map<string, DraftViewLine[]>();
  for (const line of draft.lines) {
    const lines = groups.get(line.groupName) ?? [];
    lines.push({
      categoryKey: line.categoryKey,
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
  const latest = await store.getLatestDraft();
  const items = await store.listItems();
  const hasBudget = (await store.listAssignmentMonths()).length > 0;
  return {
    hasSynced: items.some((item) => item.lastSyncAt !== undefined),
    hasBudget,
    draft: latest ? draftView(latest) : null
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
  }
): Promise<DraftEditResult> {
  const store = await ports.store();
  const draft = await store.getLatestDraft();
  if (draft === null || draft.id !== args.draftId) {
    throw new InputError("draft_not_found", "draftId does not name the current draft");
  }
  if (draft.status !== "open") {
    throw new InputError("draft_not_open", "the draft has already been started");
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
  await store.saveDraftLine(draft.id, line);

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
    by: "moss"
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
  return editDraftLine(ports, { draftId, categoryKey, edit: { amountCents }, by: "user" });
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
  if ((await store.getLatestDraft()) !== null) return { status: "ok", built: false };
  if ((await store.listAssignmentMonths()).length > 0) {
    return { status: "ok", built: false, reason: "has-budget" };
  }

  const currentMonth = ports.now().toISOString().slice(0, 7);
  const transactionsByMonth: Record<string, TransactionRecord[]> = {};
  for (const month of pickBasisMonths(await store.listTransactionMonths(), currentMonth)) {
    transactionsByMonth[month] = await store.listMonthTransactions(month);
  }
  const build = buildDraft({
    transactionsByMonth,
    categories: await loadCategories(ports),
    currentMonth
  });
  if (build === null) return { status: "ok", built: false, reason: "no-history" };

  await store.createDraft(build, ports.now().toISOString());
  return { status: "ok", built: true, lines: build.lines.length };
};

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
async function ensureCategories(ports: WorkerPorts, draft: BudgetDraft): Promise<void> {
  const live = await loadCategories(ports);
  const known = new Set(live.map((category) => category.id));
  const missing = draft.lines.filter((line) => !line.dropped && !known.has(line.categoryKey));
  if (missing.length === 0) return;

  const created: Category[] = missing.map((line) => ({
    id: line.categoryKey,
    group: LEGACY_GROUP[line.groupName] ?? "everyday",
    name: line.categoryName,
    archived: false
  }));
  const taxonomy = [...(live.length > 0 ? live : DEFAULT_CATEGORIES), ...created];
  await ports.kv.set(NS.categories, "taxonomy", {
    categories: taxonomy
  } as unknown as Record<string, unknown>);

  if (ports.db) {
    for (const [offset, category] of created.entries()) {
      await ports.db.query(
        "INSERT INTO app.finance_categories (owner_user_id, id, group_name, name, sort_order, " +
          "is_income, archived_at) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, false, NULL) " +
          "ON CONFLICT (owner_user_id, id) DO NOTHING",
        [category.id, tableGroupFor(category.group), category.name, live.length + offset]
      );
    }
  }
}

/**
 * Queue handler behind the screen's "Start this budget" button. Creates any
 * missing categories, sets this month's assignment for every planned line, logs
 * each change, and marks the draft started last. Assignments are set totals and
 * the mark is the final write, so a retry after a crash converges.
 */
export const draftStartHandler: ToolFactory = (ports) => async (input) => {
  const params = readEnvelopeParams(input, QUEUE_START);
  const draftId = readString(params, "draftId", { required: true });
  const store = await ports.store();
  const draft = await store.getLatestDraft();
  if (draft === null || draft.id !== draftId) {
    throw new InputError("draft_not_found", "draftId does not name the current draft");
  }
  if (draft.status === "started") return { status: "ok", started: true, alreadyStarted: true };

  await ensureCategories(ports, draft);

  const month = ports.now().toISOString().slice(0, 7);
  let assigned = 0;
  for (const line of draft.lines) {
    const amountCents = linePlanCents(line);
    if (line.dropped || amountCents <= 0) continue;
    const previousCents = (await store.getLedger(month))?.assignments[line.categoryKey] ?? 0;
    await store.setAssignment(month, line.categoryKey, amountCents);
    if (previousCents !== amountCents) {
      await store.appendActivity({
        actor: "user",
        kind: "budget.assign",
        params: { month, categoryId: line.categoryKey, amountCents, previousCents },
        undo: { month, categoryId: line.categoryKey, amountCents: previousCents }
      });
    }
    assigned += 1;
  }

  await store.markDraftStarted(draft.id, ports.now().toISOString());
  return { status: "ok", started: true, assigned };
};
