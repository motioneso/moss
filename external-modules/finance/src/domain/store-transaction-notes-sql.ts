import type { FinanceDb } from "./store-sql.js";
import type { TransactionNoteStore } from "./transaction-notes.js";
import { validPrivateNote } from "./transaction-notes.js";
/** A note-only compare-and-set: classification and every financial field stay untouched. */
export function transactionNoteSqlStore(db: FinanceDb): TransactionNoteStore {
  return {
    async read(target) {
      const result = await db.query<{
        name: string;
        date: string;
        notes: string;
        write_revision: string;
      }>(
        `SELECT name,date::text AS date,coalesce(notes,'') AS notes,md5(id||':'||xmin::text) AS write_revision
        FROM app.finance_transactions WHERE id=$1 AND account_id=$2 AND to_char(date,'YYYY-MM')=$3`,
        [target.transactionId, target.accountId, target.month]
      );
      const row = result.rows[0];
      return row
        ? {
            ...target,
            name: row.name,
            date: row.date,
            notes: row.notes,
            writeRevision: row.write_revision
          }
        : null;
    },
    async save(target, revision, notes, at) {
      if (!validPrivateNote(notes)) throw new Error("Invalid private note");
      const result = await db.query<{ outcome: "saved" | "unchanged" | "stale" }>(
        `WITH changed AS (
          UPDATE app.finance_transactions SET notes=$5
          WHERE id=$1 AND account_id=$2 AND to_char(date,'YYYY-MM')=$3
            AND md5(id||':'||xmin::text)=$4 AND notes IS DISTINCT FROM $5
          RETURNING id,account_id,date
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$6::timestamptz,'user','transaction.note',
            jsonb_build_object('transactionId',id,'accountId',account_id,'month',to_char(date,'YYYY-MM'),'notesChanged',true)
          FROM changed RETURNING id
        ) SELECT CASE WHEN EXISTS(SELECT 1 FROM changed) THEN 'saved'
          WHEN EXISTS(SELECT 1 FROM app.finance_transactions WHERE id=$1 AND account_id=$2
            AND to_char(date,'YYYY-MM')=$3 AND md5(id||':'||xmin::text)=$4 AND notes=$5)
          THEN 'unchanged' ELSE 'stale' END AS outcome`,
        [target.transactionId, target.accountId, target.month, revision, notes, at]
      );
      return result.rows[0]?.outcome ?? "stale";
    }
  };
}
