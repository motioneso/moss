-- Local trust records are deliberately separate from install-wide registry activation.
CREATE TABLE moss_modules.local_trust (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    installation_id text NOT NULL UNIQUE,
    public_key text NOT NULL,
    fingerprint text NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    UNIQUE (installation_id, fingerprint)
);
REVOKE ALL ON moss_modules.local_trust FROM PUBLIC;
GRANT SELECT, INSERT ON moss_modules.local_trust TO jarvis_app_runtime;
CREATE TABLE moss_modules.local_packages (
    module_id text PRIMARY KEY,
    owner_account_id uuid NOT NULL,
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    provenance text NOT NULL DEFAULT 'local' CHECK (provenance = 'local'),
    installation_id text NOT NULL,
    install_key_fingerprint text NOT NULL,
    registry_reviewed boolean NOT NULL DEFAULT false CHECK (NOT registry_reviewed),
    CHECK (module_id LIKE 'local.' || owner_account_id::text || '.%'),
    FOREIGN KEY (installation_id, install_key_fingerprint)
        REFERENCES moss_modules.local_trust (installation_id, fingerprint)
);
ALTER TABLE moss_modules.local_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_modules.local_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY local_packages_owner ON moss_modules.local_packages TO jarvis_app_runtime
    USING (owner_account_id = app.current_actor_user_id())
    WITH CHECK (owner_account_id = app.current_actor_user_id());
GRANT SELECT, INSERT ON moss_modules.local_packages TO jarvis_app_runtime;
