# Moss rename Tier C (#1443): carve-out list and coverage gaps

Companion to `docs/superpowers/specs/2026-08-05-moss-rename-design.md` §3/§3.1. That spec commits
to an explicit, per-variable carve-out list rather than renaming all `JARVIS_*` names uniformly;
this document is that list, plus the small number of genuinely unreachable reads found while
building it. `packages/db/src/env.ts`'s own doc comment points here, and its `CARVE_OUT` set must
stay in sync with the "Carve-out" table below.

## Method

Every `JARVIS_*` name in the repository was classified into exactly one of four buckets:

1. **Shimmed** — read via `resolveMossEnv(env, "JARVIS_X")` in TypeScript. Prefers `MOSS_X`, falls
   back to `JARVIS_X` with a one-time warning.
2. **Carved out** — read by something the TypeScript shim cannot reach: Docker Compose host-side
   `${JARVIS_X}` interpolation in `infra/docker-compose*.yml`, one of the seven shell scripts
   that read `$JARVIS_X` directly, or a build-time config file loaded by plain Node before any
   app code runs (see "Build-time config files" below). Renaming these requires the host env file
   and the reader to change in the same step (Tier D/PR4 cutover), so this PR leaves them as plain
   `env[jarvisName]` passthroughs — `resolveMossEnv` special-cases every carved-out name to do
   nothing.
3. **Deliberately deferred (documented gap)** — read by code that exists but is outside the
   TypeScript module graph, so the shim is structurally unreachable there even though the same
   name is correctly shimmed at its real production call site. Listed below rather than silently
   dropped.
4. **Not an environment variable** — a false positive of grepping for `JARVIS_[A-Z0-9_]+`: a local
   constant name, a regex, a doc placeholder, or `__JARVIS_MODULE_RUNTIME__` (a `window`/
   `globalThis` property, never read from `process.env`). Excluded from every count in this
   document.

### The dual-consumption rule (buckets 1 and 2 are not symmetric)

**A variable expanded by Docker Compose host-side interpolation is carve-out regardless of whether
TypeScript also reads it. Dual consumption means carve-out, not shim. Being read by TypeScript does
not make a name shim-eligible if the host also expands it.**

The reasoning is that the two failure modes are not equally bad. Shimming a host-interpolated name
renames only the TypeScript reader, so an operator who sets `MOSS_X` satisfies the app while the
host still sees `JARVIS_X` unset and silently falls back to the compose default. The host's belief
and the app's belief then diverge with no error anywhere — for `JARVIS_WEB_PORT` that is a container
published on one port while the app computes its trusted origins for another, which presents as an
unexplained sign-in failure. Leaving a name carved out costs only a deferred rename. A crash would
be recoverable; silent divergence between the host and the app is not, so the tie always breaks
toward carve-out.

Note the distinction that decides this, since most compose references are _not_ host interpolation:

- `JARVIS_X: ${JARVIS_X:-default}` — **host-side interpolation.** Docker Compose expands this from
  the host environment or `--env-file` before the container exists. The shim cannot reach it.
  Carve-out.
- `JARVIS_X: /some/literal` — compose merely _sets_ the variable inside the container. No host
  expansion happens, the value is fixed in the compose file, and the in-container TypeScript reader
  is the only consumer. The shim's `JARVIS_X` fallback handles this correctly (with a deprecation
  warning), so these stay shimmed.

Re-audited against this rule: all 19 host-interpolated `${JARVIS_*}` names across `infra/*.yml` are
in the carve-out table below, and no shimmed name is host-interpolated. Ten names are _mentioned_ in
a compose file (`JARVIS_API_PROXY_TARGET`, `JARVIS_CHAT_HOME`, `JARVIS_CLI_HOME`,
`JARVIS_CLI_HOME_BASE`, `JARVIS_CLI_NEUTRAL_BASE`, `JARVIS_MODULES_DIR`, `JARVIS_MULTIPLEXER`,
`JARVIS_NOTES_ROOTS`, `JARVIS_WEB_DIST_DIR`, and `JARVIS_CLI_RUNNER_SOCKET`), of which two are
already carved out — but for two different reasons, not one. `JARVIS_CLI_RUNNER_SOCKET` is
host-interpolated. `JARVIS_API_PROXY_TARGET` is a literal-value `environment:` entry in compose
(`infra/docker-compose.yml:124`, not host-interpolated) but is carved out anyway for the unrelated
"build-time config files" reason above — `apps/web/vite.config.ts` reads it directly. The other
eight are literal-value `environment:` entries or comments with no other carve-out reason, which the
rule leaves shimmed. There is also no implicit `- JARVIS_X` pass-through form anywhere in `infra/`,
which would otherwise be host-side too.

### Build-time config files (a second carve-out category, not host expansion)

A vite config, playwright config, or any other build/test-runner config that plain `node` loads
before invoking the tool proper sits **outside the application's module graph** — the same
structural class as Compose host-side interpolation, even though no host process substitutes the
value. `apps/web/vite.config.ts` and `tests/uat/playwright.uat.config.ts` are both loaded this way:
Vite's Docker-build config-load step and Playwright's config-load step both run as plain Node with
no TypeScript path resolution, so an `import { resolveMossEnv } from "@moss/db"` there drags in
`packages/db/src/index.ts`'s full barrel — which re-exports `./auth-session.js`, a TypeScript-style
`.js` specifier plain Node cannot resolve — and the config load crashes before the app or test
suite ever starts. `JARVIS_API_PROXY_TARGET` (read only in `apps/web/vite.config.ts`) and
`JARVIS_UAT_BASE_URL` (read only in `tests/uat/playwright.uat.config.ts`, outside its 20 bare
`process.env` reads in `tests/uat/specs/*.uat.spec.ts` — see "Also deliberately unfixed" below) are
both carved out for this reason. `playwright.config.ts` at the repo root does not read any
`JARVIS_*` name and was not touched.

This carve-out reason was missing from the original enumeration, which was built only from
`infra/*.yml` and `scripts/*.sh` — build-time config files were never in that enumeration set. Any
future config file added under this same loading pattern (plain `node`, before the module graph
exists) should be checked against this category before wiring it through `resolveMossEnv`.

## Count reconciliation

- Issue #1443 claims **197** distinct names.
- A naive `grep -roh 'JARVIS_[A-Z0-9_]+'` against `main` finds **167**.
- Neither figure is the real count. Grepping for the bare pattern over-counts: template-literal
  prefixes like `` `JARVIS_RL_${key}` `` match as the fragment `JARVIS_RL_`; local identifiers like
  `JARVIS_TOOL_PREFIX` (a hardcoded MCP tool-name prefix string, not an env var) and
  `JARVIS_VERSION_RE` (a regex variable) match the same pattern as real config knobs; and
  historical doc/plan files under `docs/` reference names that were renamed or removed long ago.
- The verified figure, built by classifying every match per the method above: **117 real,
  distinct `JARVIS_*` environment variable names**, made up of:
  - **45 carved out** (table below) — `grep -c '^  "JARVIS_' packages/db/src/env.ts`
  - **65 shimmed** (wrapped in `resolveMossEnv` at their production read site) — the 68 names
    returned by the command below, minus the three non-variables itemised under it
  - **7 in the deliberately-deferred gap** (below)

  ```bash
  # the 68 raw hits; subtract JARVIS_FOO, JARVIS_CLI_RUNNER_SOCKET, JARVIS_PGDATABASE => 65
  grep -rhon 'resolveMossEnv([^)]*"JARVIS_[A-Z0-9_]*"' \
    --include=*.ts --include=*.tsx --include=*.mjs packages apps scripts tests infra \
    | grep -o 'JARVIS_[A-Z0-9_]*' | sort -u

  # cross-check that no host-interpolated compose name is missing from CARVE_OUT (expect: empty)
  comm -23 \
    <(grep -rho '\${JARVIS_[A-Z0-9_]*' infra --include=*.yml | grep -o 'JARVIS_[A-Z0-9_]*' | sort -u) \
    <(grep -o '"JARVIS_[A-Z0-9_]*"' packages/db/src/env.ts | tr -d '"' | sort -u)
  ```

- The shimmed figure needs one correction that an earlier revision of this document got wrong. Its
  stated method — "extract every literal second argument to `resolveMossEnv(...)` across `**/*.ts`"
  — yields **68** names, but three of those are not shimmed variables, so 45 + 68 + 7 = 120
  double-counted. `resolveMossEnv` is a _passthrough_ for carved-out names, so appearing as an
  argument to it does not prove a name is shimmed. The three:
  - `JARVIS_FOO` — a placeholder inside the doc comment on `packages/db/src/env.ts`, not a variable.
  - `JARVIS_CLI_RUNNER_SOCKET` — carved out; the only hit is
    `packages/db/src/__tests__/env.test.ts`, which passes it deliberately to assert the carve-out
    passthrough behaves as a no-op.
  - `JARVIS_PGDATABASE` — carved out; `packages/db/src/urls.ts` calls through the shim for symmetry
    with the `JARVIS_PGHOST`/`JARVIS_PGPORT` reads beside it. The call resolves to
    `env.JARVIS_PGDATABASE` unchanged, and the comment there says so.
- Both remaining passthrough call sites are correct as written and were left in place: the behavior
  is identical either way, and the carve-out membership — not the call site — is what holds the
  name still. The risk they carry is that removing a name from `CARVE_OUT` silently activates the
  shim at a site that looks like it was always shimmed, which is why this table is the source of
  truth and `env.ts` points at it.
- `__JARVIS_MODULE_RUNTIME__` is excluded entirely — it is a `window`/`globalThis` property set by
  the module runtime host, never a `process.env` name, despite matching the grep pattern.

## Carve-out (45 names)

Read by Docker Compose host-side interpolation, a named shell script, a build-time config file
outside the module graph, or some combination. `resolveMossEnv` passes these straight through with
no `MOSS_` lookup and no warning.

| Variable                         | Carved out because                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `JARVIS_ALLOW_STALE`             | `scripts/check-tree-fresh.sh` reads `${JARVIS_ALLOW_STALE:-}` directly                                                                                                                                                                                                                                                               |
| `JARVIS_API_PORT`                | compose interpolation (`infra/docker-compose.prod.yml`)                                                                                                                                                                                                                                                                              |
| `JARVIS_API_PROXY_TARGET`        | build-time config file — `apps/web/vite.config.ts` reads it at Vite config-load time, plain Node, outside the app module graph; also mentioned (literal-value, non-interpolated) in `infra/docker-compose.yml`                                                                                                                       |
| `JARVIS_BACKUP_DAILY_KEEP`       | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_BACKUP_DIR`              | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_BACKUP_OFFHOST_CMD`      | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_BACKUP_PG_CONTAINER`     | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_BACKUP_WEEKLY_KEEP`      | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_CLI_PER_USER_UID`        | must be both-set-or-both-unset with the RPC secret pair below; also compose                                                                                                                                                                                                                                                          |
| `JARVIS_CLI_RUNNER_RPC_SECRET`   | compose `:?`-required interpolation; must stay in lockstep with `JARVIS_CLI_RUNNER_SOCKET` (both-set-or-both-unset trap)                                                                                                                                                                                                             |
| `JARVIS_CLI_RUNNER_SINGLE_USER`  | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_CLI_RUNNER_SOCKET`       | compose interpolation; lockstep pair with the RPC secret                                                                                                                                                                                                                                                                             |
| `JARVIS_CLI_TOOLS_PREFIX`        | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_DEV_EMAIL`               | `scripts/redeploy-external-module.sh`                                                                                                                                                                                                                                                                                                |
| `JARVIS_DEV_PASSWORD`            | `scripts/redeploy-external-module.sh`                                                                                                                                                                                                                                                                                                |
| `JARVIS_DOCKER_SUBNET`           | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_EMBED_MODEL`             | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_EMBED_PROVIDER`          | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_ENV_FILE`                | compose `--env-file` selection, host-side only                                                                                                                                                                                                                                                                                       |
| `JARVIS_ENV_FILE_ABS`            | derived host-side sibling of `JARVIS_ENV_FILE`                                                                                                                                                                                                                                                                                       |
| `JARVIS_GATE_DIR`                | `scripts/run-gate.sh`                                                                                                                                                                                                                                                                                                                |
| `JARVIS_GATE_STALE_SECS`         | `scripts/run-gate.sh`                                                                                                                                                                                                                                                                                                                |
| `JARVIS_HOST_GID`                | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_HOST_UID`                | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_IMAGE_TAG`               | compose `:?`-required interpolation                                                                                                                                                                                                                                                                                                  |
| `JARVIS_MCP_SERVER_URL`          | compose interpolation                                                                                                                                                                                                                                                                                                                |
| `JARVIS_NOTES_VAULT_HOST_PATH`   | compose `:?`-required interpolation (`docker-compose.notes.yml`); also read plainly in `scripts/setup-prod.ts`                                                                                                                                                                                                                       |
| `JARVIS_PG_CONTAINER`            | `scripts/run-gate.sh`                                                                                                                                                                                                                                                                                                                |
| `JARVIS_PGDATABASE`              | `scripts/run-gate.sh`, `scripts/verify-reboot-survival.sh`                                                                                                                                                                                                                                                                           |
| `JARVIS_SMOKE_APP_CONTAINER`     | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_BASE_URL`          | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_DB_CONTAINER`      | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_DB_NAME`           | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_SURFACE`           | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_TIMEOUT_MS`        | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_SMOKE_USER_EMAIL`        | `scripts/smoke-chat-prod.sh`                                                                                                                                                                                                                                                                                                         |
| `JARVIS_TLS_HOST`                | host-side interpolation in `infra/docker-compose.prod.yml` and read directly in `scripts/setup-prod.ts` / the Caddyfile (`{$JARVIS_TLS_HOST}`)                                                                                                                                                                                       |
| `JARVIS_TLS_ISSUER`              | host-side interpolation in `infra/docker-compose.prod.yml` and read directly in `scripts/setup-prod.ts` / the Caddyfile (`{$JARVIS_TLS_ISSUER:internal}`)                                                                                                                                                                            |
| `JARVIS_UAT_BASE_URL`            | build-time config file — `tests/uat/playwright.uat.config.ts` reads it at Playwright config-load time, plain Node, outside the app module graph. (The 20 bare `process.env.JARVIS_UAT_BASE_URL` reads in `tests/uat/specs/*.uat.spec.ts` are a separate, already-documented deliberate gap — see "Also deliberately unfixed" below.) |
| `JARVIS_UAT_REAL_CHAT_ENV_FILE`  | compose `seed` service env_file selection, host-side only                                                                                                                                                                                                                                                                            |
| `JARVIS_UAT_SEED_CONFIRM`        | `packages/module-registry/src/index.ts` reads it directly as a second-intent confirmation gate for the UAT news-preview override (already commented there as a Tier C carve-out); also compose-interpolated in `infra/docker-compose.prod.yml`                                                                                       |
| `JARVIS_UAT_SEED_EXCLUDE_CHUNKS` | compose `seed` service env, consumed only inside the container before Node's `MOSS_`-aware code would run                                                                                                                                                                                                                            |
| `JARVIS_UAT_SEED_LEVEL`          | same as above                                                                                                                                                                                                                                                                                                                        |
| `JARVIS_VAULT_DIR`               | `scripts/backup-full.sh`                                                                                                                                                                                                                                                                                                             |
| `JARVIS_WEB_PORT`                | host-side interpolation in the published port binding, `- "${JARVIS_WEB_PORT:-1533}:3000"`; also read in TypeScript — the worked example of the dual-consumption rule above                                                                                                                                                          |

## Deliberately deferred (7 names — documented gap, not silently dropped)

These are real `JARVIS_*` config reads that the TypeScript shim cannot reach because the code that
reads them runs outside the module graph entirely — not via `import`, but as a standalone script
written to disk or copied into a container and invoked with a bare `node`. Where the same name is
also read at a normal, reachable call site, that call site **is** shimmed; only the isolated copy
is not.

- **`packages/chat/src/live/claude-permission-hook.ts`** builds a permission-hook script as a
  template-literal JS string, writes it to disk, and it runs as its own Node subprocess — it never
  goes through the module graph `@moss/db` lives in. Reads, unshimmed in that generated script:
  `JARVIS_PERM_DEADLINE_S`, `JARVIS_PERM_TOKEN_FILE`, `JARVIS_PERM_URL`, `JARVIS_SESSION_ROOT`.
  (`JARVIS_NOTES_ROOTS` is also read there, but is not counted again here — it's already covered by
  the shimmed call sites in `packages/chat/src/live/vault-allowlist.ts` and
  `packages/settings/src/notes-source-routes.ts`.)
- **`scripts/smoke-chat.mjs`** is `docker cp`'d into a running prod container by
  `scripts/smoke-chat-prod.sh` and run via a bare `node /tmp/smoke-chat.mjs` — no `node_modules`,
  no `@moss/db`, by design (it has to run inside the target container image as-is). Of the names it
  reads, `JARVIS_SMOKE_BASE_URL`, `JARVIS_SMOKE_SURFACE`, and `JARVIS_SMOKE_TIMEOUT_MS` are already
  carved out (the wrapping shell script reads them too). `JARVIS_SMOKE_TOKEN` and
  `JARVIS_SMOKE_PROMPT` are read only inside the `.mjs` file itself (passed through via `docker exec
-e`, never read by the shell script directly) — genuinely outside both the carve-out rule and the
  shim's reach.
- **`JARVIS_MCP_TOKEN`** is not a config value at all in the sense the shim handles — it's a fixed
  environment-variable _name_, hardcoded as a string constant
  (`packages/chat/src/live/cli-launch-commands.ts:116`, `packages/chat/src/live/codex-exec-session.ts:128`)
  that our code writes into a spawned CLI subprocess's environment so the subprocess's MCP client
  can read its own bearer token back out. Nothing in this repository ever does
  `process.env.JARVIS_MCP_TOKEN` — it is generated per-session and only ever appears as a write-side
  literal and in redaction patterns (`packages/ai/src/adapters/redact.ts`). Renaming the literal
  string would be cosmetic only; deferred as out of scope for the same reason.

None of these seven carries a deployment-config concern: the four permission-hook variables and the
two smoke-chat ones are process-internal plumbing regenerated fresh on every hook run or smoke run,
never read from `infra/env.production.local`, and `JARVIS_MCP_TOKEN` is a name, not a value.

## Also deliberately unfixed: UAT spec-file direct reads

Twenty `tests/uat/specs/*.uat.spec.ts` files read `process.env.JARVIS_UAT_BASE_URL` and/or
`process.env.JARVIS_UAT_PROJECT_NAME` directly, in addition to `tests/uat/playwright.uat.config.ts`,
which also reads `process.env.JARVIS_UAT_BASE_URL` plainly — **not** via `resolveMossEnv`.
`JARVIS_UAT_BASE_URL` is a carve-out (build-time config file, see above), not a shimmed name; an
earlier revision of this document wired `playwright.uat.config.ts` through `resolveMossEnv`, which
pulls `@moss/db`'s server-side barrel into Playwright's plain-Node config-load step the same way it
broke `apps/web/vite.config.ts`'s Docker build, so that call site was reverted to a bare read.
`JARVIS_UAT_PROJECT_NAME` is not shimmed anywhere either — it's only ever set in
`tests/uat/run-uat.ts` and read directly in the spec files. Neither name is a coverage gap: both are
process-internal plumbing generated fresh by `tests/uat/provisioner.ts` in the same process tree
that spawns Playwright for that one ephemeral run, never set by a human or read from any deployment
env file. The twenty spec-file call sites are left as bare reads on purpose — wrapping twenty
near-identical internal test-plumbing call sites would be exactly the "scattered fallback logic at
every call site" anti-pattern the shim design explicitly rejects, and there is no reachable seam left
to centralize at now that the config file itself is carved out. If this file set grows significantly, revisit
by threading the config's already-resolved `baseURL` through instead of re-reading `process.env`.
