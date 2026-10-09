// tests/unit/finance-store-sql.test.ts
// FIN-06b (#1166) Task 5: sqlStore(db) must satisfy the FinanceStore port
// over module db.query (#1167). The statements ARE the contract — asserted
// by exact string equality — because a later drift here silently changes
// what RLS sees (owner is written via app.current_actor_user_id() in the SQL
// text, never a param).
import { describe, expect, it } from "vitest";

import type { FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import { sqlStore } from "../../external-modules/finance/src/domain/index.js";
import type {
  AccountRecord,
  ItemRecord,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";

type Call = { text: string; params: readonly unknown[] };

function fakeDb(queuedRows: readonly Record<string, unknown>[][] = []): FinanceDb & {
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...queuedRows];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const rows = queue.length > 0 ? queue.shift()! : [];
      return { rows: rows as never[] };
    }
  };
}

function tx(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    accountId: "acc1",
    date: "2026-07-10",
    amountCents: 1234,
    isoCurrency: "USD",
    name: "COFFEE SHOP",
    merchant: "Coffee Shop",
    plaidCategory: "FOOD_AND_DRINK",
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    reviewState: "confirmed",
    aiConfidence: null,
    ...over
  };
}

describe("sqlStore (FIN-06b #1166)", () => {
  it("getTransactionChunk selects the half-open month window sorted date DESC, id ASC", async () => {
    const db = fakeDb([
      [
        {
          id: "a",
          account_id: "acc1",
          date: "2026-07-10",
          amount_cents: "1234",
          iso_currency: "USD",
          name: "COFFEE SHOP",
          merchant: "Coffee Shop",
          plaid_category: "FOOD_AND_DRINK",
          category_id: null,
          pending: false,
          pending_transaction_id: null,
          categorized_by: null,
          notes: null,
          review_state: "confirmed",
          ai_confidence: null
        }
      ]
    ]);
    const store = sqlStore(db);
    const rows = await store.getTransactionChunk("acc1", "2026-07");

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.text).toBe(
      "SELECT id, account_id, date::text AS date, amount_cents, iso_currency, name, merchant, " +
        "plaid_category, category_id, pending, pending_transaction_id, categorized_by, notes, review_state, ai_confidence " +
        "FROM app.finance_transactions " +
        "WHERE account_id = $1 AND date >= $2 AND date < $3 ORDER BY date DESC, id ASC"
    );
    expect(db.calls[0]!.params).toEqual(["acc1", "2026-07-01", "2026-08-01"]);
    expect(rows).toEqual([tx({ id: "a", amountCents: 1234 })]);
  });

  it("listConfirmedPayeeNames selects distinct names of categorized, confirmed rows", async () => {
    const db = fakeDb([[{ name: "COFFEE SHOP" }, { name: "TRADER JOES #1" }]]);
    const names = await sqlStore(db).listConfirmedPayeeNames();
    expect(db.calls[0]!.text).toBe(
      "SELECT DISTINCT name FROM app.finance_transactions " +
        "WHERE review_state = 'confirmed' AND category_id IS NOT NULL"
    );
    expect(names).toEqual(["COFFEE SHOP", "TRADER JOES #1"]);
  });

  it("putTransaction writes a needs_look row with its AI confidence", async () => {
    const db = fakeDb();
    await sqlStore(db).putTransaction(
      tx({ id: "n", categoryId: "dining", reviewState: "needs_look", aiConfidence: 0.42 })
    );
    expect(db.calls[0]!.params.slice(-2)).toEqual(["needs_look", 0.42]);
  });

  it("putTransaction stores an uncategorized row with no review state as needs_look", async () => {
    const db = fakeDb();
    const { reviewState: _drop, ...bare } = tx({ id: "u", categoryId: null });
    await sqlStore(db).putTransaction(bare);
    expect(db.calls[0]!.params.slice(-2)).toEqual(["needs_look", null]);
  });

  it("getTransactionChunk returns null on zero rows", async () => {
    const store = sqlStore(fakeDb([[]]));
    expect(await store.getTransactionChunk("acc1", "2026-07")).toBeNull();
  });

  it("getTransactionChunk pins the December month-window rollover", async () => {
    const db = fakeDb([[]]);
    const store = sqlStore(db);
    await store.getTransactionChunk("acc1", "2026-12");
    expect(db.calls[0]!.params).toEqual(["acc1", "2026-12-01", "2027-01-01"]);
  });

  it("putTransactionChunk issues upsert-then-prune in that order, owner written via app.current_actor_user_id()", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    await store.putTransactionChunk("acc1", "2026-07", [
      tx({ id: "a" }),
      tx({ id: "b", merchant: null, plaidCategory: null, categoryId: "groceries" })
    ]);

    expect(db.calls).toHaveLength(3);
    for (const call of db.calls.slice(0, 2)) {
      expect(call.text).toBe(
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
          "review_state = EXCLUDED.review_state, ai_confidence = EXCLUDED.ai_confidence"
      );
    }
    expect(db.calls[0]!.params).toEqual([
      "a",
      "acc1",
      "2026-07-10",
      1234,
      "USD",
      "COFFEE SHOP",
      "Coffee Shop",
      "FOOD_AND_DRINK",
      null,
      false,
      null,
      null,
      null,
      "confirmed",
      null
    ]);
    expect(db.calls[1]!.params).toEqual([
      "b",
      "acc1",
      "2026-07-10",
      1234,
      "USD",
      "COFFEE SHOP",
      null,
      null,
      "groceries",
      false,
      null,
      null,
      null,
      "confirmed",
      null
    ]);
    expect(db.calls[2]!.text).toBe(
      "DELETE FROM app.finance_transactions WHERE account_id = $1 AND date >= $2 AND date < $3 " +
        "AND NOT (id = ANY($4::text[]))"
    );
    expect(db.calls[2]!.params).toEqual(["acc1", "2026-07-01", "2026-08-01", ["a", "b"]]);
  });

  it("listMonthTransactions selects the month window across all accounts, sorted date DESC id ASC", async () => {
    const db = fakeDb([
      [
        {
          id: "b",
          account_id: "acc2",
          date: "2026-07-15",
          amount_cents: "500",
          iso_currency: "USD",
          name: "GYM",
          merchant: null,
          plaid_category: null,
          category_id: null,
          pending: false,
          pending_transaction_id: null,
          categorized_by: null,
          notes: null,
          review_state: "confirmed",
          ai_confidence: null
        }
      ]
    ]);
    const store = sqlStore(db);
    const rows = await store.listMonthTransactions("2026-07");

    expect(db.calls[0]!.text).toBe(
      "SELECT id, account_id, date::text AS date, amount_cents, iso_currency, name, merchant, " +
        "plaid_category, category_id, pending, pending_transaction_id, categorized_by, notes, review_state, ai_confidence " +
        "FROM app.finance_transactions " +
        "WHERE date >= $1 AND date < $2 ORDER BY date DESC, id ASC"
    );
    expect(db.calls[0]!.params).toEqual(["2026-07-01", "2026-08-01"]);
    expect(rows).toEqual([
      tx({
        id: "b",
        accountId: "acc2",
        date: "2026-07-15",
        amountCents: 500,
        name: "GYM",
        merchant: null,
        plaidCategory: null
      })
    ]);
  });

  it("putTransaction upserts exactly one row, no prune", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    await store.putTransaction(tx({ id: "a" }));

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.text).toBe(
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
        "review_state = EXCLUDED.review_state, ai_confidence = EXCLUDED.ai_confidence"
    );
    expect(db.calls[0]!.params).toEqual([
      "a",
      "acc1",
      "2026-07-10",
      1234,
      "USD",
      "COFFEE SHOP",
      "Coffee Shop",
      "FOOD_AND_DRINK",
      null,
      false,
      null,
      null,
      null,
      "confirmed",
      null
    ]);
  });

  it("listTransactionMonths selects distinct months newest-first", async () => {
    const db = fakeDb([[{ month: "2026-07" }, { month: "2026-05" }]]);
    const store = sqlStore(db);
    expect(await store.listTransactionMonths()).toEqual(["2026-07", "2026-05"]);
    expect(db.calls[0]!.text).toBe(
      "SELECT DISTINCT left(date::text, 7) AS month FROM app.finance_transactions ORDER BY month DESC"
    );
  });

  it("setAssignment upserts assigned_cents as a total via ON CONFLICT DO UPDATE", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    await store.setAssignment("2026-07", "groceries", 15000);

    expect(db.calls[0]!.text).toBe(
      "INSERT INTO app.finance_budget_assignments (owner_user_id, month, category_id, assigned_cents) " +
        "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
        "ON CONFLICT (owner_user_id, month, category_id) DO UPDATE SET assigned_cents = EXCLUDED.assigned_cents"
    );
    expect(db.calls[0]!.params).toEqual(["2026-07", "groceries", 15000]);
  });

  it("appendActivity inserts an owner-scoped row with json params and undo", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    await store.appendActivity({
      actor: "user",
      kind: "budget.assign",
      params: { month: "2026-07", amountCents: 100 },
      undo: { amountCents: 0 }
    });
    await store.appendActivity({ actor: "moss", kind: "x", params: {} });

    expect(db.calls[0]!.text).toBe(
      "INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params, undo) " +
        "VALUES (app.current_actor_user_id(), gen_random_uuid(), now(), $1, $2, $3::jsonb, $4::jsonb)"
    );
    expect(db.calls[0]!.params).toEqual([
      "user",
      "budget.assign",
      '{"month":"2026-07","amountCents":100}',
      '{"amountCents":0}'
    ]);
    expect(db.calls[1]!.params).toEqual(["moss", "x", "{}", null]);
  });

  it("getLedger builds {assignments} with Number(assigned_cents), null when empty", async () => {
    const db = fakeDb([
      [
        { category_id: "groceries", assigned_cents: "15000" },
        { category_id: "rent", assigned_cents: "200000" }
      ]
    ]);
    const store = sqlStore(db);
    expect(await store.getLedger("2026-07")).toEqual({
      assignments: { groceries: 15000, rent: 200000 }
    });
    expect(db.calls[0]!.text).toBe(
      "SELECT category_id, assigned_cents FROM app.finance_budget_assignments WHERE month = $1"
    );

    const empty = sqlStore(fakeDb([[]]));
    expect(await empty.getLedger("2026-08")).toBeNull();
  });

  it("listAssignmentMonths selects distinct months ascending", async () => {
    const db = fakeDb([[{ month: "2026-05" }, { month: "2026-07" }]]);
    const store = sqlStore(db);
    expect(await store.listAssignmentMonths()).toEqual(["2026-05", "2026-07"]);
    expect(db.calls[0]!.text).toBe(
      "SELECT DISTINCT month FROM app.finance_budget_assignments ORDER BY month"
    );
  });

  it("putItem upserts on item_id, getItem/listItems read back with connected_at::text", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const item: ItemRecord = {
      itemId: "i1",
      institutionId: "ins_1",
      institutionName: "Sandbox First Bank",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected",
      lastSyncAt: "2026-07-18T00:00:00Z",
      lastError: undefined
    };
    await store.putItem(item);
    expect(db.calls[0]!.text).toBe(
      "INSERT INTO app.finance_items (owner_user_id, item_id, institution_id, institution_name, " +
        "connected_at, status, last_sync_at, last_error, last_error_detail) " +
        "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8) " +
        "ON CONFLICT (owner_user_id, item_id) DO UPDATE SET institution_id = EXCLUDED.institution_id, " +
        "institution_name = EXCLUDED.institution_name, " +
        "connected_at = EXCLUDED.connected_at, status = EXCLUDED.status, " +
        "last_sync_at = EXCLUDED.last_sync_at, last_error = EXCLUDED.last_error, " +
        "last_error_detail = EXCLUDED.last_error_detail"
    );
    expect(db.calls[0]!.params).toEqual([
      "i1",
      "ins_1",
      "Sandbox First Bank",
      "2026-07-01T00:00:00Z",
      "connected",
      "2026-07-18T00:00:00Z",
      null,
      null
    ]);
  });

  it("putItem stores the error detail as JSON and getItem parses it back", async () => {
    const detail = {
      type: "INVALID_REQUEST",
      code: "INVALID_PRODUCT",
      message: "m",
      requestId: "r"
    };
    const db = fakeDb();
    await sqlStore(db).putItem({
      itemId: "i1",
      institutionId: null,
      connectedAt: "2026-07-01T00:00:00Z",
      status: "error",
      lastError: "INVALID_PRODUCT",
      lastErrorDetail: detail
    });
    expect(db.calls[0]!.params![7]).toBe(JSON.stringify(detail));
    const read = sqlStore(
      fakeDb([
        [
          {
            item_id: "i1",
            institution_id: null,
            connected_at: "2026-07-01T00:00:00Z",
            status: "error",
            last_sync_at: null,
            last_error: "INVALID_PRODUCT",
            last_error_detail: JSON.stringify(detail)
          }
        ]
      ])
    );
    expect((await read.getItem("i1"))?.lastErrorDetail).toEqual(detail);
  });

  it("getItem returns one row by item_id, null when absent", async () => {
    const db = fakeDb([
      [
        {
          item_id: "i1",
          institution_id: null,
          connected_at: "2026-07-01T00:00:00Z",
          status: "connected",
          last_sync_at: null,
          last_error: null,
          last_error_detail: null
        }
      ]
    ]);
    const store = sqlStore(db);
    expect(await store.getItem("i1")).toEqual({
      itemId: "i1",
      institutionId: null,
      institutionName: undefined,
      connectedAt: "2026-07-01T00:00:00Z",
      status: "connected",
      lastSyncAt: undefined,
      lastError: undefined,
      lastErrorDetail: undefined
    });
    expect(db.calls[0]!.text).toBe(
      "SELECT item_id, institution_id, institution_name, connected_at, status, last_sync_at, last_error, " +
        "last_error_detail " +
        "FROM app.finance_items WHERE item_id = $1"
    );
    expect(await sqlStore(fakeDb([[]])).getItem("missing")).toBeNull();
  });

  it("listItems selects all rows with no WHERE", async () => {
    const db = fakeDb([[]]);
    const store = sqlStore(db);
    await store.listItems();
    expect(db.calls[0]!.text).toBe(
      "SELECT item_id, institution_id, institution_name, connected_at, status, last_sync_at, last_error, " +
        "last_error_detail " +
        "FROM app.finance_items"
    );
  });

  it("putAccount upserts on account_id including shared_to_household", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const account: AccountRecord = {
      accountId: "acc1",
      itemId: "i1",
      name: "Checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "0000",
      balanceCents: 500000,
      isoCurrency: "USD",
      updatedAt: "2026-07-18T00:00:00Z",
      sharedToHousehold: true
    };
    await store.putAccount(account);
    expect(db.calls[0]!.text).toBe(
      "INSERT INTO app.finance_accounts (owner_user_id, account_id, item_id, name, official_name, " +
        "type, subtype, mask, balance_cents, iso_currency, updated_at, shared_to_household) " +
        "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) " +
        "ON CONFLICT (owner_user_id, account_id) DO UPDATE SET item_id = EXCLUDED.item_id, " +
        "name = EXCLUDED.name, official_name = EXCLUDED.official_name, type = EXCLUDED.type, " +
        "subtype = EXCLUDED.subtype, mask = EXCLUDED.mask, balance_cents = EXCLUDED.balance_cents, " +
        "iso_currency = EXCLUDED.iso_currency, updated_at = EXCLUDED.updated_at, " +
        "shared_to_household = EXCLUDED.shared_to_household"
    );
    expect(db.calls[0]!.params).toEqual([
      "acc1",
      "i1",
      "Checking",
      null,
      "depository",
      "checking",
      "0000",
      500000,
      "USD",
      "2026-07-18T00:00:00Z",
      true
    ]);
  });

  it("getAccount/listAccounts map balance_cents with Number() and default shared_to_household false", async () => {
    const db = fakeDb([
      [
        {
          account_id: "acc1",
          item_id: "i1",
          name: "Checking",
          official_name: null,
          type: "depository",
          subtype: "checking",
          mask: "0000",
          balance_cents: "500000",
          iso_currency: "USD",
          updated_at: "2026-07-18T00:00:00Z",
          shared_to_household: false
        }
      ]
    ]);
    const store = sqlStore(db);
    expect(db.calls).toEqual([]);
    const result = await store.getAccount("acc1");
    expect(db.calls[0]!.text).toBe(
      "SELECT account_id, item_id, name, official_name, type, subtype, mask, balance_cents, " +
        "iso_currency, updated_at, shared_to_household FROM app.finance_accounts WHERE account_id = $1"
    );
    expect(result).toEqual({
      accountId: "acc1",
      itemId: "i1",
      name: "Checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "0000",
      balanceCents: 500000,
      isoCurrency: "USD",
      updatedAt: "2026-07-18T00:00:00Z",
      sharedToHousehold: false
    });
    expect(await sqlStore(fakeDb([[]])).getAccount("missing")).toBeNull();
  });

  it("listAccounts selects all rows with no WHERE", async () => {
    const db = fakeDb([[]]);
    const store = sqlStore(db);
    await store.listAccounts();
    expect(db.calls[0]!.text).toBe(
      "SELECT account_id, item_id, name, official_name, type, subtype, mask, balance_cents, " +
        "iso_currency, updated_at, shared_to_household FROM app.finance_accounts"
    );
  });

  it("putSnapshotChunk upserts one row per day on (owner, account, day)", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    await store.putSnapshotChunk("acc1", "2026-07", { "2026-07-01": 100, "2026-07-02": 150 });

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]!.text).toBe(
      "INSERT INTO app.finance_balance_snapshots (owner_user_id, account_id, day, balance_cents) " +
        "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
        "ON CONFLICT (owner_user_id, account_id, day) DO UPDATE SET balance_cents = EXCLUDED.balance_cents"
    );
    expect(db.calls[0]!.params).toEqual(["acc1", "2026-07-01", 100]);
    expect(db.calls[1]!.params).toEqual(["acc1", "2026-07-02", 150]);
  });

  it("getSnapshotChunk selects the month window keyed by day::text, null when empty", async () => {
    const db = fakeDb([[{ day: "2026-07-01", balance_cents: "100" }]]);
    const store = sqlStore(db);
    expect(await store.getSnapshotChunk("acc1", "2026-07")).toEqual({ "2026-07-01": 100 });
    expect(db.calls[0]!.text).toBe(
      "SELECT day::text AS day, balance_cents FROM app.finance_balance_snapshots " +
        "WHERE account_id = $1 AND day >= $2 AND day < $3"
    );
    expect(db.calls[0]!.params).toEqual(["acc1", "2026-07-01", "2026-08-01"]);
    expect(await sqlStore(fakeDb([[]])).getSnapshotChunk("acc1", "2026-08")).toBeNull();
  });

  it("listSnapshotChunks selects distinct (account_id, month)", async () => {
    const db = fakeDb([[{ account_id: "acc1", month: "2026-07" }]]);
    const store = sqlStore(db);
    expect(await store.listSnapshotChunks()).toEqual([{ accountId: "acc1", month: "2026-07" }]);
    expect(db.calls[0]!.text).toBe(
      "SELECT DISTINCT account_id, left(day::text, 7) AS month FROM app.finance_balance_snapshots " +
        "ORDER BY account_id, month"
    );
  });
});
