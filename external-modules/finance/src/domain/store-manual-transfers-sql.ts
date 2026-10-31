import type { TransferCorrection } from "./transfer-corrections.js";
import type { ManualTransfer, TransferResult } from "./manual-transfers.js";
import {
  TRANSFER_SOURCE_SQL,
  TRANSFER_SOURCE_REVISION_SQL,
  TRANSFER_SOURCE_INTACT_SQL
} from "./transfer-review-sql.js";
import type { ManualTransferStore } from "./manual-transfers.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
const eligibleType = "(type IN ('depository','credit') OR (type='other' AND subtype='cash'))";
export function manualTransferSqlStore(db: FinanceDb): ManualTransferStore {
  return {
    async accounts() {
      const result = await db.query<{
        account_id: string;
        name: string;
        type: string;
        subtype: string | null;
        iso_currency: string;
        balance_cents: string;
        opening_date: string;
        last_reconciled_date: string | null;
        revision: string;
      }>(
        `SELECT account_id,name,type,subtype,iso_currency,balance_cents::text,opening_date::text,last_reconciled_date::text,
          md5(account_id||':'||xmin::text) AS revision FROM app.finance_accounts
          WHERE source='manual' AND archived_at IS NULL AND ${eligibleType} ORDER BY name,account_id`
      );
      return result.rows.map((r) => ({
        accountId: r.account_id,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        isoCurrency: r.iso_currency,
        balanceCents: safeCents(r.balance_cents),
        openingDate: r.opening_date,
        lastReconciledDate: r.last_reconciled_date,
        revision: r.revision
      }));
    },
    create: (input) => commitManualTransfer(db, input)
  };
}
export async function commitManualTransfer(
  db: FinanceDb,
  input: ManualTransfer,
  correction?: Pick<TransferCorrection, "originalTransferId" | "sourceRevision">
): Promise<TransferResult> {
  const prior = async () => {
    const result = await db.query<{ digest: string }>(
      "SELECT digest FROM app.finance_manual_transfers WHERE id=$1::uuid",
      [input.operationId]
    );
    return result.rows[0];
  };
  const existing = await prior();
  if (existing) return existing.digest === input.digest ? "unchanged" : "conflict";
  const result = await db.query<{ created: boolean }>(
    `WITH locked AS MATERIALIZED (
        SELECT a.*,md5(account_id||':'||xmin::text) AS revision FROM app.finance_accounts a
        WHERE account_id IN ($2,$3) ORDER BY account_id FOR UPDATE
      ), reviewed AS MATERIALIZED (
        SELECT *,CASE WHEN account_id=$2 THEN $5::bigint ELSE -$5::bigint END AS movement FROM locked
        WHERE source='manual' AND archived_at IS NULL AND ${eligibleType} AND iso_currency=$6
          AND ((account_id=$2 AND revision=$7) OR (account_id=$3 AND revision=$8))
          AND $4::date>=opening_date AND $4::date<=$12::date
          AND (last_reconciled_date IS NULL OR $4::date>last_reconciled_date)
      ), eligible AS (
        SELECT 1 WHERE $2<>$3 AND $5::numeric BETWEEN 1 AND 9007199254740991
          AND (SELECT count(*) FROM reviewed)=2
          AND NOT EXISTS(SELECT 1 FROM reviewed WHERE balance_cents::numeric+(CASE WHEN type='credit' THEN 1 ELSE -1 END)*movement NOT BETWEEN -9007199254740991 AND 9007199254740991)
          ${
            correction
              ? `AND EXISTS (SELECT 1 ${TRANSFER_SOURCE_SQL}
            WHERE r.id=$13::uuid AND ${TRANSFER_SOURCE_REVISION_SQL}=$14 AND ${TRANSFER_SOURCE_INTACT_SQL}
              AND r.from_account_id=$3 AND r.to_account_id=$2 AND r.amount_cents=$5 AND r.iso_currency=$6 AND $4::date>=r.date
              AND NOT EXISTS (SELECT 1 FROM app.finance_transfer_corrections c WHERE c.owner_user_id=r.owner_user_id AND c.original_transfer_id=r.id)
            FOR SHARE OF r,o,i)`
              : ""
          }
      ), saved AS (
        INSERT INTO app.finance_manual_transfers(owner_user_id,id,from_account_id,to_account_id,date,amount_cents,iso_currency,digest,cleared,created_at)
        SELECT app.current_actor_user_id(),$1::uuid,$2,$3,$4::date,$5::bigint,$6,$9,$10,$11::timestamptz FROM eligible
        ON CONFLICT(owner_user_id,id) DO NOTHING RETURNING id
      ), legs AS (
        INSERT INTO app.finance_transactions(owner_user_id,id,account_id,date,name,amount_cents,iso_currency,category_id,notes,pending,categorized_by,review_state,source,entry_digest,cleared,transfer_id)
        SELECT app.current_actor_user_id(),'transfer:'||s.id::text||CASE WHEN r.account_id=$2 THEN ':out' ELSE ':in' END,
          r.account_id,$4::date,CASE WHEN r.account_id=$2 THEN 'Manual transfer out' ELSE 'Manual transfer in' END,
          r.movement,$6,'transfers',NULL,false,'user','confirmed','manual',$9,$10,s.id
        FROM reviewed r CROSS JOIN saved s RETURNING account_id,amount_cents
      ), balanced AS (
        UPDATE app.finance_accounts a SET balance_cents=a.balance_cents+(CASE WHEN a.type='credit' THEN 1 ELSE -1 END)*l.amount_cents,
          ledger_revision=a.ledger_revision+1,updated_at=$11
        FROM legs l WHERE a.account_id=l.account_id AND (SELECT count(*) FROM legs)=2 RETURNING a.account_id
      ), ${
        correction
          ? `corrected AS (
        INSERT INTO app.finance_transfer_corrections(owner_user_id,original_transfer_id,correction_transfer_id,created_at)
        SELECT app.current_actor_user_id(),$13::uuid,id,$11::timestamptz FROM saved WHERE (SELECT count(*) FROM balanced)=2
        RETURNING correction_transfer_id
      ), `
          : ""
      }logged AS (
        INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
        SELECT app.current_actor_user_id(),gen_random_uuid(),$11::timestamptz,'user',${correction ? "'transfer.reverse'" : "'transfer.create'"},jsonb_build_object('transferId',id::text,'fromAccountId',$2::text,'toAccountId',$3::text${correction ? ",'originalTransferId',$13::text" : ""})
        FROM saved WHERE (SELECT count(*) FROM balanced)=2 RETURNING id
      ) SELECT (SELECT count(*) FROM balanced)=2 ${correction ? "AND (SELECT count(*) FROM corrected)=1" : ""} AS created`,
    [
      input.operationId,
      input.fromAccountId,
      input.toAccountId,
      input.date,
      input.amountCents,
      input.isoCurrency,
      input.fromRevision,
      input.toRevision,
      input.digest,
      input.cleared,
      input.at,
      input.today,
      ...(correction ? [correction.originalTransferId, correction.sourceRevision] : [])
    ]
  );
  if (result.rows[0]?.created) return "created";
  // A same-operation contender may commit after this statement's initial snapshot.
  const committed = await prior();
  return committed ? (committed.digest === input.digest ? "unchanged" : "conflict") : "changed";
}
