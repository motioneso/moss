import { MAX_HISTORY_ROWS, type HistoryExportStore } from "./history-export.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
export function historyExportSqlStore(db: FinanceDb): HistoryExportStore {
  return {
    async read(scope) {
      const result = await db.query<{
        id: string | null;
        account_id: string;
        account_name: string;
        date: string;
        name: string;
        amount_cents: string;
        iso_currency: string;
        category_id: string | null;
        category_name: string;
        pending: boolean;
        cleared: boolean | null;
        reconciled_at: string | null;
        splits: { categoryId: string; name: string; amountCents: string | number }[];
        total_count: string;
      }>(
        `WITH selected AS MATERIALIZED (
          SELECT t.owner_user_id,t.id,t.account_id,t.date,t.amount_cents,t.iso_currency,t.name,
            t.category_id,t.pending,t.source,t.cleared,t.reconciled_at,t.splits FROM app.finance_transactions t
          WHERE ($1::date IS NULL OR t.date >= $1::date)
            AND ($2::date IS NULL OR t.date <= $2::date)
            AND ($3::text IS NULL OR t.account_id=$3)
        ), summary AS (SELECT count(*) AS n FROM selected), limited AS (
          SELECT * FROM selected WHERE (SELECT n FROM summary) <= ${MAX_HISTORY_ROWS} ORDER BY date DESC,id ASC LIMIT ${MAX_HISTORY_ROWS}
        ) SELECT t.id,t.account_id,coalesce(a.name,t.account_id) AS account_name,
          t.date::text AS date,t.name,t.amount_cents::text,t.iso_currency,t.category_id,
          coalesce(c.name,t.category_id,'Uncategorized') AS category_name,t.pending,
          CASE WHEN t.source='manual' THEN t.cleared ELSE NULL END AS cleared,
          t.reconciled_at::text,summary.n::text AS total_count,
          coalesce((SELECT jsonb_agg(jsonb_build_object('categoryId',p->>'categoryId',
            'name',coalesce(pc.name,p->>'categoryId'),'amountCents',p->>'amountCents') ORDER BY n)
            FROM jsonb_array_elements(t.splits) WITH ORDINALITY AS parts(p,n)
            LEFT JOIN app.finance_categories pc ON pc.id=p->>'categoryId' AND pc.owner_user_id=t.owner_user_id), '[]'::jsonb) AS splits
          FROM summary LEFT JOIN limited t ON TRUE LEFT JOIN app.finance_accounts a ON a.account_id=t.account_id AND a.owner_user_id=t.owner_user_id
          LEFT JOIN app.finance_categories c ON c.id=t.category_id AND c.owner_user_id=t.owner_user_id
          ORDER BY t.date DESC,t.id ASC`,
        [scope.from ?? null, scope.through ?? null, scope.accountId ?? null]
      );
      return {
        totalCount: Number(result.rows[0]?.total_count ?? 0),
        rows: result.rows
          .filter((r) => r.id !== null)
          .map((r) => ({
            id: r.id!,
            accountId: r.account_id,
            accountName: r.account_name,
            date: r.date,
            name: r.name,
            amountCents: safeCents(r.amount_cents),
            isoCurrency: r.iso_currency,
            categoryId: r.category_id,
            categoryName: r.category_name,
            pending: r.pending,
            cleared: r.cleared,
            reconciledAt: r.reconciled_at,
            splits: r.splits.map((p) => ({ ...p, amountCents: safeCents(p.amountCents) }))
          }))
      };
    }
  };
}
