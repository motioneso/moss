CREATE TABLE app.finance_transfer_corrections (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  original_transfer_id uuid NOT NULL,
  correction_transfer_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id,original_transfer_id),
  UNIQUE (owner_user_id,correction_transfer_id),
  CHECK (original_transfer_id<>correction_transfer_id),
  FOREIGN KEY (owner_user_id,original_transfer_id) REFERENCES app.finance_manual_transfers(owner_user_id,id),
  FOREIGN KEY (owner_user_id,correction_transfer_id) REFERENCES app.finance_manual_transfers(owner_user_id,id)
);
