import type { TransferCorrectionStore } from "./transfer-corrections.js";
import {
  TRANSFER_SOURCE_SQL,
  TRANSFER_SOURCE_REVISION_SQL,
  TRANSFER_SOURCE_INTACT_SQL
} from "./transfer-review-sql.js";
import { commitManualTransfer } from "./store-manual-transfers-sql.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
export function transferCorrectionSqlStore(db: FinanceDb): TransferCorrectionStore {
  return {
    async read(transferId) {
      const result = await db.query<{
        id: string;
        from_account_id: string;
        from_name: string;
        to_account_id: string;
        to_name: string;
        date: string;
        amount_cents: string;
        iso_currency: string;
        revision: string;
        intact: boolean;
        corrected_by: string | null;
        corrected_date: string | null;
        corrects: string | null;
      }>(
        `SELECT r.id::text,r.from_account_id,a.name AS from_name,r.to_account_id,b.name AS to_name,
          r.date::text,r.amount_cents::text,r.iso_currency,${TRANSFER_SOURCE_REVISION_SQL} AS revision,
          coalesce(${TRANSFER_SOURCE_INTACT_SQL},false) AS intact,
          c.correction_transfer_id::text AS corrected_by,cr.date::text AS corrected_date,
          origin.original_transfer_id::text AS corrects
        ${TRANSFER_SOURCE_SQL}
        JOIN app.finance_accounts a ON a.owner_user_id=r.owner_user_id AND a.account_id=r.from_account_id
        JOIN app.finance_accounts b ON b.owner_user_id=r.owner_user_id AND b.account_id=r.to_account_id
        LEFT JOIN app.finance_transfer_corrections c ON c.owner_user_id=r.owner_user_id AND c.original_transfer_id=r.id
        LEFT JOIN app.finance_manual_transfers cr ON cr.owner_user_id=c.owner_user_id AND cr.id=c.correction_transfer_id
        LEFT JOIN app.finance_transfer_corrections origin ON origin.owner_user_id=r.owner_user_id AND origin.correction_transfer_id=r.id
        WHERE r.id=$1::uuid`,
        [transferId]
      );
      const row = result.rows[0];
      return row
        ? {
            transferId: row.id,
            fromAccountId: row.from_account_id,
            fromName: row.from_name,
            toAccountId: row.to_account_id,
            toName: row.to_name,
            date: row.date,
            amountCents: safeCents(row.amount_cents),
            isoCurrency: row.iso_currency,
            sourceRevision: row.revision,
            intact: row.intact,
            correctedBy:
              row.corrected_by && row.corrected_date
                ? { transferId: row.corrected_by, date: row.corrected_date }
                : null,
            correctsTransferId: row.corrects
          }
        : null;
    },
    reverse: (input) => commitManualTransfer(db, input, input)
  };
}
