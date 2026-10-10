// external-modules/finance/src/domain/store-sql.ts
// FIN-06 (#1166, F6-D3): FinanceStore over module db.query (#1167). Every
// statement here IS the contract — string-equality tested, since a drift
// silently changes what RLS sees. Owner is always written in the SQL text
// via app.current_actor_user_id(), never a param, and no statement filters
// by owner (RLS + that GUC own that, per the #1167 classifier's read).
import type {
  AccountRecord,
  ItemErrorDetail,
  ItemRecord,
  ReviewState,
  TransactionRecord
} from "./records.js";
import type { BudgetDraft, DraftLine } from "./draft.js";
import type { FinanceStore } from "./store-port.js";

// Structural twin of #1167 ctx.db — domain files never import @moss/*, so
// this is redeclared rather than imported (bundler independence, see
// kv-port.ts).
export interface FinanceDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

// "2026-07" -> ["2026-07-01", "2026-08-01") — half-open so date indexes serve it.
function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

const TXN_COLUMNS =
  "id, account_id, date::text AS date, amount_cents, iso_currency, name, merchant, " +
  "plaid_category, category_id, pending, pending_transaction_id, categorized_by, notes, review_state, ai_confidence";

type TransactionRow = {
  id: string;
  account_id: string;
  date: string;
  amount_cents: string | number;
  iso_currency: string;
  name: string;
  merchant: string | null;
  plaid_category: string | null;
  category_id: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  categorized_by: TransactionRecord["categorizedBy"];
  notes: string | null;
  review_state: ReviewState;
  ai_confidence: number | null;
};

function rowToTransaction(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.date,
    amountCents: Number(row.amount_cents),
    isoCurrency: row.iso_currency,
    name: row.name,
    merchant: row.merchant,
    plaidCategory: row.plaid_category,
    categoryId: row.category_id,
    pending: row.pending,
    pendingTransactionId: row.pending_transaction_id,
    categorizedBy: row.categorized_by,
    notes: row.notes ?? undefined,
    reviewState: row.review_state,
    aiConfidence: row.ai_confidence
  };
}

async function upsertTransaction(db: FinanceDb, record: TransactionRecord): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_transactions (owner_user_id, id, account_id, date, amount_cents, " +
      "iso_currency, name, merchant, plaid_category, category_id, pending, " +
      "pending_transaction_id, categorized_by, notes, review_state, ai_confidence) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) " +
      "ON CONFLICT (owner_user_id, id) DO UPDATE SET account_id = EXCLUDED.account_id, " +
      "date = EXCLUDED.date, amount_cents = EXCLUDED.amount_cents, iso_currency = EXCLUDED.iso_currency, " +
      "name = EXCLUDED.name, merchant = EXCLUDED.merchant, plaid_category = EXCLUDED.plaid_category, " +
      "category_id = EXCLUDED.category_id, pending = EXCLUDED.pending, " +
      "pending_transaction_id = EXCLUDED.pending_transaction_id, " +
      "categorized_by = EXCLUDED.categorized_by, notes = EXCLUDED.notes, " +
      "review_state = EXCLUDED.review_state, ai_confidence = EXCLUDED.ai_confidence",
    [
      record.id,
      record.accountId,
      record.date,
      record.amountCents,
      record.isoCurrency,
      record.name,
      record.merchant ?? null,
      record.plaidCategory ?? null,
      record.categoryId ?? null,
      record.pending,
      record.pendingTransactionId ?? null,
      record.categorizedBy ?? null,
      record.notes ?? null,
      record.reviewState ?? (record.categoryId == null ? "needs_look" : "confirmed"),
      record.aiConfidence ?? null
    ]
  );
}

const ITEM_COLUMNS =
  "item_id, institution_id, institution_name, connected_at, status, last_sync_at, last_error, " +
  "last_error_detail";

type ItemRow = {
  item_id: string;
  institution_id: string | null;
  institution_name?: string | null;
  connected_at: string;
  status: ItemRecord["status"];
  last_sync_at: string | null;
  last_error: string | null;
  last_error_detail?: string | null;
};

function parseErrorDetail(raw: string | null | undefined): ItemErrorDetail | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ItemErrorDetail;
  } catch {
    return undefined;
  }
}

function rowToItem(row: ItemRow): ItemRecord {
  return {
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name ?? undefined,
    connectedAt: row.connected_at,
    status: row.status,
    lastSyncAt: row.last_sync_at ?? undefined,
    lastError: row.last_error ?? undefined,
    lastErrorDetail: parseErrorDetail(row.last_error_detail)
  };
}

const ACCOUNT_COLUMNS =
  "account_id, item_id, name, official_name, type, subtype, mask, balance_cents, " +
  "iso_currency, updated_at, shared_to_household";

type AccountRow = {
  account_id: string;
  item_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balance_cents: string | number;
  iso_currency: string;
  updated_at: string;
  shared_to_household: boolean;
};

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    accountId: row.account_id,
    itemId: row.item_id,
    name: row.name,
    officialName: row.official_name,
    type: row.type,
    subtype: row.subtype,
    mask: row.mask,
    balanceCents: Number(row.balance_cents),
    isoCurrency: row.iso_currency,
    updatedAt: row.updated_at,
    sharedToHousehold: row.shared_to_household
  };
}

type DraftRow = {
  id: string;
  status: BudgetDraft["status"];
  basis_from: string;
  basis_to: string;
  monthly_income_cents: string | number;
  created_at: string | Date;
  started_at: string | Date | null;
};

type DraftLineRow = {
  category_key: string;
  group_name: string;
  category_name: string;
  basis_monthly_cents: string | number;
  proposed_cents: string | number;
  adjusted_cents: string | number | null;
  adjusted_by: DraftLine["adjustedBy"];
  dropped: boolean;
};

const isoText = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : value;

function rowToDraftLine(row: DraftLineRow): DraftLine {
  return {
    categoryKey: row.category_key,
    groupName: row.group_name,
    categoryName: row.category_name,
    basisMonthlyCents: Number(row.basis_monthly_cents),
    proposedCents: Number(row.proposed_cents),
    adjustedCents: row.adjusted_cents === null ? null : Number(row.adjusted_cents),
    adjustedBy: row.adjusted_by,
    dropped: row.dropped
  };
}

function rowToDraft(row: DraftRow, lines: DraftLine[]): BudgetDraft {
  return {
    id: row.id,
    status: row.status,
    basisFrom: row.basis_from,
    basisTo: row.basis_to,
    monthlyIncomeCents: Number(row.monthly_income_cents),
    createdAt: isoText(row.created_at),
    startedAt: row.started_at === null ? null : isoText(row.started_at),
    lines
  };
}

export function sqlStore(db: FinanceDb): FinanceStore {
  return {
    async listItems() {
      const result = await db.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM app.finance_items`);
      return result.rows.map(rowToItem);
    },

    async getItem(itemId) {
      const result = await db.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM app.finance_items WHERE item_id = $1`,
        [itemId]
      );
      return result.rows.length === 0 ? null : rowToItem(result.rows[0]!);
    },

    async putItem(record) {
      await db.query(
        "INSERT INTO app.finance_items (owner_user_id, item_id, institution_id, institution_name, " +
          "connected_at, status, last_sync_at, last_error, last_error_detail) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8) " +
          "ON CONFLICT (owner_user_id, item_id) DO UPDATE SET institution_id = EXCLUDED.institution_id, " +
          "institution_name = EXCLUDED.institution_name, " +
          "connected_at = EXCLUDED.connected_at, status = EXCLUDED.status, " +
          "last_sync_at = EXCLUDED.last_sync_at, last_error = EXCLUDED.last_error, " +
          "last_error_detail = EXCLUDED.last_error_detail",
        [
          record.itemId,
          record.institutionId ?? null,
          record.institutionName ?? null,
          record.connectedAt,
          record.status,
          record.lastSyncAt ?? null,
          record.lastError ?? null,
          record.lastErrorDetail ? JSON.stringify(record.lastErrorDetail) : null
        ]
      );
    },

    async listAccounts() {
      const result = await db.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM app.finance_accounts`
      );
      return result.rows.map(rowToAccount);
    },

    async getAccount(accountId) {
      const result = await db.query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM app.finance_accounts WHERE account_id = $1`,
        [accountId]
      );
      return result.rows.length === 0 ? null : rowToAccount(result.rows[0]!);
    },

    async putAccount(record) {
      await db.query(
        "INSERT INTO app.finance_accounts (owner_user_id, account_id, item_id, name, official_name, " +
          "type, subtype, mask, balance_cents, iso_currency, updated_at, shared_to_household) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) " +
          "ON CONFLICT (owner_user_id, account_id) DO UPDATE SET item_id = EXCLUDED.item_id, " +
          "name = EXCLUDED.name, official_name = EXCLUDED.official_name, type = EXCLUDED.type, " +
          "subtype = EXCLUDED.subtype, mask = EXCLUDED.mask, balance_cents = EXCLUDED.balance_cents, " +
          "iso_currency = EXCLUDED.iso_currency, updated_at = EXCLUDED.updated_at, " +
          "shared_to_household = EXCLUDED.shared_to_household",
        [
          record.accountId,
          record.itemId,
          record.name,
          record.officialName ?? null,
          record.type,
          record.subtype ?? null,
          record.mask ?? null,
          record.balanceCents,
          record.isoCurrency,
          record.updatedAt,
          record.sharedToHousehold ?? false
        ]
      );
    },

    async listTransactionMonths() {
      const result = await db.query<{ month: string }>(
        "SELECT DISTINCT left(date::text, 7) AS month FROM app.finance_transactions ORDER BY month DESC"
      );
      return result.rows.map((row) => row.month);
    },

    async listMonthTransactions(month) {
      const { from, to } = monthWindow(month);
      const result = await db.query<TransactionRow>(
        `SELECT ${TXN_COLUMNS} FROM app.finance_transactions ` +
          "WHERE date >= $1 AND date < $2 ORDER BY date DESC, id ASC",
        [from, to]
      );
      return result.rows.map(rowToTransaction);
    },

    async listConfirmedPayeeNames() {
      const result = await db.query<{ name: string }>(
        "SELECT DISTINCT name FROM app.finance_transactions " +
          "WHERE review_state = 'confirmed' AND category_id IS NOT NULL"
      );
      return result.rows.map((row) => row.name);
    },

    async getTransactionChunk(accountId, month) {
      const { from, to } = monthWindow(month);
      const result = await db.query<TransactionRow>(
        `SELECT ${TXN_COLUMNS} FROM app.finance_transactions ` +
          "WHERE account_id = $1 AND date >= $2 AND date < $3 ORDER BY date DESC, id ASC",
        [accountId, from, to]
      );
      return result.rows.length === 0 ? null : result.rows.map(rowToTransaction);
    },

    async putTransactionChunk(accountId, month, records) {
      for (const record of records) {
        await upsertTransaction(db, record);
      }
      const { from, to } = monthWindow(month);
      await db.query(
        "DELETE FROM app.finance_transactions WHERE account_id = $1 AND date >= $2 AND date < $3 " +
          "AND NOT (id = ANY($4::text[]))",
        [accountId, from, to, records.map((record) => record.id)]
      );
    },

    async putTransaction(record) {
      await upsertTransaction(db, record);
    },

    async listSnapshotChunks() {
      const result = await db.query<{ account_id: string; month: string }>(
        "SELECT DISTINCT account_id, left(day::text, 7) AS month FROM app.finance_balance_snapshots " +
          "ORDER BY account_id, month"
      );
      return result.rows.map((row) => ({ accountId: row.account_id, month: row.month }));
    },

    async getSnapshotChunk(accountId, month) {
      const { from, to } = monthWindow(month);
      const result = await db.query<{ day: string; balance_cents: string | number }>(
        "SELECT day::text AS day, balance_cents FROM app.finance_balance_snapshots " +
          "WHERE account_id = $1 AND day >= $2 AND day < $3",
        [accountId, from, to]
      );
      if (result.rows.length === 0) return null;
      const days: Record<string, number> = {};
      for (const row of result.rows) days[row.day] = Number(row.balance_cents);
      return days;
    },

    async putSnapshotChunk(accountId, month, days) {
      for (const [day, balanceCents] of Object.entries(days)) {
        await db.query(
          "INSERT INTO app.finance_balance_snapshots (owner_user_id, account_id, day, balance_cents) " +
            "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
            "ON CONFLICT (owner_user_id, account_id, day) DO UPDATE SET balance_cents = EXCLUDED.balance_cents",
          [accountId, day, balanceCents]
        );
      }
    },

    async listAssignmentMonths() {
      const result = await db.query<{ month: string }>(
        "SELECT DISTINCT month FROM app.finance_budget_assignments ORDER BY month"
      );
      return result.rows.map((row) => row.month);
    },

    async getLedger(month) {
      const result = await db.query<{ category_id: string; assigned_cents: string | number }>(
        "SELECT category_id, assigned_cents FROM app.finance_budget_assignments WHERE month = $1",
        [month]
      );
      if (result.rows.length === 0) return null;
      const assignments: Record<string, number> = {};
      for (const row of result.rows) assignments[row.category_id] = Number(row.assigned_cents);
      return { assignments };
    },

    async setAssignment(month, categoryId, amountCents) {
      await db.query(
        "INSERT INTO app.finance_budget_assignments (owner_user_id, month, category_id, assigned_cents) " +
          "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
          "ON CONFLICT (owner_user_id, month, category_id) DO UPDATE SET assigned_cents = EXCLUDED.assigned_cents",
        [month, categoryId, amountCents]
      );
    },

    async appendActivity(entry) {
      await db.query(
        "INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params, undo) " +
          "VALUES (app.current_actor_user_id(), gen_random_uuid(), now(), $1, $2, $3::jsonb, $4::jsonb)",
        [
          entry.actor,
          entry.kind,
          JSON.stringify(entry.params),
          entry.undo ? JSON.stringify(entry.undo) : null
        ]
      );
    },

    async lastLoggedAssignment(month, categoryId) {
      const result = await db.query<{ amount: string | number }>(
        "SELECT params->>'amountCents' AS amount FROM app.finance_activity " +
          "WHERE kind = 'budget.assign' AND params->>'month' = $1 AND params->>'categoryId' = $2 " +
          "ORDER BY at DESC LIMIT 1",
        [month, categoryId]
      );
      const row = result.rows[0];
      return row === undefined ? null : Number(row.amount);
    },

    async getLatestDraft() {
      const head = await db.query<DraftRow>(
        "SELECT id, status, basis_from::text AS basis_from, basis_to::text AS basis_to, " +
          "monthly_income_cents, created_at, started_at FROM app.finance_budget_drafts " +
          "WHERE status IN ('open', 'started') ORDER BY created_at DESC LIMIT 1"
      );
      const row = head.rows[0];
      if (row === undefined) return null;
      const lines = await db.query<DraftLineRow>(
        "SELECT category_key, group_name, category_name, basis_monthly_cents, proposed_cents, " +
          "adjusted_cents, adjusted_by, dropped FROM app.finance_budget_draft_lines " +
          "WHERE draft_id = $1 ORDER BY category_key",
        [row.id]
      );
      return rowToDraft(row, lines.rows.map(rowToDraftLine));
    },

    // The draft goes in as 'discarded' and flips to 'open' last, so a worker that dies
    // part-way leaves no half-written draft for the screen to read.
    async createDraft(build, createdAt) {
      await db.query(
        "UPDATE app.finance_budget_drafts SET status = 'discarded' WHERE status = 'open'"
      );
      const created = await db.query<{ id: string }>(
        "INSERT INTO app.finance_budget_drafts (owner_user_id, id, status, basis_from, basis_to, " +
          "monthly_income_cents, created_at) " +
          "VALUES (app.current_actor_user_id(), gen_random_uuid(), 'discarded', $1, $2, $3, $4) RETURNING id",
        [build.basisFrom, build.basisTo, build.monthlyIncomeCents, createdAt]
      );
      const draftId = created.rows[0]!.id;
      for (const line of build.lines) {
        await db.query(
          "INSERT INTO app.finance_budget_draft_lines (owner_user_id, draft_id, category_key, " +
            "group_name, category_name, basis_monthly_cents, proposed_cents) " +
            "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6)",
          [
            draftId,
            line.categoryKey,
            line.groupName,
            line.categoryName,
            line.basisMonthlyCents,
            line.proposedCents
          ]
        );
      }
      await db.query("UPDATE app.finance_budget_drafts SET status = 'open' WHERE id = $1", [
        draftId
      ]);
      return draftId;
    },

    async markDraftStarted(draftId, startedAt) {
      await db.query(
        "UPDATE app.finance_budget_drafts SET status = 'started', started_at = $2 " +
          "WHERE id = $1 AND status = 'open'",
        [draftId, startedAt]
      );
    }
  } satisfies FinanceStore;
}
