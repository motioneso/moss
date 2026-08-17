# Dev UAT Harness — on-demand ephemeral instance + tiered seed + Playwright e2e

- **Date:** 2026-07-12
- **Issue:** epic #1000 — "[epic] Dev UAT harness: on-demand ephemeral instance + tiered seed +
  Playwright e2e"
- **Grounded on:** `origin/main` @ `daa91518bd9fff8b98873d31c1a60e37331bd107`
- **Status:** APPROVED 2026-07-13 (Ben). §9 open questions resolved:
  1. **Gate tier = BLOCKING** for runtime-path PRs (install / sync / export-import / nav / CLI-runner):
     "if UAT fails, fix it and UAT again" — a red UAT is never waived, the lane fixes and re-runs until
     green. Advisory-surfaced for non-runtime-path PRs.
  2. **Seed volume = lived-in account** (admin+data looks genuinely used). CONSTRAINT: lived-in seeds
     MUST be deterministic (fixed data, no randomness / no wall-clock-relative values) so the gate does
     not flake.
  3. **Execution = local / coordinator-only** for now (no CI / DinD until a later, separately-approved
     phase).
  4. **Provisioning = provision-per-run first; measure real wall-clock before** building the template-DB
     optimization (do not pre-optimize).
  5. **Real network egress to github.com / githubusercontent.com at test time = allowed** (real
     registry download is the path #999 slipped through; mocking it defeats the purpose).
- **Related:** #999 (job-search install 4x-extract-guard bug this harness would have caught), #853/
  #854 (owner-signup deadlock this design deliberately sidesteps), #964 spec
  `docs/superpowers/specs/2026-07-12-module-distribution-install.md` (the install/reconcile machinery
  the first UAT spec drives)

## 0. What's locked (do not re-litigate)

Ben settled the design in the epic body 2026-07-12. Restated here so the rest of this document reads
as mechanics, not proposal:

1. **On-demand ephemeral Compose instance per run** — `docker compose -p uat-<id> up` with fresh DB
   - volumes → seed → run Playwright → `down -v`. Must be faithful to the real
     container/modules-volume/boot-reconcile path (the path install actually uses), which means the
     **prod-shaped compose** (`infra/docker-compose.prod.yml`), not the dev compose.
2. **Tiered seed levels**, a ladder: `bare` → `solo-admin` → `admin+data` → `multi-user`. Composed
   from per-feature chunks (news, sports, notes, tasks, calendar, per-external-module data). A script
   can subtract a chunk from a level (e.g. `admin+data` minus job-search installed).
3. **Seed script runs as dev-only privileged connection** (migration-class tooling, DB owner role) —
   never a runtime app/worker role. Keeps the "no BYPASSRLS on runtime roles" hard invariant intact.
4. **Demo admin logs in for real** — seed pre-inserts a better-auth credential account with a known
   dev password; Playwright types it into the actual `/login` form. Auth is exercised every run;
   sidesteps the #853/#854 owner-signup deadlock by never going through the signup after-hook.
5. **Each test script declares its required level**; the harness provisions + seeds + runs + disposes.
6. **Plugs into the coordinate flow** as an e2e-UAT step for data-flow-tier PRs (distribution / sync
   / export / import). Advisory-by-default; gating tier TBD at spec review (see Open Questions).
7. **First deliverable**: job-search install UAT — seed `admin+data` minus job-search → log in as
   admin → Settings → Instance modules → assert job-search listed → Install → assert active, no
   error. Doubles as acceptance proof for #999.

## 1. Goal

Give the project a **low-cost (Sonnet-authored), durable, real-backend e2e layer** that exercises
production-shaped data flow — install/download/extract, auth, cross-module writes — the same class of
bug that mocked-REST e2e (`tests/e2e/*.spec.ts` today) and diff review structurally cannot catch,
demonstrated concretely by #999 shipping through three review passes with nobody walking
publish→download→extract→install→activate against a real artifact.

## 2. Non-goals

- **Not a replacement** for `tests/e2e/*.spec.ts` (mocked-REST, Vite-only, `playwright.config.ts`).
  Those stay fast/cheap for UI-shape regressions; UAT is for data-flow-tier changes only.
- **Not a replacement** for `tests/integration/*` (Vitest + `JARVIS_PGDATABASE` isolation against the
  shared dev Postgres). UAT is heavier and slower by design — full container boot, real registry
  fetch — so it is reserved for the class of bug integration tests can't see (container boot,
  module-volume reconcile, real HTTP egress to GitHub releases).
- **No CI wiring in this phase** — Phase 4 (below) wires the coordinate e2e-UAT _step_, which is a
  local/coordinator-invoked gate, not a GitHub Actions job. Whether it ever becomes a CI job is an
  open question (§8).
- **No parallel-run scheduler.** This spec assumes one UAT run at a time locally; concurrent runs are
  possible (compose project names are unique) but a queueing/orchestration layer is out of scope.
- **No new seed data for modules beyond what's needed for the phased build plan's chunks.** Building
  out every module's seed chunk is follow-on task work, not this spec.
- **No signing/marketplace concerns** — out of scope per the #964 spec this harness exercises.

## 3. Provisioning mechanics

### 3.1 Base: prod-shaped compose, not dev compose

`infra/docker-compose.yml` (dev) runs `api`/`web`/`worker` as three live-reload Node processes with
bind-mounted `node_modules` — it never exercises `scripts/start-jarv1s.ts`, so it never runs
`scripts/module-reconcile.ts` at boot. `infra/docker-compose.prod.yml` is the one real path: the
`jarv1s` service's `start-jarv1s.ts` entrypoint runs `migrate.ts` → `module-reconcile.ts` → cli-runner

- worker + API, in that order (`scripts/start-jarv1s.ts:107-111`). Module install/activation _only_
  happens through that reconcile pass. The UAT harness **must** build/run against
  `docker-compose.prod.yml`, matching the existing `pnpm smoke:compose:prod` pattern
  (`scripts/smoke-compose.ts`, `--build` flag builds the image locally and tags it
  `ghcr.io/motioneso/jarv1s:${JARVIS_IMAGE_TAG}`).

`scripts/smoke-compose.ts` is the closest existing precedent and should be the direct ancestor of the
new provisioner — it already knows how to: build the image locally, write a throwaway
`env.production.local` with dev-shaped secrets, bring up `postgres` + `jarv1s` with `--wait`, and poll
`/health/ready` (not `/health` — the readiness probe, which checks DB + pg-boss, per the existing
`#171` comment at `scripts/smoke-compose.ts` `waitForHealth`). The UAT provisioner reuses this
shape but adds: a unique `-p` project name, an ephemeral env file with seed-controlled contents, an
explicit module-reconcile step _after_ seeding but _before_ the first Playwright navigation for
levels that pre-install modules, and teardown via `down -v`.

### 3.2 Exact invocation shape

```
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml config --quiet   # validate
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml up -d postgres --wait
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml --profile ops \
  run --rm migrate                                                              # scripts/migrate.ts
# --- seed step runs here, against the now-migrated but not-yet-started DB (§4) ---
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml up -d jarv1s --wait
# --- Playwright runs here, baseURL = http://127.0.0.1:<allocated-port>/ ---
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml --profile ops \
  run --rm module-install                                                       # if a mid-run reconcile is needed (job-search spec, §6)
docker compose -p uat-<runId> -f infra/docker-compose.prod.yml down -v          # teardown, always (even on failure — trap/finally)
```

`<runId>` = short random/entropy suffix (mirrors `scripts/test-integration.ts`'s
`${process.pid}_${randomBytes(4).toString("hex")}` pattern) — not a fixed literal, so two UAT runs
(local + a concurrent coordinator run) never collide on the same Compose project.

### 3.3 Volume isolation

Compose scopes named volumes by **project name** automatically — `docker-compose.prod.yml`'s
`jarv1s-postgres-data`, `jarv1s-modules`, `jarv1s-vault-data`, `jarv1s-model-cache`,
`jarv1s-cli-tools`, `jarv1s-cli-auth`, `jarv1s-cli-socket` volumes become
`uat-<runId>_jarv1s-postgres-data` etc. under `-p uat-<runId>`. No compose-file changes needed for
volume isolation — the `-p` flag is sufficient, and `down -v` at teardown drops all of them. This is
exactly what makes "clean by construction" true: a run either completes and gets torn down, or a
crashed run leaves an orphaned `uat-<runId>-*` project that a housekeeping sweep
(`docker compose -p uat-<runId> down -v` by pattern-matched `docker ps -a --filter
name=uat-`) can reap without touching dev (`jarv1s-postgres-data` unprefixed) or prod
(`jarv1s-prod_*`) volumes.

**Model cache volume caveat**: `jarv1s-model-cache` backs the in-process embedding model
(`HF_HOME`). A fresh named volume per run means every UAT run **downloads or reloads the embedding
model from scratch** unless the harness deliberately shares/pre-warms this one volume across runs
(named identically, outside the `-p` scope, or pre-seeded via `docker volume create` + a warm copy).
Flag as a build-phase decision, not blocking for Phase 1 (bare/solo-admin levels don't need
embeddings).

### 3.4 Port allocation

Dev uses `:5173` (web) / `:3000` (api) via `docker-compose.yml`; prod uses `:1533` via
`JARVIS_WEB_PORT` (`infra/docker-compose.prod.yml`, `ports: - "${JARVIS_WEB_PORT:-1533}:3000"`). The
UAT harness must never hardcode `1533` or any dev port. Two viable strategies, in order of
preference:

1. **OS-assigned ephemeral port**: set `JARVIS_WEB_PORT=0` is _not_ supported by Docker's classic
   port-publish syntax the way it is for raw sockets — Compose requires a concrete host port or a
   fixed range. Use a **narrow reserved UAT range** instead, e.g. `JARVIS_WEB_PORT` picked from
   `2000x`–`2009x` by a simple "bind, if `EADDRINUSE` retry next" probe in the provisioner (same
   technique `scripts/smoke-compose.ts` could adopt but currently doesn't — it relies on the single
   well-known smoke project name never running twice concurrently). This is the simplest correct
   answer and matches how `JARVIS_DOCKER_SUBNET` is already handled (see below).
2. Alternatively, publish with `"127.0.0.1::3000"` (no host port — Docker assigns one) and discover
   the actual bound port via `docker compose -p uat-<runId> port jarv1s 3000` before starting
   Playwright. This fully removes port-collision risk at the cost of one extra shell-out. **Preferred
   for Phase 1** since it needs zero coordination between concurrent runs.

**Docker network subnet**: `docker-compose.prod.yml`'s `jarv1s` network already takes
`JARVIS_DOCKER_SUBNET` as an override (default `10.251.0.0/24`; smoke script overrides to
`10.253.0.0/24` per `scripts/smoke-compose.ts` `ensureProdSmokeEnv`). The UAT provisioner must pick
its own subnet (e.g. `10.254.0.0/24` reserved for UAT, distinct from smoke's `10.253.0.0/24` and
dev/prod's `10.251.0.0/24`) so concurrent smoke + UAT + dev runs never IP-collide on the Docker
bridge.

### 3.5 Teardown

`down -v` unconditionally, in a `finally`/`trap` so a Playwright failure (including a timeout) still
tears the stack down — mirrors `scripts/smoke-compose.ts`'s `try { ... } finally { cleanup(); }`
around the temp env-file directory, extended here to also cover the compose stack itself, not just
the temp files.

## 4. Seed architecture

### 4.1 Privileged connection, not a runtime role

The seed script connects as **`jarvis_migration_owner`** (`JARVIS_MIGRATION_DATABASE_URL` — see
`infra/docker-compose.yml`'s `migrate` service env, or the equivalent env-file entry for the prod
compose) — the same role `scripts/migrate.ts` uses. This is deliberate and matches the epic's "seed
script = dev-only privileged connection (migration-class tooling)" line: `jarvis_migration_owner` is
`NOSUPERUSER`/`NOBYPASSRLS` (`infra/postgres/bootstrap/0000_roles.sql`) but is a schema owner with
unrestricted DML on every table it created, and critically is **granted membership in
`jarvis_auth_runtime`** (`GRANT jarvis_auth_runtime TO jarvis_migration_owner;`, same bootstrap file,
added for migration 0045's `SECURITY DEFINER` function ownership transfer). That membership is what
lets the seed script `SET LOCAL ROLE jarvis_auth_runtime;` inside its seed transaction to legitimately
write `app.auth_accounts` / `app.better_auth_sessions`, which migration 0045 FORCE-RLS-restricts to
`jarvis_auth_runtime` only (`auth_accounts_auth_runtime` / `better_auth_sessions_auth_runtime`
policies, `USING (true) WITH CHECK (true)`, `infra/postgres/migrations/0045_auth_secret_rls.sql`).
No new role, no RLS carve-out, no runtime-role privilege change — the seed script uses machinery that
already exists for exactly this reason. This is the concrete substantiation of "no BYPASSRLS on
runtime roles stays intact": `jarvis_migration_owner` never bypasses RLS; it satisfies the existing
`USING (true)` policy by assuming a role the policy already trusts.

### 4.2 Loginable admin mechanics — exact hash format

better-auth (`packages/auth`, `better-auth@1.6.14`) hashes credential passwords with Node's built-in
`scrypt`, not bcrypt/argon2. Confirmed from the installed package
(`@better-auth/utils/password.node.mjs`, resolved via the `better-auth/crypto` re-export used in
`packages/auth/src/index.ts`):

```
N=16384, r=16, p=1, dkLen=64
salt = randomBytes(16).toString("hex")
key  = scrypt(password.normalize("NFKC"), salt, dkLen, { N, r, p, maxmem: 128*N*r*2 })
hash = `${salt}:${key.toString("hex")}`
```

Stored verbatim in `app.auth_accounts.password` (text column, `infra/postgres/migrations/0004_auth_workspaces_settings.sql`). The seed script must **not** reimplement this — `better-auth/crypto`
exports `hashPassword(password): Promise<string>` (`packages/auth`'s own dependency, already
installed) and the seed script (tsx, Node runtime, same as migration tooling) can call it directly to
produce a real, verifiable hash for a known dev password (e.g. `JARVIS_UAT_ADMIN_PASSWORD`, an
env-supplied constant, never committed). Using the library's own function guarantees the hash matches
whatever better-auth's `verifyPassword` expects even if the algorithm changes on a future
`better-auth` bump — reimplementing scrypt params by hand would silently drift.

Row shape for a loginable, already-bootstrapped admin (no signup flow, no advisory lock, no
after-hook — this is the entire point of seeding directly rather than driving `/signup`):

- `app.users`: `id` (uuid), `email`, `name`, `email_verified = true`, `is_instance_admin = true`,
  `is_bootstrap_owner = true`, `status = 'active'`. (Columns per
  `infra/postgres/migrations/0004_auth_workspaces_settings.sql` +
  `packages/auth/src/index.ts:bootstrapFirstJarvisUser`'s update shape — mirror what that function
  sets on the winning first-user row, minus the advisory-lock dance, which is irrelevant for a
  single deterministic seed.)
- `app.auth_accounts`: `account_id` (better-auth convention: same value as the user's email for the
  `credential` provider — confirm exact convention against a real signup row if ambiguous, don't
  guess a different scheme), `provider_id = 'credential'`, `user_id` = the users row's id,
  `password` = the scrypt hash above, `scope = null` (credential accounts don't use OAuth scope).
- `app.better_auth_sessions`: **not required at seed time.** Playwright drives the real `/login`
  form, which calls better-auth's sign-in endpoint and mints a session itself — seeding a session row
  would bypass exactly the auth surface the epic wants exercised ("auth exercised every run"). Do not
  pre-seed a session.

This sidesteps #853/#854 (owner-signup deadlock: the after-hook's compensating delete race) because
the seed never calls the signup endpoint or its after-hook at all — it writes finished, consistent
rows directly, the same shortcut integration tests already take
(`tests/integration/release-hardening.test.ts`'s `seedLifecycleData` inserts `auth_accounts` rows
directly, though with a sentinel non-real password since those tests never log in through a form).

### 4.3 The level ladder

| Level        | Contents                                                            | Primary purpose                                                   |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `bare`       | Migrated DB, zero users, zero data                                  | Boot/reconcile smoke only (no login target)                       |
| `solo-admin` | + one loginable admin (§4.2), no other data                         | Auth flow, admin-only settings surfaces                           |
| `admin+data` | + normal per-feature chunks (§4.4) enabled/populated for that admin | Default level for feature UAT — "an admin who's used the product" |
| `multi-user` | + a second non-admin user, cross-user share/RLS fixtures            | Sharing, RLS, recipient-only surfaces                             |

Levels are **additive and scripted as composition**, not four independent SQL files: `solo-admin` =
`bare` + admin-seed function; `admin+data` = `solo-admin` + the selected chunk set; `multi-user` =
`admin+data` + a second-user chunk. A test requesting a level with chunks _subtracted_ (the epic's
job-search example: "`admin+data` minus job-search installed") composes `admin+data`'s chunk list
minus the named chunk(s), not a fifth hardcoded level.

### 4.4 Per-feature chunk list (Phase 2 build scope)

Each chunk is a small, independently-runnable seed unit (a function, keyed by name) that a level
composes from. Concrete chunks identified from the codebase (not exhaustive — build-phase adds more
as new UAT specs need them):

- **`news`** — at minimum one followed topic **and** an active AI provider/model bound to the
  `module.news` capability service, or the settings UI 503s with "Topic checking is unavailable
  right now" (`packages/news/src/settings/index.tsx:206`; the resolution path is
  `AiRepository.resolveModelForService(scopedDb, "module.news", …)`,
  `packages/ai/src/repository.ts:1166`). Reuse whatever seeding helper `tests/integration/ai*.test.ts`
  already uses to stand up an active provider+model — don't hand-roll a second implementation of
  that setup.
- **`sports`** — followed team(s) (per the epic's own chunk list).
- **`notes`**, **`tasks`**, **`calendar`** — baseline rows per module (exact shape = build-phase task,
  each module owns its own seed data; keep it minimal — see Open Questions on seed volume).
- **`job-search` (external module)** — the interesting case: this chunk is _absence_ by default in
  `admin+data` (job-search is not core, not required) and its presence/absence is exactly what the
  first UAT spec toggles. "Installed" here means: the module's DB-side install phase has run
  (per-module tables exist, `app.external_modules` / registry-state row shows
  `installed-enabled`) — which for a _fresh_ ephemeral instance the chunk can either (a) skip
  entirely, leaving the module truly "not-installed" for the UAT to exercise the real
  download-through-reconcile path (this is what the first spec needs), or (b) pre-install by running
  the same install code path non-interactively, for tests that need job-search _already present_ as
  a precondition for something else.

### 4.5 Template-DB clone — feasibility, not adopted for Phase 1

`scripts/test-integration.ts`'s `createDatabaseIsolationPlan` today does a \*\*plain `CREATE DATABASE`

- full migration run** per isolated test invocation (`ensureDatabaseExists`, no `TEMPLATE` clause,
  `getMaintenanceConnectionString` connects to the `postgres` maintenance DB the same way a
  `CREATE DATABASE ... TEMPLATE tmpl` would need to). There is **no existing template-clone
  infrastructure to reuse** — this would be new. It's viable: `CREATE DATABASE uat_run_<id> TEMPLATE
uat_seed_<level>` is a standard Postgres feature, requires no other session connected to the template
  DB at clone time (a real constraint for a long-lived warm template — the provisioner would need to
  hold the template DB unused/idle, or `pg_terminate_backend` stragglers before cloning), and would
  skip re-running `migrate.ts` + the seed script's DDL/DML on every run — only the fast `CREATE DATABASE
... TEMPLATE` copy. This is a genuine speed win **if** the ephemeral-compose-per-run overhead (image
  build/pull, container boot, module-reconcile) turns out to dominate anyway, in which case the DB seed
  time isn't the bottleneck and template-cloning buys little. Recommendation: **build Phase 1 without
  it, measure wall-clock per run, and revisit only if seeding (not container boot) is the dominant
  cost\*\* — this is one of the Open Questions for Ben (§8).

## 5. Playwright harness layout

New, separate from `tests/e2e/**` (which stays mocked-REST, `playwright.config.ts`, `baseURL:
http://127.0.0.1:4173`, Vite-only `webServer`). Proposed layout:

```
tests/uat/
  playwright.uat.config.ts   # new config: no webServer (the compose provisioner owns startup),
                              # baseURL resolved at runtime (see §3.4 port discovery)
  provisioner.ts             # compose up/seed/down orchestration (§3)
  seed/
    levels.ts                # bare / solo-admin / admin+data / multi-user composition (§4.3)
    chunks/
      admin.ts                # §4.2 loginable admin
      news.ts, sports.ts, notes.ts, tasks.ts, calendar.ts   # §4.4
      job-search.ts            # install/absence toggle
  specs/
    job-search-install.uat.spec.ts   # first deliverable (§6)
```

A **level declaration convention** on each spec — since Playwright specs are plain TS, the simplest
mechanism that needs no new Playwright fixture machinery is a named export the provisioner reads
before running the file, e.g.:

```ts
export const uatLevel = { level: "admin+data", without: ["job-search"] } as const;
```

The provisioner (a thin CLI, not a Playwright global-setup hook — global-setup runs _inside_ the
Playwright process after `webServer` would already be up, which is backwards here since the
provisioner must exist _before_ Playwright even has a `baseURL`) reads this export via a static
import or a lightweight manifest step, provisions accordingly, injects the resolved `baseURL` as an
env var Playwright's config reads, runs `playwright test tests/uat/specs/<file>`, then tears down.
One provisioner invocation = one spec file = one ephemeral instance, matching "each test script
declares its required level; the harness provisions + seeds + runs + disposes" from the locked
design. (Whether a future phase batches multiple specs against one instance for speed is out of
scope for Phase 1 — start with the simple 1:1 mapping.)

### `package.json` script (Phase 3 addition)

```
"test:uat": "tsx tests/uat/run-uat.ts"          # runs every tests/uat/specs/*.uat.spec.ts
"test:uat -- job-search-install"                 # single spec, by name/glob
```

`test:uat` keeps the existing "one wrapper script, arg-filterable" convention.

## 6. First spec: job-search install (explicit steps)

Grounded against the real UI (`apps/web/src/settings/settings-module-registry-section.tsx`,
`settings-instance-modules-pane.tsx`) and the real install/reconcile path
(`scripts/start-jarv1s.ts`, `scripts/module-reconcile.ts`, per the #964 spec). `mockExternalModules`/
`mockApi` (`tests/e2e/mock-modules.ts`, `mock-api.ts`) are explicitly **not** used here — this spec
hits the real ephemeral instance.

1. **Provision**: `uatLevel = { level: "admin+data", without: ["job-search"] }` — a running instance
   with the demo admin, normal chunk data, and job-search absent (not installed, not staged).
2. **Real login**: navigate to `/login`, fill email + `JARVIS_UAT_ADMIN_PASSWORD`, submit. Assert
   landing on the authenticated shell (not still on `/login`) — this is the auth exercise the design
   calls out explicitly.
3. Navigate to `/settings`. Click the `"Admin / Setup"` button, then `"Instance modules"`
   (`page.getByRole("button", { name: "Admin / Setup" })` →
   `page.getByRole("button", { name: "Instance modules" })`, matching the existing
   `settings-modules.spec.ts` navigation pattern). Assert heading `"Instance modules"` visible.
4. Assert the `"Available modules"` section (`aria-label="Module registry"`,
   `settings-module-registry-section.tsx:177-178`) lists a row for job-search with state label
   `"Not installed"` and an `"Install"` button visible (`canInstall` / `STATE_LABELS`,
   `settings-module-registry-section.tsx:32-36,167-171`). **This step alone requires the real
   registry fetch to have succeeded** — `resolveRegistryIndexUrl` refuses any override when
   `NODE_ENV=production` (`packages/module-registry/src/distribution/registry-source.ts:23-27`), so
   the ephemeral instance genuinely hits `https://github.com/motioneso/jarv1s/releases/download/
modules/index.json` over real network egress. This is intentional and is the whole point — it's
   the "real artifact" #999 slipped through review without ever touching. Requires: (a) network
   egress from the container to `github.com` / `objects.githubusercontent.com` /
   `release-assets.githubusercontent.com`, and (b) job-search actually present in the published
   registry index (it is — `.github/workflows/modules-registry.yml` publishes on
   `external-modules/**` changes).
5. Click `"Install"` on the job-search row. Assert the confirm dialog title `"Install Job Search?"`
   (or whatever `row.name` resolves to) and click the confirm button labeled `"Download"`
   (`onInstall`, `settings-module-registry-section.tsx:126-134`).
6. Assert the download completes: state label transitions away from `"Not installed"` to a
   pending-restart state, and the pending-restart `Note` becomes visible (`"Downloaded modules apply
on the next restart..."`, `settings-module-registry-section.tsx:183-187`). Assert **no**
   `"install-failed"` state and no `lastInstallError` text.
7. **Trigger the real activation path**: `docker compose -p uat-<runId> -f
infra/docker-compose.prod.yml restart jarv1s` (or an `up -d jarv1s` recreate) — this re-runs
   `start-jarv1s.ts`'s boot sequence, which runs `migrate.ts` then `module-reconcile.ts`
   (`scripts/start-jarv1s.ts:107-111`), the exact step whose 4× extract-guard bug (#999) shipped
   unreviewed. Wait for `/health/ready` again before continuing (same readiness contract as
   provisioning, §3.1).
8. Re-authenticate (the container restart does not necessarily preserve the browser's session
   cookie's server-side validity across a full process restart the same way live-reload dev doesn't
   restart — verify empirically in build phase whether re-login is actually required, or the existing
   session survives; write the spec defensively either way) and navigate back to Settings → Instance
   modules.
9. **Assert the acceptance condition**: job-search row now shows `"Installed"`
   (`installed-enabled`), the enable `Switch` (`ariaLabel="Enable Job Search"`,
   `settings-module-registry-section.tsx:214-224`) is checked or checkable, and there is no error
   text anywhere on the row. This is the #999 acceptance proof.
10. **Teardown**: provisioner tears the instance down (`down -v`) regardless of pass/fail.

## 7. Declaring a test's required level / plugging into coordinate

- **Declaration**: the `uatLevel` named export convention (§5) is the single source of truth a spec
  states its own requirement in — no separate registry file to keep in sync, no risk of a spec and
  its manifest entry drifting apart.
- **coordinate / coordinated-qa integration**: today's risk-tier ladder
  (`.claude/skills/coordinate/SKILL.md`) is `routine` / `sensitive` / `security`; `sensitive` already
  names "export/deletion paths" as a trigger category alongside shared-table migrations and job-payload
  shape changes. The epic's "data-flow-tier PRs (distribution / sync / export / import)" maps
  naturally onto **extending the `sensitive` tier's definition** to explicitly include "module
  distribution / install / reconcile" changes, rather than inventing a fifth tier. Concretely: add an
  **e2e-UAT step** to `coordinated-qa`'s step 4 ("Tier-specific depth") for `sensitive`-tier PRs whose
  diff touches a path with a matching UAT spec (start with: any diff under
  `packages/module-registry/**`, `scripts/module-reconcile.ts`, `scripts/start-jarv1s.ts`, or
  `apps/web/src/settings/settings-module-registry-section.tsx` → run
  `tests/uat/specs/job-search-install.uat.spec.ts`). As more UAT specs exist for other data-flow
  surfaces (sync, export, import), their trigger paths get added to the same lookup — this spec does
  not attempt to enumerate all of them up front.
- **Advisory vs. blocking**: per the epic, advisory-by-default. See Open Questions (§8) — this is
  explicitly Ben's call, not pre-decided here.

## 8. Phased build plan (maps to child task issues under #1000)

1. **Ephemeral-instance provisioner** — `tests/uat/provisioner.ts`: compose up/seed-hook-point/down,
   port discovery (§3.4), subnet allocation (§3.4), volume-naming verification, teardown-on-failure
   (`trap`/`finally`). Deliverable is provisionable + tearable-down with **zero** seed data (`bare`
   level) — proves the mechanics before any seed script exists. Includes the model-cache-volume
   decision (§3.3).
2. **Seed script**: `tests/uat/seed/levels.ts` + the admin chunk (§4.2, loginable admin via
   `better-auth/crypto`'s real `hashPassword`) + `solo-admin` level. Extends to `admin+data` with the
   news/sports/notes/tasks/calendar chunks (§4.4) and `multi-user` with a second-user chunk. Job-search
   absence/presence toggle included here since the first spec needs it.
3. **Playwright harness + first spec**: `tests/uat/playwright.uat.config.ts`, `run-uat.ts` wrapper,
   `job-search-install.uat.spec.ts` (§6) end to end, `package.json`'s `test:uat` script.
4. **Wire into coordinate e2e-UAT step**: extend `coordinated-qa`'s sensitive-tier depth (§7) with the
   trigger-path lookup, run it locally against a real #999-shaped diff to confirm it would have
   caught the original bug, document the advisory/blocking decision once Ben has answered §8.

Each numbered item above is intended to become one child task issue under #1000, in this order —
Phase 2 depends on Phase 1's provisioner existing; Phase 3 depends on Phase 2's admin+job-search
chunks; Phase 4 depends on Phase 3's working spec.

## 9. Open questions for Ben

1. **Advisory-vs-blocking gate tier.** The epic says "advisory-by-default proposal; gating tier TBD
   at spec review" — is UAT failure ever going to be a merge-blocking condition (like `security`-tier
   Opus QA today), or does it stay a signal the coordinator surfaces but never gates on, indefinitely?
2. **Exact seed data volume per chunk.** §4.4 lists chunks at "at least enough to exercise the
   surface" granularity (e.g. one followed news topic, one followed sports team) — should chunks be
   kept deliberately minimal (fast provisioning, narrow assertions) or should `admin+data` aim to look
   like a genuinely lived-in account (more realistic, slower, harder to keep deterministic)? This
   materially changes Phase 2 scope.
3. **CI vs. local-only execution.** This spec's Phase 4 wires UAT into the _coordinate_ flow
   (coordinator/QA-agent-invoked), not GitHub Actions. Should UAT ever run in CI (needs a Docker-in-
   Docker or privileged runner, network egress to GitHub releases from the CI network, and materially
   longer PR turnaround), or does it stay a local/coordinator-only gate permanently?
4. **Ephemeral-compose-per-run speed vs. template-DB.** §4.5 recommends measuring before building the
   `CREATE DATABASE ... TEMPLATE` optimization. Once Phase 1-3 exist and there's a real wall-clock
   number, is a slow-but-simple provision-per-run (image build/pull + container boot + fresh
   migrate + seed, likely tens of seconds to a couple minutes) acceptable for the advisory gate's
   expected call frequency, or is fast iteration important enough to prioritize the template-DB
   optimization (and, separately, an image-build cache strategy) into an earlier phase than Phase 4?
5. _(Secondary, surfaced during grounding, not in the original prompt's required list but worth a
   yes/no)_: is it acceptable for the first UAT spec to depend on live network egress to
   `github.com`/`githubusercontent.com` at test-run time (real registry, no local mock, per
   `registry-source.ts`'s production-mode override refusal), including in whatever environment
   eventually runs this (local dev box vs. CI, tying back to Q3)?
