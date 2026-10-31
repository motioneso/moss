-- Meals S1 (#3885): one Kitchen per owner, created on first use.
-- owner_user_id is the RLS scoping column; the platform generates the FORCE RLS policy from
-- database.ownedTables at install time.
CREATE TABLE app.meals_kitchens (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  units_system text NOT NULL DEFAULT 'us' CHECK (units_system IN ('us', 'metric')),
  default_pantry_mode text NOT NULL DEFAULT 'prefer'
    CHECK (default_pantry_mode IN ('ignore', 'prefer', 'only')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, kitchen_id),
  UNIQUE (owner_user_id)
);
