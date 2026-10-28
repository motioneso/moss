import type { ManualLedgerStore } from "./manual-ledger.js";
import type { FinanceDb } from "./store-sql.js";

/** All balance changes depend on inserted rows; conflict replays cannot move a balance twice. */
export function manualSqlStore(db: FinanceDb): ManualLedgerStore {
  return {
    async createAccount(input) {
      const changed = await db.query<{ account_id: string }>(
        `WITH inserted AS (
          INSERT INTO app.finance_accounts
            (owner_user_id, account_id, item_id, name, type, subtype, balance_cents,
             iso_currency, updated_at, source, opening_date, opening_balance_cents, creation_digest)
          VALUES (app.current_actor_user_id(), $1, NULL, $2, $3, $4, $5, $6, $7, 'manual', $8, $5, $9)
          ON CONFLICT (owner_user_id, account_id) DO NOTHING RETURNING account_id
        ), logged AS (
          INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params)
          SELECT app.current_actor_user_id(), gen_random_uuid(), $7::timestamptz, 'user',
                 'account.create', $10::jsonb FROM inserted RETURNING id
        ) SELECT account_id FROM inserted`,
        [
          input.accountId,
          input.name,
          input.type,
          input.subtype,
          input.openingBalanceCents,
          input.isoCurrency,
          input.at,
          input.openingDate,
          input.digest,
          JSON.stringify({
            accountId: input.accountId,
            openingBalanceCents: input.openingBalanceCents
          })
        ]
      );
      if (changed.rows.length) return "created";
      const prior = await db.query<{ source: string; creation_digest: string | null }>(
        "SELECT source, creation_digest FROM app.finance_accounts WHERE account_id = $1",
        [input.accountId]
      );
      return prior.rows[0]?.source === "manual" && prior.rows[0]?.creation_digest === input.digest
        ? "unchanged"
        : "conflict";
    },
    async createEntry(input) {
      const changed = await db.query<{ id: string }>(
        `WITH locked AS (
          SELECT account_id, balance_cents, type, iso_currency, opening_date, archived_at
          FROM app.finance_accounts WHERE account_id = $1 AND source = 'manual' FOR UPDATE
        ), inserted AS (
          INSERT INTO app.finance_transactions
            (owner_user_id, id, account_id, date, name, amount_cents, iso_currency,
             category_id, notes, pending, categorized_by, review_state, source, entry_digest, cleared)
          SELECT app.current_actor_user_id(), $2, account_id, $3::date, $4, $5::bigint, $6,
                 $7, $8, false, 'user', CASE WHEN $7::text IS NULL THEN 'needs_look' ELSE 'confirmed' END,
                 'manual', $9, $10 FROM locked
          WHERE archived_at IS NULL AND iso_currency = $6 AND $3::date >= opening_date
            AND balance_cents::numeric + (CASE WHEN type IN ('credit', 'loan') THEN 1 ELSE -1 END) * $5::bigint
                BETWEEN -9007199254740991 AND 9007199254740991
          ON CONFLICT (owner_user_id, id) DO NOTHING RETURNING id, amount_cents, account_id
        ), balanced AS (
          UPDATE app.finance_accounts a SET
            balance_cents = a.balance_cents + (CASE WHEN a.type IN ('credit', 'loan') THEN 1 ELSE -1 END) * i.amount_cents,
            ledger_revision = a.ledger_revision + 1, updated_at = $11
          FROM inserted i WHERE a.account_id = i.account_id RETURNING a.account_id
        ), logged AS (
          INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params)
          SELECT app.current_actor_user_id(), gen_random_uuid(), $11::timestamptz, 'user',
                 'transaction.create', $12::jsonb FROM inserted i JOIN balanced b ON b.account_id = i.account_id RETURNING id
        ) SELECT id FROM inserted`,
        [
          input.accountId,
          input.id,
          input.date,
          input.name,
          input.amountCents,
          input.isoCurrency,
          input.categoryId,
          input.notes || null,
          input.digest,
          input.cleared,
          input.at,
          JSON.stringify({
            accountId: input.accountId,
            transactionId: input.id,
            amountCents: input.amountCents
          })
        ]
      );
      if (changed.rows.length) return "created";
      const prior = await db.query<{ source: string; entry_digest: string | null }>(
        "SELECT source, entry_digest FROM app.finance_transactions WHERE id = $1",
        [input.id]
      );
      if (prior.rows.length)
        return prior.rows[0]?.source === "manual" && prior.rows[0]?.entry_digest === input.digest
          ? "unchanged"
          : "conflict";
      const accounts = await db.query<{
        opening_date: string;
        archived_at: unknown;
        iso_currency: string;
      }>(
        "SELECT opening_date::text AS opening_date, archived_at, iso_currency FROM app.finance_accounts WHERE account_id = $1 AND source = 'manual'",
        [input.accountId]
      );
      const account = accounts.rows[0];
      if (!account || account.archived_at || account.iso_currency !== input.isoCurrency)
        return "unavailable";
      if (input.date < account.opening_date) return "invalid_date";
      return "overflow";
    }
  };
}
