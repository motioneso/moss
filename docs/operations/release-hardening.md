# M7 Release Hardening Operations

Date: 2026-06-06

This is the bounded M7 alpha hardening slice for practical self-hosted operation. It adds scripts
and tests for database backup, user export, user deletion, and Docker Compose readiness without
adding product UI, connector sync, OAuth provider flows, model calls, embeddings, or assistant write
execution.

## Backup

Create a full database backup:

```txt
pnpm backup:db -- --output backups/jarv1s-alpha.dump
```

The backup uses the bootstrap/operator database URL and `pg_dump --format=custom`. The script passes
the database password through `PGPASSWORD` instead of command arguments so the password is not printed
or exposed in the spawned command line.

Treat backup files as sensitive operator artifacts. A full backup contains private user data,
Better Auth tables, pg-boss operational rows, and encrypted connector/AI secret ciphertext. Store it
outside git, encrypt it off host, and restrict filesystem access.

User vault notes are plaintext markdown files by design. Vault confidentiality comes from per-user
vault roots, `0700` directories, `0600` files, and `VaultContext` path containment, not
application-level note encryption. Treat vault volumes, filesystem backups, and exported archives as
sensitive private data. Connector and AI credentials remain separate from vault notes and continue to
use AES-256-GCM envelopes at rest.

## Production Environment Example

Use `infra/env.production.example` as the production environment checklist:

```txt
cp infra/env.production.example <operator-managed-env-file>
```

Keep the populated file outside git and inject it through your host, orchestrator, or Compose
wrapper. The example intentionally uses placeholders instead of the development credentials from
`infra/docker-compose.yml`.

Production requires these secrets:

- `BETTER_AUTH_SECRET` for Better Auth session signing
- `JARVIS_CONNECTOR_SECRET_KEY` for connector token encryption
- `JARVIS_INTEGRATIONS_SECRET_KEY` for integration connection credential encryption, generated the
  same way as the other secret keys above (a 32-byte base64 or hex secret)
- `JARVIS_AI_SECRET_KEY` for AI provider credential encryption

Keep `JARVIS_AUTH_BASE_URL` and `JARVIS_AUTH_TRUSTED_ORIGINS` aligned with the deployed Moss
origin before enabling browser login or external identity providers. OAuth/OIDC variables configure
login identity only; connector scopes remain separate from login scopes.

Database URL variables should use distinct role passwords for bootstrap, migration owner, app
runtime, and worker runtime. Do not reuse the local Compose defaults for production.

### Database role passwords

Runtime DB role passwords are **not** stored in the committed bootstrap SQL. The bootstrap file
`infra/postgres/bootstrap/0000_roles.sql` only creates the roles (with `LOGIN`) and sets their
hardening attributes and grants — it assigns no passwords. The single source of truth for each
role's password is its configured connection URL:

- **Production** (`NODE_ENV=production`): the explicit `JARVIS_MIGRATION_DATABASE_URL`,
  `JARVIS_APP_DATABASE_URL`, `JARVIS_WORKER_DATABASE_URL`, and `JARVIS_AUTH_DATABASE_URL` secrets.
- **Local development**: the host/port/database-parameterized fallbacks in `getJarvisDatabaseUrls`,
  which carry the well-known dev passwords so `pnpm db:migrate` is zero-friction.

On every `pnpm db:migrate`, the migration runner derives a role-password plan from these URLs and
re-applies each role's password from the configured secret (an idempotent `ALTER ROLE … PASSWORD`).
This is deliberately a **set-from-configured-secret-every-run** model:

- Re-running `pnpm db:migrate` never resets a runtime role to a development default — it re-applies
  the same configured secret.
- In production the plan **fails closed before any role is touched**: it refuses if any runtime
  role's password is missing from its connection URL, or is still one of the development defaults
  (`migration_password`, `app_password`, `worker_password`, `auth_password`).

**Rotating a role password:** update that role's `JARVIS_*_DATABASE_URL` secret with the new value
and re-run `pnpm db:migrate`. The runner applies the new password to the role and the same URL is
what the runtime uses to connect, so the two cannot drift. Rotate the role's password in Postgres
and its connection URL together; never edit `0000_roles.sql` to carry a password.

## Restore Drill

Preview the restore command for an existing custom-format backup:

```txt
pnpm restore:db -- --input backups/jarv1s-alpha.dump
```

Execute a restore:

```txt
pnpm restore:db -- --input backups/jarv1s-alpha.dump --execute --confirm-restore
```

The restore path uses the bootstrap/operator database URL and `pg_restore --clean --if-exists
--no-owner --no-privileges`. Like backups, the script passes the database password through
`PGPASSWORD` instead of command arguments.

#1468: the restore path confirms the target's identity before restoring — pass
`--confirm-owner-email <email>` matching the target's current bootstrap owner, or
`--allow-empty-target` for a target with no `app.users` rows yet (a fresh database).

Treat restore as a destructive operator action. Run it only against the intended database, verify
the backup file location before execution, and run `pnpm db:migrate` after restore when applying an
older backup to a newer checkout.

## User Export

Export one user's data:

```txt
pnpm export:user -- --user-id <user_uuid> --output exports/user-<user_uuid>.json
```

The export path uses the app runtime role and `AccessContext -> withDataContext() -> RLS`. It also
filters product rows to data owned by the target user so granted or workspace-visible rows owned by
other users are not pulled into the export.

The export intentionally omits:

- connector `encrypted_secret`
- AI `encrypted_credential`
- Better Auth access, refresh, and ID tokens
- password hashes
- Better Auth session tokens
- pg-boss job payloads

The export still contains the target user's private product data, so keep `exports/` out of git and
handle the JSON as sensitive data.

## User Delete

Preview deletion counts:

```txt
pnpm delete:user -- --user-id <user_uuid>
```

Execute deletion:

```txt
pnpm delete:user -- --user-id <user_uuid> --actor-user-id <admin_uuid> --execute --confirm-user-id <user_uuid>
```

The execute path requires `--confirm-user-id` to exactly match `--user-id`. It writes a
metadata-only `app.admin_audit_events` row with table counts and then deletes `app.users.id`; module
tables clean up through existing foreign-key cascades.

Run a backup before executing a delete. The script is an operator maintenance path that uses the
bootstrap database URL; it does not grant app or worker roles table ownership, `BYPASSRLS`, or broad
`DELETE` privileges.

## Release Hardening Audit

Run the operator audit report:

```txt
pnpm audit:release-hardening
```

The audit uses the bootstrap/operator database URL and reports whether:

- runtime roles are not superusers and cannot create databases, create roles, or bypass RLS
- protected product and secret-bearing tables have RLS enabled and forced
- app and worker runtime roles cannot `DELETE` protected product or secret-bearing tables
- `app.admin_audit_events` remains append/read-only for the app runtime role and unavailable to the
  worker runtime role

The command prints JSON and exits non-zero when any check fails. Run it after migrations, restore
drills, or manual grant changes.

## Docker Compose Smoke

Run the local Compose smoke check:

```txt
pnpm smoke:compose
```

The smoke script runs:

```txt
docker compose -f infra/docker-compose.yml config --quiet
docker compose -f infra/docker-compose.yml up -d postgres --wait
docker compose -f infra/docker-compose.yml run --rm migrate
docker compose -f infra/docker-compose.yml up -d api web worker --wait
```

It then polls `http://localhost:3000/health`. The `api`, `worker`, and `web` services are
configured with `restart: unless-stopped`, so a crash-exit self-heals without manual intervention.
The `api` service also has a Docker `HEALTHCHECK` on `/health`; the `--wait` flag above blocks
until that healthcheck passes before polling begins, making the smoke check reliable even when
container startup (including `pnpm install`) is slow. The underlying cause — no persistent pnpm
store across container restarts — is tracked in issue #67.

The Compose services mount source code from the host but keep `node_modules` directories inside
container-private volumes. This keeps container `pnpm install` runs from prompting to purge or
rewrite the host install.

When overriding the API host port, pass the same port to the smoke script:

```txt
JARVIS_API_PORT=3001 pnpm smoke:compose -- --api-port 3001
```

Stop and remove local smoke resources with:

```txt
docker compose -f infra/docker-compose.yml down
```

Use `down -v` only when you intentionally want to delete the local Postgres volume.

Production smoke builds one `ghcr.io/motioneso/moss` image, starts `postgres` and `jarv1s`, and
polls readiness through the public Moss port:

```txt
JARVIS_IMAGE_TAG=smoke pnpm smoke:compose:prod
```

## Verification

Focused release-hardening verification:

```txt
pnpm test:release-hardening
```

Full foundation verification:

```txt
pnpm verify:foundation
```

## Secret-Key Rotation

Connector and AI secrets are AES-256-GCM encrypted at rest with versioned key envelopes
that support zero-downtime rotation. See [secret-key-rotation.md](./secret-key-rotation.md)
for the step-by-step runbook and the optional `scripts/rewrap-secrets.ts` force-rewrap
operator script.
