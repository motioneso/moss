/** Canonical owned receipt and leg facts, shared by review and correction eligibility. */
export const TRANSFER_SOURCE_SQL = `FROM app.finance_manual_transfers r
  JOIN app.finance_transactions o ON o.owner_user_id=r.owner_user_id AND o.id=r.from_transaction_id
  JOIN app.finance_transactions i ON i.owner_user_id=r.owner_user_id AND i.id=r.to_transaction_id`;
export const TRANSFER_SOURCE_REVISION_SQL =
  "md5(r.id::text||':'||r.xmin::text||':'||o.xmin::text||':'||i.xmin::text)";
export const TRANSFER_SOURCE_INTACT_SQL = `o.transfer_id=r.id AND i.transfer_id=r.id
  AND o.account_id=r.from_account_id AND i.account_id=r.to_account_id
  AND o.amount_cents=r.amount_cents AND i.amount_cents=-r.amount_cents
  AND o.date=r.date AND i.date=r.date AND o.iso_currency=r.iso_currency AND i.iso_currency=r.iso_currency
  AND o.source='manual' AND i.source='manual' AND NOT o.pending AND NOT i.pending
  AND o.category_id='transfers' AND i.category_id='transfers'
  AND o.splits='[]'::jsonb AND i.splits='[]'::jsonb`;
