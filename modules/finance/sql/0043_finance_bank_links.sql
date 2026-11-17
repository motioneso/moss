CREATE TABLE app.finance_bank_links (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  slot text NOT NULL,
  sync_cursor text,
  pagination_start text,
  PRIMARY KEY (owner_user_id, item_id)
);

CREATE TABLE app.finance_link_sessions (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  link_token text NOT NULL,
  started_at text NOT NULL,
  update_item_id text,
  PRIMARY KEY (owner_user_id, link_token)
);
