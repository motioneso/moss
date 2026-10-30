ALTER TABLE app.finance_transactions
  ADD COLUMN transfer_id uuid,
  ADD CONSTRAINT finance_transactions_transfer_owner FOREIGN KEY (owner_user_id,transfer_id)
    REFERENCES app.finance_manual_transfers(owner_user_id,id),
  ADD CONSTRAINT finance_transactions_transfer_leg CHECK (
    transfer_id IS NULL OR (source='manual' AND category_id IS NOT DISTINCT FROM 'transfers' AND splits='[]'::jsonb AND NOT pending
      AND ((id='transfer:'||transfer_id::text||':out' AND amount_cents>0)
        OR (id='transfer:'||transfer_id::text||':in' AND amount_cents<0)))
  );
