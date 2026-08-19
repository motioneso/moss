# Build plan — Dev-Instance Provisioning CLI (`pnpm dev:instance`)

Issue: #1258
Spec: `docs/superpowers/specs/2026-08-19-1258-dev-instance-provisioning.md` (branch
`spec-1258-dev-provisioning`, PR #1742)
Source draft: `docs/coordination/2026-08-17-shared-ai-provider-durable-setup-draft.md`
Risk tier: **security** (handles a spendable credential; performs instance-admin-level writes)
Date: 2026-08-19

Written under `.claude/skills/plan-build`, which overrides `superpowers:writing-plans`: this plan
carries **decisions** — file paths, exported signatures, test cases stated as behaviour, unpiped
verification commands — and deliberately carries **no function bodies**.

---

## 1. Seams check

Every platform capability this plan assumes, cited from the current tree. Anything not citable is
an open question in §2, not a task.

### Confirmed — exists, usable as-is

| Capability                                           | Citation                                                                                                                                                                                                                                                                                                                      | Note                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard precedent (allowlist over a connection string) | `tests/integration/test-database.ts:52` `assertIsolatedTestDatabase(connectionString: string): void`                                                                                                                                                                                                                          | Its rule is the _inverse_ of ours: it throws when the db name **is** `jarv1s`.                                                                                                         |
| Guard precedent (refuse a real instance)             | `tests/uat/seed/guard.ts` `assertTargetIsEphemeral(db: Kysely<MossDatabase>): Promise<void>`                                                                                                                                                                                                                                  | Reads `app.users` through the **migration-owner** handle — proves that role can read `app.users` without a data context.                                                               |
| Operator-confirmation guard                          | `packages/db/src/target-identity-guard.ts` `assertOperatorConfirmsTargetOwner(db, confirmedOwnerEmail): Promise<{id, email}>`                                                                                                                                                                                                 | Used by `scripts/admin-reset-password.ts:41`.                                                                                                                                          |
| Data-context chokepoint                              | `packages/db/src/data-context.ts` — `interface AccessContext { readonly actorUserId: string; readonly requestId?: string }`, `DataContextRunner.withDataContext<T>(accessContext, work: (scopedDb: DataContextDb) => Promise<T>): Promise<T>`                                                                                 | Fields are exactly two. Do not add a third (hard invariant).                                                                                                                           |
| Script already using it                              | `scripts/export-user-data.ts:17-46`                                                                                                                                                                                                                                                                                           | `new DataContextRunner(createDatabase({connectionString: urls.app}))`. Copy this wiring.                                                                                               |
| Runtime runner for seeding                           | `tests/uat/seed/connections.ts:15` `createMigrationOwnerDb()`, `createAppRuntimeRunner()`                                                                                                                                                                                                                                     | Test-tree only; not exported from `@moss/db`. We build our own equivalents.                                                                                                            |
| Idempotent production seeding path                   | `packages/ai/src/auto-register.ts` — `AiAutoRegisterService.ensureDefaultChatModel(scopedDb: DataContextDb, providerKind: AiProviderKind): Promise<void>`; constructor `{repository, cipher, modelDiscovery?}`                                                                                                                | Already writes `authMethod: "cli"` + `cipher.encryptJson({cli:true})` and calls `setInstanceDefaultProvider`. Confirms the spec's "sealed sentinel" claim.                             |
| Default-provider resolution (the 2026-07-25 failure) | `packages/ai/src/repository.ts:802` `resolveDefaultProviderId(scopedDb): Promise<string \| null>`                                                                                                                                                                                                                             | Returns null on "no default flagged AND more than one active admin-owned assistant provider".                                                                                          |
| Chat-model resolution without HTTP                   | `packages/ai/src/repository.ts:1395` `selectChatModelForUser(scopedDb): Promise<AiConfiguredModelSafeRow \| null>`                                                                                                                                                                                                            | This is doctor's "chat capability resolves to a live model" check — pure RLS read, no engine.                                                                                          |
| Admin predicate                                      | `packages/ai/sql/0091_chat_model_override.sql:15` `app.owner_is_active_admin(uuid)`                                                                                                                                                                                                                                           | Used from TS at `packages/ai/src/repository.ts:823`.                                                                                                                                   |
| Cipher + keyring                                     | `packages/ai/src/crypto.ts:16` `createAiSecretCipher(env)`; `packages/db/src/keyring.ts` `resolveKeyring(...)`; envs `JARVIS_AI_SECRET_KEY`, `JARVIS_AI_SECRET_KEY_ID`, `JARVIS_AI_SECRET_KEYS`; dev default literal `"jarv1s-development-ai-secret"`                                                                         | Dev default applies only when `NODE_ENV` is unset/development/test — the mechanism behind the spec's env-parity requirement.                                                           |
| Decrypt round-trip precedent                         | `scripts/rewrap-secrets.ts:169-180`                                                                                                                                                                                                                                                                                           | `parseEnvelope → decryptJson` over `ai_provider_configs.encrypted_credential`. Copy this call for the credential-decrypts check.                                                       |
| CLI token persistence                                | `packages/cli-runner/src/provider-token-store.ts` — `providerTokenPath(homeBase, provider): string`, `persistProviderToken(homeBase, provider, token): Promise<void>`, `readProviderToken(homeBase, provider): Promise<string \| undefined>`; `TOKEN_DIR = ".jarvis/cli-tokens"`; anthropic env var `CLAUDE_CODE_OAUTH_TOKEN` | The env-var→token-store convention the spec says we may share with the UAT seeder (`tests/uat/seed/cli.ts` `maybePersistRealChatToken`).                                               |
| cli-runner process                                   | `packages/cli-runner/package.json` script `start: tsx src/main-entry.ts`; config reader `packages/cli-runner/src/main.ts` `readConfig(env): CliRunnerConfig`; prod spawn at `scripts/start-jarv1s.ts:~127`                                                                                                                    | Prod runs it as a child of `start-jarv1s.ts`, not its own compose service.                                                                                                             |
| cli-runner reachability probe                        | `packages/chat/src/live/chat-engine-rpc-client.ts:506` `RpcConnection.ensureConnected(): Promise<void>`                                                                                                                                                                                                                       | Bare connect + mutual hello, no RPC verb. Cheapest liveness check. There is **no** `ping`/`health` method in the `RpcMethod` union (`packages/chat/src/live/rpc-contract.ts:150-170`). |
| Socket path constraint                               | `packages/chat/src/live/chat-engine-rpc-client.ts:78` `SOCKET_ALLOWED_DIR = "/run/jarv1s"`, enforced by realpath at `:576-588`                                                                                                                                                                                                | **Hardcoded, no env override.** See open question OQ-1.                                                                                                                                |
| Real signup route                                    | better-auth mounted at `apps/api/src/server.ts:854` (`/api/auth/*`); `POST /api/auth/sign-up/email`; body `{email, password, name}`; first-user gate `registrationGate` / `bootstrapOwnerExists` at `packages/auth/src/index.ts:455-465`; after-hook `bootstrapFirstMossUser` at `:468`                                       | No hand-written route file.                                                                                                                                                            |
| In-process server factory                            | `apps/api/src/server.ts:214` `createApiServer(options: CreateApiServerOptions = {})`                                                                                                                                                                                                                                          | Exported. Lets `provision` drive the real route via `server.inject` without a running API — see fork F-1.                                                                              |
| Migration file loader                                | `packages/db/src/migrations/sql-runner.ts:159` `loadMigrationFiles(directory): Promise<MigrationFile[]>` (`{version, name, checksum, sql}`), hash check at `:63`, table `app.schema_migrations` (`:37-38`)                                                                                                                    | Pure filesystem read, no DB.                                                                                                                                                           |
| Migration directory set                              | `scripts/migrate.ts:36-40` — `infra/postgres/migrations` + `getBuiltInSqlMigrationDirectories()` from `@moss/module-registry`                                                                                                                                                                                                 | `scripts/migrate.ts` exports nothing; it is top-level-await.                                                                                                                           |
| DB URLs                                              | `packages/db/src/urls.ts:46` `getMossDatabaseUrls(env): {bootstrap, migration, app, auth, worker}`; throws on `NODE_ENV=production` (`:33-35`) and on non-dev host/port (`:36-42`)                                                                                                                                            | A partial prod guard already, but bypassable via `JARVIS_APP_DATABASE_URL`. Our own guard is still required.                                                                           |
| Env aliasing                                         | `packages/db/src/env.ts:86` `resolveMossEnv(env, jarvisName)`; carve-out list `:28-72` includes `JARVIS_PGDATABASE`, `JARVIS_CLI_RUNNER_SOCKET`, `JARVIS_CLI_RUNNER_RPC_SECRET`, `JARVIS_DEV_EMAIL`, `JARVIS_DEV_PASSWORD`                                                                                                    | A name **not** starting with `JARVIS_` is a plain passthrough with no warning (`:87-105`). New config vars are therefore named `MOSS_DEV_INSTANCE_*`.                                  |
| Bundle exclusion                                     | `scripts/build-app.ts:28-31` `ENTRYPOINTS` = `apps/api/src/server.ts`, `apps/worker/src/worker.ts`; esbuild `bundle: true` graph-reachability only; three explicit file copies at `:115-130`                                                                                                                                  | **A new `scripts/dev-instance*.ts` is excluded automatically.** Satisfies spec Goal 4 with no extra work — assert it in a test anyway (T20).                                           |
| Dependency gate scope                                | `scripts/check-package-deps.ts:28` `packagesRoot = join(rootDirectory, "packages")`                                                                                                                                                                                                                                           | `scripts/` is never scanned. A new file under `scripts/` declares nothing.                                                                                                             |
| File-size gate                                       | `scripts/check-file-size.ts:6` limit 1000 lines; walks the whole repo; `docs` ignored (`:8-19`); `scripts/` **is** covered                                                                                                                                                                                                    | Keep every new file well under.                                                                                                                                                        |
| Flag-parsing precedent                               | `scripts/admin-reset-password.ts:25`, `:97-122`                                                                                                                                                                                                                                                                               | Best existing `parseArgs`/`readFlag` shape.                                                                                                                                            |
| Subcommand-dispatch precedent                        | `scripts/build-app.ts:135-145` (`process.argv[2]` against a record)                                                                                                                                                                                                                                                           | The only dispatcher in `scripts/`.                                                                                                                                                     |
| Entry guard precedent                                | `scripts/admin-reset-password.ts:133-144` (`import.meta.url` vs `resolve(process.argv[1])`)                                                                                                                                                                                                                                   | Required so the module is importable by tests without executing.                                                                                                                       |
| Test runner + layout                                 | `vitest.config.ts` — `include` covers `tests/**/*.test.ts` and `packages/db/src/__tests__/**/*.test.ts`; `pool: "forks"`, `fileParallelism: false`; integration isolation in `scripts/test-integration.ts` (`createDatabaseIsolationPlan`, db named `jarvis_test_<entropy>`)                                                  | Integration tests run against `jarvis_test_*`, which our dev guard **rejects** — drives decision D-3.                                                                                  |

### Confirmed absent — must be built

| Missing                                                                                                                                                                                                                                                                                                                                                                     | Consequence                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any "are migrations current?" read that does not apply them. `scripts/migrate.ts` exports nothing; `sql-runner.ts` has no pending-list API.                                                                                                                                                                                                                                 | **Task 3** builds `readMigrationStatus` in `@moss/db`.                                                                                                                                                                                                                                          |
| A masked/hidden password prompt. `scripts/admin-reset-password.ts:124-131` `promptFor` uses a plain `readline` question — **the password echoes.** No `setRawMode` or `_writeToOutput` override anywhere in the repo.                                                                                                                                                       | **Task 8** builds `promptHidden`.                                                                                                                                                                                                                                                               |
| Any script driving `POST /api/auth/sign-up/email`. Every hit is `server.inject` inside `tests/integration/*.test.ts`.                                                                                                                                                                                                                                                       | **Task 11** builds the signup driver.                                                                                                                                                                                                                                                           |
| An "is there an active instance admin?" helper. Closest is `SettingsRepository.listUsers(scopedDb)` (`packages/settings/src/repository.ts:177`), which needs an actor — circular for a check whose job is to find one.                                                                                                                                                      | **Task 5** reads `app.users` through the migration-owner handle, mirroring `tests/uat/seed/guard.ts`.                                                                                                                                                                                           |
| A working credential test for `auth_method: "cli"` providers. `testProviderCredential` hard-returns `{ok:false, message:"CLI provider testing is not supported yet."}` at `packages/ai/src/provider-validation.ts:21-23`; `discoverProviderModels` returns `[]` at `:51`; `POST /api/ai/providers/:id/test` (`provider-validation-routes.ts:33`) is therefore useless here. | Doctor must **not** use those routes. It composes three independent checks instead: row resolves (`selectChatModelForUser`), credential decrypts (`decryptJson`), runner reachable (`ensureConnected`). This is also why spec user story 7's three named failures are three separate check IDs. |
| A dev cli-runner. Prod's is a child of `scripts/start-jarv1s.ts`; nothing starts one for source-run dev. `/run/jarv1s` **does not exist on the dev host** (verified 2026-08-19).                                                                                                                                                                                            | **Task 15**, gated on OQ-1.                                                                                                                                                                                                                                                                     |
| Any `dev:instance` script, `scripts/dev-instance*`, or `tools/` directory.                                                                                                                                                                                                                                                                                                  | Everything here is net-new.                                                                                                                                                                                                                                                                     |

---

## 2. Open questions and design forks

### OQ-1 (blocking Phase 3) — `/run/jarv1s` does not exist on the dev host

`SOCKET_ALLOWED_DIR` is the string literal `/run/jarv1s` at
`packages/chat/src/live/chat-engine-rpc-client.ts:78`, enforced by a realpath check at `:576-588`,
with no environment override. A dev cli-runner therefore cannot use a socket under `$HOME`; the
directory must exist under `/run` and be writable by the dev user. Creating it requires root once,
and `/run` is a tmpfs so it does not survive reboot.

**Recommended answer (needs Ben, one-time):** a `systemd-tmpfiles` drop-in, e.g.
`/etc/tmpfiles.d/jarv1s.conf` containing `d /run/jarv1s 0770 <dev-user> <dev-group> -`, plus
`sudo systemd-tmpfiles --create` to take effect immediately. Rejected alternative: widening
`SOCKET_ALLOWED_DIR` to accept an env-configured directory — that weakens a security control on
the production chat path to buy a dev convenience, which is the wrong trade.

**Owner: Ben.** Phase 3 does not start until this is answered. Phases 1, 2 and 4 are unaffected.

### F-1 — how `provision` drives the signup route

- **Chosen: build the API in-process with `createApiServer()` (`apps/api/src/server.ts:214`) and
  `server.inject` the signup request.** Works immediately after `db:reset` when no API process is
  up; is exactly the path 20+ integration tests already exercise; avoids the pre-auth rate limiter
  on `/api/auth/sign-up/email` (`apps/api/src/server.ts:788-793`); is deterministic and needs no
  base URL config.
- **Steelmanned and rejected: real HTTP `fetch` against the running dev API.** Genuinely stronger
  in one respect — it proves the actual long-lived dev process can serve signup, which injection
  does not. Rejected because `db:reset` deliberately runs at a moment when the API is mid-restart
  or down, so `provision` would fail for a reason unrelated to provisioning — reintroducing exactly
  the "environment problem misread as an application bug" that this issue exists to kill. The
  running process is covered instead by exit criterion 6's live browser proof.
- Either way this is **not** a raw `app.users` insert. `tests/uat/seed/admin.ts:49-106` does a raw
  insert plus a hand-written `app.auth_accounts` row under `SET LOCAL ROLE jarvis_auth_runtime`;
  the spec explicitly rules that out for `provision` so the account is indistinguishable from a
  real signup in auth, RLS and audit.

### F-2 — decrypting the credential file

The spec prescribes `gpg --decrypt` into a `mktemp -d` (0600, `EXIT` trap). **Followed as written.**
Noting for the record that decrypting to a pipe captured in process memory would put no plaintext
on disk at all and is strictly safer; not adopted here because the spec and draft both prescribe
the temp-directory shape and this is not the PR to relitigate it. If a reviewer prefers the pipe,
it is a one-function change confined to `withDecryptedSecret`.

### F-3 — scope of `providers` and `reset`

Spec Decision 7 lists `doctor`, `fix`, `providers`, `reset` as "already asked for" in #1258, but the
spec's own Exit Criteria (1-8) cover only `doctor`, `provision`, the guard, the no-leak property,
the env round-trip, the live proof, the stale-file deletion and the docs sweep. Nothing in the exit
criteria depends on `providers` or `reset`.

**Decision:** `fix` is in scope (Phase 4) — doctor names repairs and the spec's Implementation
Decisions say `doctor`/`fix` land alongside `provision`. `providers` and `reset` are **Phase 5,
planned but explicitly deferred behind the kill gate**, because they carry no exit criterion and
`provision` supersedes the original motivation for `providers` (seeding a provider by hand). Flagged
for the coordinator rather than silently dropped.

### F-4 — `reset` must not reach into a module's tables

Module isolation is a hard invariant. `reset` therefore clears **platform-owned** per-user rows
scoped by module id (module key-value store, action requests, chat threads, audit events) and never
queries a module's own tables. `external-modules/job-search` still exists in the tree, so the
subcommand stays useful, but it is parameterised by module id rather than hardcoded to job-search.

---

## 3. Determinism boundary

This feature contains **no model call and no user-facing chat surface**. Stating the boundary
anyway, because the plan-build skill requires it and because the rule has a sharp edge here:

- Every line `doctor` prints renders **from a `DoctorCheckResult` record** — the check id, its
  boolean, its detail and its repair string. Nothing is composed from model output, and no check
  result is inferred from prose.
- The repair string for a failing check is a **constant belonging to that check**, not a message
  assembled at the call site. This is what makes spec user story 7 testable: "zero providers",
  "two providers, no default" and "credential will not decrypt" are three distinct check ids with
  three distinct constant repairs, so a test asserts on identity rather than on substring matching
  against English. (`assistantOnboarding.guidance` grew to 620 words precisely because assertions
  were substring matches against a paragraph — do not repeat that here.)
- The model gets zero jobs. Guidance budget: not applicable, 0 words.
- `provision` never injects a chat turn anywhere.

---

## 4. File map

Decide the files before the tasks. All paths absolute from the repo root.

### New — `@moss/db`

| Path                                                 | Contents                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/db/src/migrations/pending.ts`              | `readMigrationStatus` + its types (§5 T3)                              |
| `packages/db/src/__tests__/migration-status.test.ts` | Unit tests for the above (in `vitest.config.ts`'s include set already) |

Export `readMigrationStatus`, `MigrationStatus`, `PendingMigration`, `MigrationDrift` from
`packages/db/src/index.ts`. `check:package-deps` needs no new dependency — this file imports only
from within `@moss/db` and `kysely`, both already declared.

### New — the CLI

| Path                                    | Contents                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/dev-instance.ts`               | Entry point: argv dispatch, guard invocation, dependency wiring, exit code. The **only** file with a `import.meta.url` self-invoke guard. |
| `scripts/dev-instance/guard.ts`         | `assertTargetIsDevInstance`, `assertDevEnvParity`, the allowlists                                                                         |
| `scripts/dev-instance/config.ts`        | `readDevInstanceConfig`                                                                                                                   |
| `scripts/dev-instance/secrets.ts`       | `readSecretFile`, `withDecryptedSecret`, `promptHidden`, `redact`                                                                         |
| `scripts/dev-instance/doctor.ts`        | Check registry, `runDoctor`, `formatDoctorReport`                                                                                         |
| `scripts/dev-instance/doctor-checks.ts` | The eight individual checks (split so neither file nears the 1000-line gate)                                                              |
| `scripts/dev-instance/provision.ts`     | `runProvision` and its step types                                                                                                         |
| `scripts/dev-instance/signup.ts`        | `signUpBootstrapOwner` — the `createApiServer` + `inject` driver (F-1)                                                                    |
| `scripts/dev-instance/cli-runner.ts`    | `probeCliRunner`, `ensureCliRunnerRunning`                                                                                                |
| `scripts/dev-instance/fix.ts`           | `runFix`                                                                                                                                  |
| `scripts/dev-instance/providers.ts`     | Phase 5 — `runAddProvider`                                                                                                                |
| `scripts/dev-instance/reset-user.ts`    | Phase 5 — `resetUserModuleState`                                                                                                          |

### New — tests

| Path                                               | Kind                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `tests/unit/dev-instance-guard.test.ts`            | Pure, no DB                                                         |
| `tests/unit/dev-instance-config.test.ts`           | Pure                                                                |
| `tests/unit/dev-instance-secrets.test.ts`          | Pure + tmpdir                                                       |
| `tests/unit/dev-instance-doctor-report.test.ts`    | Pure — formatting and exit-code mapping                             |
| `tests/unit/dev-instance-not-bundled.test.ts`      | Pure — asserts the built bundles contain no dev-instance code (T20) |
| `tests/integration/dev-instance-doctor.test.ts`    | DB — one case per named defect                                      |
| `tests/integration/dev-instance-provision.test.ts` | DB — idempotence, no-leak, round-trip                               |

### Modified

| Path                                             | Change                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                                   | Add `"dev:instance": "tsx scripts/dev-instance.ts"` and `"db:reset": "pnpm db:down && pnpm db:up && pnpm db:migrate && pnpm dev:instance provision"` |
| `packages/db/src/index.ts`                       | Export the migration-status API                                                                                                                      |
| `docs/**` (the 9 real hits from the seams sweep) | Point at `pnpm db:reset` (T21)                                                                                                                       |

### Deleted

`~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (spec Decision 4 — a host file, not a repo file;
it is an operator step recorded in the PR body, not a commit).

---

## 5. Contracts

Fixed signatures, agreed once here so every task compiles against the same shapes.

### `packages/db/src/migrations/pending.ts`

```ts
export interface PendingMigration {
  readonly version: string;
  readonly name: string;
}

export interface MigrationDrift {
  readonly name: string;
  readonly appliedChecksum: string;
  readonly onDiskChecksum: string;
}

export interface MigrationStatus {
  readonly pending: readonly PendingMigration[];
  readonly drifted: readonly MigrationDrift[];
}

export async function readMigrationStatus(
  db: Kysely<MossDatabase>,
  directories: readonly string[]
): Promise<MigrationStatus>;
```

Reads `app.schema_migrations` and compares against `loadMigrationFiles` per directory. `drifted`
is non-empty exactly when the applied checksum differs from disk — the condition `sql-runner.ts:63`
throws on. Reporting drift without throwing is the whole point: doctor must be able to _name_ a
checksum mismatch as the reason `pnpm db:migrate` will fail.

### `scripts/dev-instance/guard.ts`

```ts
export const DEV_INSTANCE_DATABASE_NAMES: readonly string[]; // ["jarv1s"]
export const DEV_INSTANCE_PORTS: readonly string[]; // ["55433"]

export class NotDevInstanceError extends Error {}
export class DevEnvParityError extends Error {}

export function assertTargetIsDevInstance(connectionString: string): void;
export function assertDevEnvParity(env: NodeJS.ProcessEnv): void;
```

`assertTargetIsDevInstance` is an **allowlist on database name and port**, never a denylist —
mirroring `assertIsolatedTestDatabase` and `assertTargetIsEphemeral`. A malformed connection string
throws; it never passes by default. `assertDevEnvParity` throws when `NODE_ENV` is set to anything
at all (spec's env-parity requirement — a set `NODE_ENV` changes which keyring
`packages/db/src/keyring.ts` resolves, and a credential written under the wrong key fails later
with an opaque authentication-tag error).

### `scripts/dev-instance/config.ts`

```ts
export interface DevInstanceConfig {
  readonly providerKind: AiProviderKind;
  readonly credentialFilePath: string;
  readonly adminEmail: string;
  readonly adminName: string;
  readonly adminPasswordFilePath: string;
  readonly cliHomeBase: string;
  readonly cliRunnerSocketPath: string;
}

export function readDevInstanceConfig(env: NodeJS.ProcessEnv): DevInstanceConfig;
```

Env names, all read through `resolveMossEnv` (a non-`JARVIS_` name is a clean passthrough per
`packages/db/src/env.ts:87-105`, so none of these emit an alias warning):

| Field                   | Env var                                                 | Default                                      |
| ----------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `providerKind`          | `MOSS_DEV_INSTANCE_PROVIDER_KIND`                       | `"anthropic"`                                |
| `credentialFilePath`    | `MOSS_DEV_INSTANCE_CREDENTIAL_FILE`                     | `~/.config/moss/uat/anthropic-oauth.env.gpg` |
| `adminEmail`            | `JARVIS_DEV_EMAIL` (already carved out, `env.ts:28-72`) | `ben@ben.com`                                |
| `adminName`             | `MOSS_DEV_INSTANCE_ADMIN_NAME`                          | `"Ben"`                                      |
| `adminPasswordFilePath` | `MOSS_DEV_INSTANCE_ADMIN_PASSWORD_FILE`                 | `~/.config/moss/dev/admin-password`          |
| `cliHomeBase`           | `JARVIS_CLI_HOME_BASE` (carved out)                     | `~/.local/share/moss/cli-auth`               |
| `cliRunnerSocketPath`   | `JARVIS_CLI_RUNNER_SOCKET` (carved out)                 | `/run/jarv1s/cli-runner.sock`                |

`providerKind` being config rather than a literal is the provider-agnosticism invariant. A password
is never accepted as an argv flag — that is the one place this CLI deliberately diverges from
`scripts/admin-reset-password.ts:43`, which accepts `--password`.

### `scripts/dev-instance/secrets.ts`

```ts
export async function readSecretFile(path: string): Promise<string>;
export async function withDecryptedSecret<T>(
  gpgPath: string,
  use: (secret: string) => Promise<T>
): Promise<T>;
export async function promptHidden(question: string): Promise<string>;
export function redact(line: string, secrets: readonly string[]): string;
```

- `readSecretFile` rejects a file whose mode grants group or other any bit (i.e. `mode & 0o077`),
  and trims exactly one trailing newline.
- `withDecryptedSecret` creates a `mktemp -d` under a 0077 umask, runs `gpg --decrypt` into it,
  reads it, and removes the directory in a `finally` **and** on `process.on("exit")`. The plaintext
  is never returned to the caller's caller — only `use`'s return value escapes.
- `promptHidden` disables terminal echo (`setRawMode`) for the duration and restores it in a
  `finally`. No repo precedent exists; this is net-new.
- `redact` replaces each secret with `***`. Every CLI log line passes through it — that is the
  mechanism exit criterion 4 tests.

### `scripts/dev-instance/doctor.ts` and `doctor-checks.ts`

```ts
export type DoctorCheckId =
  | "database-reachable"
  | "migrations-current"
  | "active-instance-admin"
  | "single-instance-default-provider"
  | "chat-model-resolves"
  | "provider-credential-decrypts"
  | "no-uat-fixture-rows"
  | "cli-runner-reachable";

export interface DoctorCheckResult {
  readonly id: DoctorCheckId;
  readonly ok: boolean;
  readonly detail: string;
  readonly repair: string | null; // null iff ok
}

export interface DoctorReport {
  readonly ok: boolean; // every check ok
  readonly checks: readonly DoctorCheckResult[];
}

export interface DoctorDeps {
  readonly migrationDb: Kysely<MossDatabase>;
  readonly runner: DataContextRunner;
  readonly cipher: AiSecretCipher;
  readonly config: DevInstanceConfig;
  readonly migrationDirectories: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly repair: string; // constant; used verbatim when the check fails
  run(deps: DoctorDeps, adminUserId: string | null): Promise<{ ok: boolean; detail: string }>;
}

export const DOCTOR_CHECKS: readonly DoctorCheck[];

export async function resolveActiveAdminUserId(
  migrationDb: Kysely<MossDatabase>
): Promise<string | null>;

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport>;
export function formatDoctorReport(report: DoctorReport): string;
```

`runDoctor` resolves the admin id once (through the migration-owner handle, the same access route
`tests/uat/seed/guard.ts` proves works without a data context) and passes it to every check. Checks
that need a data context and receive `null` report `ok:false` with a detail saying the admin check
is the prerequisite — never a misleading cause.

Check-to-repair mapping (each repair is a constant, per §3):

| Check                              | Fails when                                                                               | Repair string names                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `database-reachable`               | connection or `select 1` fails                                                           | `pnpm db:up`                                                      |
| `migrations-current`               | `readMigrationStatus` reports pending or drifted                                         | `pnpm db:migrate`, or `pnpm db:reset` when drifted                |
| `active-instance-admin`            | no `app.users` row with `is_instance_admin` and `status='active'`                        | `pnpm dev:instance provision`                                     |
| `single-instance-default-provider` | count of `is_instance_default` assistant providers is not exactly 1                      | `pnpm dev:instance fix`                                           |
| `chat-model-resolves`              | `selectChatModelForUser` returns null                                                    | `pnpm dev:instance provision`                                     |
| `provider-credential-decrypts`     | `decryptJson` throws on the default provider's `encrypted_credential`                    | key/`NODE_ENV` mismatch; re-run `provision` with `NODE_ENV` unset |
| `no-uat-fixture-rows`              | any `app.users` row matches a `UAT_*` id/email constant (`tests/uat/seed/admin.ts:8-13`) | `pnpm dev:instance fix`                                           |
| `cli-runner-reachable`             | `RpcConnection.ensureConnected()` rejects                                                | `pnpm dev:instance provision`, or OQ-1's one-time directory setup |

The `single-instance-default-provider` check covers "zero rows" and "two rows, no default" as one
defect class deliberately — spec §doctor says they present identically to an operator. The detail
string distinguishes them; the id and repair do not.

### `scripts/dev-instance/signup.ts`

```ts
export interface OwnerSignUpInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export async function signUpBootstrapOwner(input: OwnerSignUpInput): Promise<{ userId: string }>;
```

Builds the server via `createApiServer()`, injects `POST /api/auth/sign-up/email`, closes the
server in a `finally`. Throws with the response status and body when the status is not 2xx — with
the password redacted out of any echoed body.

### `scripts/dev-instance/provision.ts`

```ts
export type ProvisionStepId = "admin-account" | "provider-rows" | "cli-runner" | "cli-token";

export interface ProvisionStepOutcome {
  readonly id: ProvisionStepId;
  readonly changed: boolean;
  readonly detail: string;
}

export interface ProvisionDeps {
  readonly migrationDb: Kysely<MossDatabase>;
  readonly runner: DataContextRunner;
  readonly autoRegister: AiAutoRegisterPort;
  readonly config: DevInstanceConfig;
  readonly signUpOwner: (input: OwnerSignUpInput) => Promise<{ userId: string }>;
  readonly readAdminPassword: () => Promise<string>;
  readonly ensureCliRunner: () => Promise<CliRunnerStatus>;
  readonly persistCliToken: () => Promise<boolean>;
  readonly log: (line: string) => void;
}

export async function runProvision(deps: ProvisionDeps): Promise<readonly ProvisionStepOutcome[]>;
```

`changed` is the idempotence contract: exit criterion 2's test asserts every outcome has
`changed:false` on a second consecutive run. `autoRegister` is typed as the **port**
(`AiAutoRegisterPort`, `packages/ai/src/auto-register.ts`), not the concrete service, so the
integration test can assert the real service is called without the CLI depending on its internals.
Steps run in the spec's order; each returns early with `changed:false` when already satisfied.

### `scripts/dev-instance/cli-runner.ts`

```ts
export interface CliRunnerStatus {
  readonly reachable: boolean;
  readonly socketPath: string;
  readonly detail: string;
}

export async function probeCliRunner(
  socketPath: string,
  rpcSecret: string | undefined
): Promise<CliRunnerStatus>;

export async function ensureCliRunnerRunning(
  config: DevInstanceConfig,
  env: NodeJS.ProcessEnv
): Promise<CliRunnerStatus>;
```

`probeCliRunner` uses `RpcConnection.ensureConnected()` and closes immediately. `ensureCliRunnerRunning`
probes first, and only on failure spawns `tsx packages/cli-runner/src/main-entry.ts` detached with
the same env shape prod's `scripts/start-jarv1s.ts` builds, then re-probes with a bounded retry
(no unbounded wait loop).

### `scripts/dev-instance/fix.ts`

```ts
export type FixActionId = "flag-instance-default" | "purge-uat-fixture-rows";

export interface FixOutcome {
  readonly id: FixActionId;
  readonly changed: boolean;
  readonly detail: string;
}

export async function runFix(
  deps: DoctorDeps,
  report: DoctorReport
): Promise<readonly FixOutcome[]>;
```

`fix` acts only on defects the report actually names — it never repairs speculatively.

### `scripts/dev-instance.ts`

```ts
export type DevInstanceCommand = "doctor" | "provision" | "fix" | "providers" | "reset";

export async function runDevInstanceCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): Promise<number>;
```

Returns a process exit code; the self-invoke guard at the bottom is the only place `process.exit`
is called. Order inside `runDevInstanceCli` is fixed and testable: parse command →
`assertDevEnvParity(env)` → resolve URLs → `assertTargetIsDevInstance(urls.app)` → open handles →
dispatch. **Both guards run before any handle is opened**, which is what task T19 asserts.

---

## 6. Phases and tasks

Every task is: write the failing test → run it and see it fail for the stated reason → minimal
implementation → run it and see it pass → commit that one task. Commit each task separately, scoped
by explicit path (this checkout is shared — use the `shared-checkout` skill before every commit).

### Phase 1 — read-only checkup (`doctor`)

Ships alone and is evaluated before Phase 2 is built.

**T1 — dev-target guard, rejection cases.**
Test: `tests/unit/dev-instance-guard.test.ts`. `assertTargetIsDevInstance` throws
`NotDevInstanceError` for (a) a database name that is not `jarv1s`, (b) port 5432 instead of 55433,
(c) a string that is not a parseable URL, (d) an empty string. Would fail against a denylist
implementation, against a name-only check that ignores the port, and against any implementation
that treats an unparseable input as safe.

**T2 — dev-target guard, acceptance + env parity.**
Test: same file. Accepts the real dev app URL. `assertDevEnvParity` throws `DevEnvParityError` when
`NODE_ENV` is `production`, `development` or `test`, and passes when it is absent. Would fail
against an implementation that only rejects `production` — which is the actual historical failure
mode, since `NODE_ENV=development` still changes keyring resolution.

**T3 — migration status read.**
Test: `packages/db/src/__tests__/migration-status.test.ts`. Given a temp directory of migration
files and a stubbed `app.schema_migrations` result: reports nothing pending when every file is
applied with a matching checksum; reports the one unapplied file as pending; reports a file whose
applied checksum differs as `drifted` **without throwing**. The no-throw assertion is the point —
`sql-runner.ts:63` throws on exactly this condition, and doctor needs to report it instead.
Implementation: `readMigrationStatus`, exported from `packages/db/src/index.ts`.

**T4 — doctor report shape and exit-code mapping.**
Test: `tests/unit/dev-instance-doctor-report.test.ts`. `formatDoctorReport` renders one line per
check including the repair for failures and no repair for passes; a report with any failing check
has `ok:false`. Every entry in `DOCTOR_CHECKS` has a non-empty constant `repair`, and every
`DoctorCheckId` appears exactly once (a registry-completeness test — catches a check added to the
union but never registered).

**T5 — active-admin resolution.**
Test: `tests/integration/dev-instance-doctor.test.ts`. On an empty database
`resolveActiveAdminUserId` returns null; after a user with `is_instance_admin` and `status='active'`
exists it returns that id; a non-admin or a non-active admin does not satisfy it. Would fail
against an implementation that reuses `bootstrapOwnerExists` (`packages/settings/src/bootstrap.ts:22`),
which checks `is_bootstrap_owner` and ignores admin status entirely.

**T6 — provider-shape checks.**
Test: same integration file. `single-instance-default-provider` fails with zero providers, fails
with two active admin-owned assistant providers and none flagged default, and passes with exactly
one flagged. `chat-model-resolves` fails when no model row carries the `chat` capability.
`provider-credential-decrypts` fails when the stored envelope was encrypted under a different key.
Each assertion is on the check **id**, not on message text.

**T7 — remaining checks and `runDoctor` composition.**
Test: same integration file. `no-uat-fixture-rows` fails when a `UAT_ADMIN_ID` row is present
(constants from `tests/uat/seed/admin.ts:8-13`); `migrations-current` fails on a database migrated
to an earlier point; `cli-runner-reachable` fails against a socket path that does not exist. Then:
`runDoctor` on a database with no admin returns `ok:false` where the context-needing checks name
the admin check as their prerequisite rather than reporting a bogus cause.

**Phase 1 verification** (each command's exit code stated; never piped):

```bash
npx tsc --noEmit > /tmp/1258-tsc.log 2>&1; echo "TSC=$?"                       # expect 0
npx eslint scripts/dev-instance.ts scripts/dev-instance packages/db/src/migrations/pending.ts tests/unit/dev-instance-*.test.ts tests/integration/dev-instance-*.test.ts --max-warnings=0 > /tmp/1258-lint.log 2>&1; echo "LINT=$?"   # expect 0
npx prettier --check scripts/dev-instance.ts "scripts/dev-instance/**" > /tmp/1258-fmt.log 2>&1; echo "FMT=$?"   # expect 0
pnpm check:file-size > /tmp/1258-size.log 2>&1; echo "SIZE=$?"                 # expect 0
```

Integration tests are DB-touching: run them **only** via the `verify-gate` skill, never directly.

### Kill gate — after Phase 1, before Phase 2 is built

**Observation that ends the line:** run `pnpm dev:instance doctor` against the current live dev
instance and against a freshly wiped one. The gate passes only if, in both runs, every reported
failure names a repair that is actually correct for that state, and the eight check ids are
sufficient to explain the 2026-07-25 incident (a provider row present, no instance default flagged,
chat 400ing) without a human having to look at the database.

If doctor cannot distinguish those states — in particular if `cli-runner-reachable` cannot be made
to work at all because of OQ-1 — stop and re-plan. Building `provision` on top of a checkup that
cannot verify its own output would reproduce the exact "code-complete, unverified" failure the
Live-Path Gate exists to prevent.

**Owner of the call: Ben** (coordinator relays doctor's output; Ben decides).

### Phase 2 — `provision`, database half

**T8 — secret handling primitives.**
Test: `tests/unit/dev-instance-secrets.test.ts`. `readSecretFile` rejects a file with mode 0644 and
accepts 0600; strips exactly one trailing newline and no more. `redact` replaces every occurrence of
every supplied secret, including when one secret is a substring of a line printed twice.
`withDecryptedSecret` removes its temp directory even when `use` throws. `promptHidden` restores
the terminal's original echo state even when the read rejects.

**T9 — config reading.**
Test: `tests/unit/dev-instance-config.test.ts`. Defaults applied when the environment is empty;
each override honoured; `providerKind` rejected when it is not a valid `AiProviderKind`. Would fail
against an implementation that hardcodes `"anthropic"` anywhere outside the default — the
provider-agnosticism invariant.

**T10 — `provision` creates the admin account when none exists.**
Test: `tests/integration/dev-instance-provision.test.ts`, with `signUpOwner` supplied as a test
double that records its input. Against an empty database, the `admin-account` step reports
`changed:true` and calls `signUpOwner` exactly once with the configured email and name. Against a
database that already has an active admin, the step reports `changed:false` and `signUpOwner` is
never called.

**T11 — the real signup driver.**
Test: same file. `signUpBootstrapOwner` against a migrated empty test database creates a user that
is a bootstrap owner and has a usable credential row — asserted by reading `app.users` and
`app.auth_accounts`, not by trusting the response. Would fail against a raw insert that skips
`bootstrapFirstMossUser` (`packages/auth/src/index.ts:468`) and therefore never sets
`is_bootstrap_owner`.

**T12 — `provision` ensures the provider and model rows.**
Test: same file. After `runProvision` on an empty-but-migrated database, `resolveDefaultProviderId`
returns non-null and `selectChatModelForUser` returns a model carrying the `chat` capability. The
`provider-rows` step delegates to `AiAutoRegisterPort.ensureDefaultChatModel` with the configured
provider kind — asserted by wiring the **real** `AiAutoRegisterService` and checking the resulting
rows, so the test cannot pass against a parallel SQL insertion path that produces similar rows by
a different route.

**T13 — idempotence (exit criterion 2).**
Test: same file. Two consecutive `runProvision` calls: the second returns every step with
`changed:false`, and `updated_at` on the provider and model rows is unchanged between runs. The
timestamp assertion is what distinguishes a genuine no-op from a re-write that happens to produce
the same values.

**T14 — no-leak and round-trip (exit criteria 4 and 5).**
Test: same file. With a known sentinel credential value, capture every line passed to `log` across
a full `runProvision` and assert none contains the sentinel. Separately, after `provision`, read the
default provider's `encrypted_credential` and `decryptJson` it with a cipher built from the same
environment `resolveApiServerConfig` runs under — this is the test that would have caught the
historical key/`NODE_ENV` mismatch, and it must fail if `provision` is run with `NODE_ENV` set.

**Phase 2 verification:** the four commands from Phase 1, plus the full gate through the
`verify-gate` skill:

```bash
pnpm verify:foundation > /tmp/1258-vf.log 2>&1; echo "EXIT=$?"                 # expect 0
```

### Phase 3 — `provision`, file half (**blocked on OQ-1**)

**T15 — cli-runner probe.**
Test: `tests/unit/dev-instance-cli-runner.test.ts`. `probeCliRunner` returns `reachable:false`
with a detail naming the socket path when the path does not exist, and does not throw. Would fail
against an implementation that lets the connection error escape — doctor must report, not crash.

**T16 — cli-runner start, bounded.**
Test: same file. `ensureCliRunnerRunning` does not spawn when the probe already succeeds; when it
does spawn, it retries a bounded number of times and returns `reachable:false` rather than waiting
forever. No unbounded poll loop (box-wide rule).

**T17 — token persistence step.**
Test: `tests/integration/dev-instance-provision.test.ts`. Given a decrypted token in the
environment, the `cli-token` step writes it through `persistProviderToken`
(`packages/cli-runner/src/provider-token-store.ts`) to
`providerTokenPath(cliHomeBase, "anthropic")` with mode 0600, and reports `changed:false` on a
second run when the file already holds the same value. The written token never appears in any
logged line (extends T14's assertion across the file half).

**T18 — `provision` ends by running `doctor`.**
Test: same file. `runProvision` followed by `runDoctor` on the same handles reports `ok:true`; and
the CLI's `provision` command returns a non-zero exit code when doctor reports any residual defect.
Spec §provision step 5 — doctor is the acceptance evidence, not a separate deliverable.

### Phase 4 — `fix`, wiring, docs

**T19 — guards run before any database handle opens.**
Test: `tests/unit/dev-instance-guard.test.ts`. `runDevInstanceCli(["provision"], {NODE_ENV:"test"})`
returns a non-zero exit code, and does so without having opened a connection — asserted by pointing
the connection env at an unreachable host and confirming the failure is the parity error, not a
connection error. This is the `wired-not-just-defined` check: a guard that exists but is never
called is the failure mode this catches.

**T20 — dev tooling is not in the shipped bundles (spec Goal 4).**
Test: `tests/unit/dev-instance-not-bundled.test.ts`. Assert that neither `apps/api/src/server.ts`
nor `apps/worker/src/worker.ts` reaches `scripts/dev-instance` in its import graph. Static
assertion over the source graph rather than a build artifact, so it runs without a build step and
fails the moment someone imports the CLI from application code.

**T21 — `fix` repairs what doctor named.**
Test: `tests/integration/dev-instance-doctor.test.ts`. With two active providers and none flagged
default, `runFix` flags exactly one and a subsequent `runDoctor` passes that check. With UAT
fixture rows present, `runFix` purges them and the check passes. With a healthy database, `runFix`
returns every action `changed:false` and writes nothing.

**T22 — scripts, docs, and the reset chain.**
Not test-driven (configuration and prose). Add `dev:instance` and `db:reset` to `package.json`.
Update the nine documentation hits that recommend bare `pnpm db:down` as the dev remedy —
`docs/archive/HANDOFF-memory-foundation.md:96`,
`docs/coordination/2026-06-13-phase2-5-test-plan.md:49`,
`docs/superpowers/handoffs/2026-06-18-onboarding-service-testing-webwright.md:146`,
`docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md:53,420`,
`docs/superpowers/plans/2026-06-07-slice-3-memory-index.md:11,197,1556`,
`docs/superpowers/plans/2026-06-06-slice-1c-core-calendar-email-connectors-ai.md:62,532`,
`docs/superpowers/plans/2026-06-07-slice-4-structured-state.md:1483`,
`docs/superpowers/plans/2026-06-13-p5-wellness-module.md:5424`. Leave
`docs/coordination/2026-06-13-overnight-phase2-5-log.md:119` alone — it is a prohibition, not a
recommendation — and leave the `spike:db:down` hit at
`docs/architecture/plans/0004-m7-operations-verification-plan.md:124` alone (different script).
Record the deletion of `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (spec Decision 4) in the
PR body as an operator step.

### Phase 5 — deferred (`providers`, `reset`)

Planned but not built in this PR — see fork F-3. Contracts are fixed here so a later task compiles
against them without redesign:

```ts
// scripts/dev-instance/providers.ts
export async function runAddProvider(
  deps: ProvisionDeps,
  input: { readonly providerKind: AiProviderKind; readonly credential: string }
): Promise<ProvisionStepOutcome>;

// scripts/dev-instance/reset-user.ts
export async function resetUserModuleState(
  deps: { readonly runner: DataContextRunner },
  input: { readonly userId: string; readonly moduleId: string }
): Promise<{ readonly deleted: Readonly<Record<string, number>> }>;
```

`resetUserModuleState` clears platform-owned per-user rows scoped by module id only — never a
module's own tables (module isolation, fork F-4).

---

## 7. End-to-end proof (exit criterion 6)

Phase 3's e2e test, executed and observed, not merely written:

1. `pnpm db:reset > /tmp/1258-reset.log 2>&1; echo "EXIT=$?"` — expect 0 from a fully wiped state.
2. `pnpm dev:instance doctor > /tmp/1258-doctor.log 2>&1; echo "EXIT=$?"` — expect 0, eight checks
   passing.
3. Start the dev API and web from source, log in as the provisioned admin, send one real chat turn,
   and confirm a model reply arrives.
4. Record on the PR: the two exit codes above, the doctor output with the credential redacted, and
   bounded log/network evidence for the chat turn. No screenshots — the Live-Path Gate in
   `docs/DEVELOPMENT_STANDARDS.md` forbids them for this purpose.

Step 3 depends on OQ-1 being resolved. If it is not, the honest status after Phases 1, 2 and 4 is
**code-complete, unverified** — say that rather than reporting the work finished.

---

## 8. Hard invariants — where each is honoured

| Invariant                        | Where                                                                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No admin private-data bypass     | Every protected write goes through `DataContextRunner.withDataContext` under the provisioned admin's own id. No `BYPASSRLS`, no new role. The migration-owner handle is used only for `app.users` reads and the bootstrap path, exactly as `tests/uat/seed/guard.ts` already does. |
| Private by default               | No new grant, no new sharing path.                                                                                                                                                                                                                                                 |
| Secrets never escape             | Every logged line passes `redact`; no secret is an argv flag; the credential lives in a 0700 temp directory removed in `finally` and on exit; T14 and T17 assert the absence in captured output.                                                                                   |
| Metadata-only job payloads       | No pg-boss job is enqueued by this work.                                                                                                                                                                                                                                           |
| Vault I/O via `VaultContext`     | No vault access.                                                                                                                                                                                                                                                                   |
| No `AccessContext` field re-adds | `AccessContext` is used as-is: `actorUserId` plus `requestId`.                                                                                                                                                                                                                     |
| Provider-agnostic AI             | `providerKind` is config (`readDevInstanceConfig`), asserted by T9; the router is untouched.                                                                                                                                                                                       |
| Module isolation                 | `provision` calls the `AiAutoRegisterPort` public method; `reset` (Phase 5) touches only platform-owned tables.                                                                                                                                                                    |
| Never edit an applied migration  | No migration is added or edited. `readMigrationStatus` only reads `app.schema_migrations`.                                                                                                                                                                                         |
| pgvector image                   | Untouched; `db:reset` chains the existing `db:up`.                                                                                                                                                                                                                                 |
| A PR must never break prod       | Dev-only, excluded from both bundles by entrypoint reachability (`scripts/build-app.ts:28-31`) and asserted by T20. No new required env var in any deployed config — every `MOSS_DEV_INSTANCE_*` value has a default and is read only by the CLI.                                  |

---

## 9. Rulings ledger

Facts established while planning, kept so nobody re-derives them.

| #   | Fact                                                                                                                                                                                                                                                                            | Evidence                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R1  | `/run/jarv1s` does not exist on the dev host, and the allowed socket directory is a hardcoded literal with no env override.                                                                                                                                                     | `ls -ld /run/jarv1s` → no such file (2026-08-19); `packages/chat/src/live/chat-engine-rpc-client.ts:78,576-588` |
| R2  | There is no way to ask whether migrations are current without applying them.                                                                                                                                                                                                    | `scripts/migrate.ts` exports nothing; `packages/db/src/migrations/sql-runner.ts` has no pending-list API        |
| R3  | The repo has no masked password prompt; the one existing prompt echoes the password.                                                                                                                                                                                            | `scripts/admin-reset-password.ts:124-131`                                                                       |
| R4  | Provider credential testing and model discovery both refuse `auth_method: "cli"`, so neither `POST /api/ai/providers/:id/test` nor the discovery routes can serve as a health check here.                                                                                       | `packages/ai/src/provider-validation.ts:21-23,51`                                                               |
| R5  | `ensureDefaultChatModel` already creates the provider with `authMethod:"cli"` and a `{cli:true}` sealed sentinel, and already flags the instance default when it is the sole active provider.                                                                                   | `packages/ai/src/auto-register.ts`                                                                              |
| R6  | `getMossDatabaseUrls` already refuses `NODE_ENV=production` and non-dev host/port — but an explicit `JARVIS_APP_DATABASE_URL` bypasses that, so a dedicated guard is still required.                                                                                            | `packages/db/src/urls.ts:24,33-42`                                                                              |
| R7  | Integration tests run against `jarvis_test_<entropy>`, which the dev guard rejects by design. Hence the guard lives at the CLI entry (`runDevInstanceCli`) while the orchestrators take already-opened handles — otherwise no integration test of `provision` could run at all. | `scripts/test-integration.ts` `createDatabaseIsolationPlan`; §5 `scripts/dev-instance.ts` contract              |
| R8  | The api/worker bundles are built by esbuild entrypoint reachability with only three explicit file copies, so nothing under `scripts/` ships unless application code imports it.                                                                                                 | `scripts/build-app.ts:28-31,85-130`                                                                             |
| R9  | `check:package-deps` scans `packages/*` only; a new `scripts/` file declares nothing. `check:file-size` does cover `scripts/`.                                                                                                                                                  | `scripts/check-package-deps.ts:28`; `scripts/check-file-size.ts:6-19`                                           |
| R10 | An env var whose name does not start with `JARVIS_` passes through `resolveMossEnv` cleanly with no alias warning — hence the `MOSS_DEV_INSTANCE_*` naming.                                                                                                                     | `packages/db/src/env.ts:87-105`                                                                                 |
| R11 | No script anywhere drives `POST /api/auth/sign-up/email`; every caller is `server.inject` inside an integration test. `createApiServer` is exported, so injection from a script is available.                                                                                   | `apps/api/src/server.ts:214`; 20+ `tests/integration/*.test.ts`                                                 |

---

## 10. Review checklist

- [x] Spec approved (PR #1742) and task issue #1258 open
- [x] Every assumed platform capability cited `file:line`, or listed as an open question (OQ-1)
- [x] No function bodies — signatures, types, test cases and verification commands only
- [x] Determinism boundary stated (§3); guidance budget 0 words, no model call
- [x] Each phase names its e2e test (§7 for the shipped path)
- [x] Every verification command unpiped, with an expected exit code
- [x] Kill gate named after Phase 1, with Ben as owner
- [x] Steelmanned the rejected option on both forks (F-1 real HTTP, F-2 pipe-vs-tempfile)
