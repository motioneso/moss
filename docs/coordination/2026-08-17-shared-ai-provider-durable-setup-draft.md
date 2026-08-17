# Durable AI-provider setup for the shared dev instance — pre-spec working draft

**Status: PRE-SPEC DRAFT. Not approved, not buildable.**
This is a working draft only. Per `CLAUDE.md` → Process gates ("Spec before build"), before anyone
writes code this must become a numbered entry in `docs/superpowers/specs/` and be built against a
GitHub `task` issue. **Issue #1258 already exists and is the right home** (see §7) — this draft is
the design input for it, not a new issue.

Date: 2026-08-17 · Author: investigation agent · Repo: `~/Jarv1s`

---

## 0. The complaint

The shared persistent dev instance periodically has zero rows in `app.ai_provider_configs`, so no
chat-capable model resolves and every chat turn fails `needs-config`. That blocks the live-path gate
for any chat-touching PR (current casualties: PR #1649 / #1650). Ben has fixed it by hand "multiple
times". Nothing makes the fix survive.

---

## 1. Root cause — measured, not assumed

The provider config is not being selectively deleted. **The entire dev database is being destroyed
and rebuilt empty**, and nothing re-provisions it afterwards.

Forensic evidence collected 2026-08-17 against the live dev DB (read-only queries):

| Observation | Value |
|---|---|
| `select count(*) from app.ai_provider_configs` | **0** |
| `select count(*) from app.ai_configured_models` | **0** |
| `select count(*) from app.users` | **0** |
| `app.schema_migrations` row count | 175 |
| `min(applied_at)` / `max(applied_at)` | `2026-08-13 00:58:41Z` / `2026-08-13 00:58:43Z` (**1.3 s apart**) |
| Docker volume `infra_jarv1s-postgres-data` `CreatedAt` | **2026-08-12T14:10:09-07:00** (= `2026-08-12 21:10Z`) |
| Host dev processes (`dev:api` / `dev:web` / `dev:worker`) | **none running** |

Reading that: the volume was **deleted and recreated** on 2026-08-12, then ~3h45m later all 175
migrations were applied to a virgin database in a single 1.3-second batch. Zero users means zero
provider configs by FK cascade (`ai_provider_configs.owner_user_id → app.users(id) ON DELETE
CASCADE`) — but here there was never a user to cascade from. The instance is currently *entirely
unprovisioned*, not merely missing a credential.

### 1.1 What deletes the volume

`package.json:29`:

```
"db:down": "docker compose -f infra/docker-compose.yml down -v"
```

`-v` destroys the named volume `jarv1s-postgres-data` (`infra/docker-compose.yml`), which is the
shared dev database. `pnpm db:down && pnpm db:up && pnpm db:migrate` therefore yields exactly the
state measured above.

### 1.2 Why it keeps happening — this is the important part

`pnpm db:down && pnpm db:up` is **actively recommended, in the repo, as the normal remedy** for
several routine situations. Grep hits across `docs/`:

- `docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md:53` — "if you must reset,
  `pnpm db:down && pnpm db:up`"; and again at line 420 as a literal run command.
- `docs/superpowers/plans/2026-06-07-slice-3-memory-index.md:11` — "required after the
  docker-compose image change".
- `docs/archive/HANDOFF-memory-foundation.md:96` — the prescribed fix for a **migration checksum
  mismatch**, which is a recurring event by design (`CLAUDE.md`: "Never edit an applied migration").
- `docs/coordination/2026-06-13-phase2-5-test-plan.md:49` — the documented way to "get another clean
  slate (re-fire onboarding)".
- `docs/superpowers/handoffs/2026-06-18-onboarding-service-testing-webwright.md:146` — bare
  `pnpm db:down`.

So an agent hitting a checksum mismatch or wanting a clean onboarding run follows repo documentation,
nukes the shared volume, re-migrates, and walks away. **The wipe is a sanctioned workflow with no
re-provision step.** That is why it recurs and why a one-off manual fix never survives — there is no
bug to fix, there is a missing half of a procedure.

Exactly one doc pushes back — `docs/coordination/2026-06-13-overnight-phase2-5-log.md:119`: "NEVER
`pnpm db:down` (shared Postgres)" — and it is a one-line aside in a 2026-06-13 coordination log that
nothing links to.

A second, independent sweep found the discriminator that rules out every *user-deletion* path:
`data/vaults/6dc52034-a0ee-4944-9bfc-ef477af4370b/` still exists on disk (last written 2026-08-04)
with **no matching `app.users` row**. Every application-level deletion path removes the vault
directory after the DB commit (`scripts/delete-user-data.ts:230` → `deleteUserVaultDir`). Filesystem
survived, database did not ⇒ the DB was destroyed *underneath* the app. Not `deleteUserData`, not
account self-deletion, not admin removal. (That orphan vault is now unreferenced data and should be
cleaned up as a side task.)

### 1.3 Candidates ruled OUT (do not re-diagnose these)

- **Integration tests.** Two suites `TRUNCATE` this exact table in `beforeEach` on the bootstrap
  superuser connection — `tests/integration/ai-auto-register.test.ts:450` and
  `tests/integration/ai-voice-endpoint.test.ts:77` — and `tests/integration/test-database.ts:120`
  does `DROP SCHEMA app CASCADE`. Alarming, but fenced: `resetFoundationDatabase()` calls
  `assertIsolatedTestDatabase()` (`tests/integration/test-database.ts:49`), which throws if the
  target database is named `jarv1s`, and it runs in `beforeAll` — so both suites abort before
  `beforeEach` is ever reached. That guard was added for #854, for precisely this failure. It holds.
  Decisively, none of these recreate the Docker volume, which is what the forensics show happened.
- **The UAT harness.** `tests/uat/seed/guard.ts` → `assertTargetIsEphemeral()` (#1082) refuses any
  target whose `app.users` contains a non-fixture identity, on top of the `JARVIS_UAT_SEED_CONFIRM=1`
  gate (#1025). UAT runs use their own compose project and their own DB; teardown `down -v` is scoped
  to that project. Not the culprit.
- **The gate.** `scripts/run-gate.sh` and `scripts/test-integration.ts` `CREATE`/`DROP` a
  per-run gate database and never touch `jarv1s`.
- **Migrations.** No migration deletes provider rows. `packages/ai/sql/0173` even documents that
  `jarvis_migration_owner` is `NOBYPASSRLS` so migration-time DML silently matches zero rows.
- **`scripts/delete-user-data.ts`** (`app.ai_provider_configs` / `owner_user_id = $1`) is explicit
  and per-user; nothing suggests it ran.

### 1.4 A second, quieter failure mode worth designing against

Even when rows *do* exist they can be silently unusable:

- **Key mismatch.** `encrypted_credential` is AES-256-GCM under a key derived from
  `MOSS_/JARVIS_AI_SECRET_KEY` (`packages/db/src/keyring.ts`). If that env var is unset, the key
  silently derives from the literal `"jarv1s-development-ai-secret"`. A row written by a seeder with
  a different key/`NODE_ENV` than the API decrypts to a GCM auth-tag failure, not a clear error.
  `NODE_ENV` must stay **unset** on host-dev.
- **Ambiguous default.** `AiRepository.resolveDefaultProviderId` returns `null` when zero *or ≥2*
  active admin-owned `purpose='assistant'` providers exist and none carries `is_instance_default`.
  This is the exact 2026-07-25 incident recorded in issue #1258 — 90 minutes misdiagnosed as a
  job-search regression.

Any durable design must treat "0 rows", "wrong key", and "2 rows, no default" as the same class of
defect, because they present identically to the operator.

### 1.5 Adjacent hazards found while investigating (not this wipe, but next time's)

These are separate from the design below and should be filed as their own small issues. They are the
reason a re-provision step alone is necessary but not sufficient.

- **`pnpm smoke:compose` is not project-scoped on the dev branch.** `scripts/smoke-compose.ts:35-37`
  passes `-p jarv1s-prod-smoke` only when `isProd`; the dev branch is bare `compose -f <file>`, so it
  derives project `infra` and operates `up -d postgres api web worker` + `run --rm migrate` **against
  the live shared dev stack**. It has no teardown of its own, so the natural next step is the CI
  recipe — `docker compose -f infra/docker-compose.yml down -v`. Add `-p` to the dev branch.
- **`assertIsolatedTestDatabase` matches on database *name only*** (`tests/integration/test-database.ts:49`)
  — no host or port check, and anything not literally named `jarv1s` passes. `package.json:70` already
  ships a survivor: `"test:commitments": "JARVIS_PGDATABASE=jarvis_build_537 vitest run …"` — raw
  `vitest`, bypassing the isolation wrapper, with an **inline** assignment, which is the exact
  anti-pattern `scripts/run-gate.sh:75-77` warns about ("an inline assignment does not survive
  backgrounding, and a gate that loses it lands on the live `jarv1s` database. That took chat down for
  90 minutes once"). Harden the guard to an allowlist prefix plus a host/port check.
- **`scripts/test-integration.ts:19-24` silently switches to `passthrough`** when `JARVIS_PGDATABASE`
  is set, with no validation of what it points at.
- **`pnpm db:down` has no confirmation and no hook.** `.claude/hooks/` contains only
  `check-gate-pipe.sh`; nothing guards volume destruction. A `PreToolUse` hook blocking `down -v`
  against `infra/docker-compose.yml` is one option — **this is a settings/config change and is Ben's
  call to make, not an agent's**; recorded here as an option, deliberately not applied.

---

## 2. What "a chat-capable provider" actually requires

Grounded in `packages/ai/src/repository.ts`, `packages/ai/src/auto-register.ts`, and
`packages/ai/sql/*`. There are **two disjoint halves**, and the existing manual fix only ever
reliably does one of them.

**DB half** — all of:

1. An **active instance admin** user exists and is the actor. The RLS INSERT policy on
   `app.ai_provider_configs` is `WITH CHECK app.current_actor_is_admin()`; cross-user and worker
   readability additionally require the *owner* to be an active admin.
2. Writes go through `DataContextRunner.withDataContext({ actorUserId, requestId }, ...)` — the
   `DataContextDb` brand rejects a raw Kysely handle at compile time.
3. `AiRepository.createProvider({ providerKind, displayName, status: "active", authMethod, encryptedCredential })`
   — `purpose` defaults `'assistant'`, `execution_mode` defaults `'non_interactive'`.
4. `AiRepository.createModel({ providerConfigId, providerModelId: "default", capabilities: ["chat"], status: "active", tier: "interactive" })`.
   The router's unit is a **model** row, never the provider row.
5. `AiRepository.setInstanceDefaultProvider(id)` — or a provable guarantee of exactly one active
   admin-owned assistant provider.

**File half** — for `authMethod: "cli"` (the OAuth path the existing gpg file holds), the actual
credential is a plaintext file at `<homeBase>/.jarvis/cli-tokens/anthropic`, written by
`persistProviderToken` (`packages/cli-runner/src/provider-token-store.ts`; mode 0600 under a 0700
dir, atomic tmp+rename). **The DB row for a CLI provider carries only the sealed sentinel
`{ cli: true }` — it contains no token.** A cli-runner process must be running and must see that
homeBase, or the row resolves but every turn 503s.

`AiAutoRegisterService.ensureDefaultChatModel` (`packages/ai/src/auto-register.ts:118`) already
performs the whole DB half, idempotently, and is the only production path that creates a
chat-capable row. It is driven by the login-service `needs_login → ready` transition
(`packages/module-registry/src/onboarding-login.ts:127`, best-effort inside a try/catch).

---

## 3. Recommended mechanism

### 3.1 Shape: a reconciler command, not a migration hook, not a cron

**Recommendation: extend issue #1258's `pnpm dev:instance` CLI with a `provision` subcommand, and
make it the mandatory second half of the documented reset procedure.**

Rejected alternatives for the trigger:

- **Migration-time hook — no.** Migrations run under `jarvis_migration_owner`, which is
  `NOBYPASSRLS`; `packages/ai/sql/0173` had to disable RLS mid-migration to touch data at all.
  Seeding a credential from a migration would mean either an RLS carve-out or a `BYPASSRLS` role —
  both violate `CLAUDE.md` hard invariants. It would also embed a dev credential path in the
  production migration chain. Hard no.
- **Scheduled reconciler (cron/systemd timer polling the DB) — no.** It would need standing decrypt
  access to the gpg material to be autonomous, which turns a hand-unlocked secret into an always-hot
  one for a *dev convenience* benefit. Bad trade. Also `CLAUDE.md`/box rules: long-lived loops belong
  in code only when the loop is load-bearing; here the triggering event is a human action.
- **Bake into the docker image — no.** Secrets-never-escape; the image is pushed to ghcr.

The event that wipes the DB is a **human/agent running a documented command**. So the correct trigger
is to make that command's documented form include re-provisioning. Concretely:

```
"db:reset": "pnpm db:down && pnpm db:up && pnpm db:migrate && pnpm dev:instance provision"
```

…and update every doc found in §1.2 to point at `pnpm db:reset` instead of raw `db:down`. The raw
`db:down` stays (CI uses it at `.github/workflows/ci.yml:142,177`) but stops being the documented
dev remedy.

Two companion changes belong in the same PR, because a re-provision step that can still be bypassed
is not durable: the doc rewrites from §1.2, and the `-p` scoping fix on `scripts/smoke-compose.ts`
from §1.5. The `assertIsolatedTestDatabase` hardening and the hook question can be separate issues.

### 3.2 What `dev:instance provision` does — idempotent, in order

Each step is a no-op if already satisfied. Safe to run any number of times.

1. **Refuse production.** Hard fail unless the target DB is the dev one. Mirror the existing
   `assertIsolatedTestDatabase` / `assertTargetIsEphemeral` pattern — an allowlist on database name +
   port, never a denylist.
2. **Ensure the dev instance admin exists.** If `app.users` is empty, drive the real bootstrap-owner
   signup path (`GET /api/bootstrap/status` → the normal signup route) rather than inserting a user
   row. Password comes from the host secret file, never argv.
3. **Ensure the provider + model rows.** Call the *existing*
   `AiAutoRegisterService.ensureDefaultChatModel(scopedDb, providerKind)` under
   `withDataContext({ actorUserId: adminId })`. Do not write a parallel insert path — that function
   is already idempotent (provider reuse by kind, model existence check across any status, INSERT-only,
   `ON CONFLICT DO NOTHING`, and a guarded `setInstanceDefaultProvider`). The provider kind comes from
   config, not a hardcoded literal — see §5 on provider-agnosticism.
4. **Ensure the file half.** Decrypt the host gpg file to a mode-0600 temp env file, source it, call
   `persistProviderToken(homeBase, provider, token)`, shred the temp file in a `finally`. This is the
   same contract #1121 approved — reused, not reinvented.
5. **Run `doctor` and exit non-zero on any residual defect** (the read-only half already specified in
   #1258: exactly one `is_instance_default`, chat capability resolves to a live model, no UAT fixture
   rows, migrations current, admin active). Doctor is the acceptance evidence.

### 3.3 How the token gets from gpg into place without touching agent context

The token must never appear in argv, stdout, a log line, an agent transcript, or git. Shape:

```bash
# run by Ben or by an agent; neither ever sees the plaintext
umask 077
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
gpg --quiet --batch --decrypt ~/.config/moss/uat/anthropic-oauth.env.gpg > "$tmp/provider.env"
set -a; . "$tmp/provider.env"; set +a      # exports CLAUDE_CODE_OAUTH_TOKEN
pnpm dev:instance provision                 # reads it from the environment only
```

Properties that make this safe:

- The plaintext exists only inside a `mktemp -d` directory under `umask 077`, removed by an `EXIT`
  trap.
- The value is passed by **environment variable, never argv** (argv is world-readable in `/proc`).
- The CLI must never echo the variable. It may print `token: present` / `token: absent` only.
- The decrypt is interactive (gpg passphrase / agent), so an agent running this cannot silently
  exfiltrate — and an agent that runs it still never receives the plaintext into its context,
  because nothing prints it.
- `~/.config/moss/uat/anthropic-oauth.env.gpg` (2026-08-12) is the current file.
  `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (2026-07-20, old project name) should be
  confirmed stale and deleted as part of this work.

The pre-existing `maybePersistRealChatToken(homeBase)` in `tests/uat/seed/cli.ts` already reads
`CLAUDE_CODE_OAUTH_TOKEN` from env and calls `persistProviderToken` — the persistent path should use
the same env-var contract so there is one convention, while remaining a **separate entry point** (§4).

### 3.4 Env-parity requirement

`dev:instance provision` MUST run with the same `MOSS_/JARVIS_AI_SECRET_KEY`, `JARVIS_AI_SECRET_KEY_ID`
and **unset `NODE_ENV`** as the dev API and worker, or the credential envelope it writes will not
decrypt at read time (§1.4). The CLI should assert parity where it can — e.g. refuse to run with
`NODE_ENV` set — and `doctor` should verify by round-tripping a decrypt of the row it just wrote.
This assertion is a first-class requirement, not a footnote; it is the difference between "seeded"
and "seeded and actually usable".

---

## 4. Keeping the two lifecycles separate

The #1121 ephemeral path and this persistent path stay **separate entry points** and must not be
collapsed. They differ on every axis that matters:

| | #1121 ephemeral UAT | This: persistent shared dev |
|---|---|---|
| Lifetime of credential | one run, minutes | until rotated |
| DB | per-run, thrown away (`down -v`) | the shared `jarv1s` DB |
| Guard | `assertTargetIsEphemeral` — *refuses* a DB with real users | must *require* a real admin user |
| Blast radius of a mistake | zero | wipes/poisons everyone's dev instance |
| Trigger | every UAT run, automatic | a human reset, rare |
| Failure posture | fail closed, refuse to start | fail loud, report via `doctor` |

The two guards are **logical inverses** — `assertTargetIsEphemeral` throws precisely when a real user
exists, which is the state `provision` requires. Merging them would mean deleting one of the two
fences that currently prevent a UAT seed from writing a loginable owner into a real instance (#1082).
**Do not.** They may share the token-reading convention (`CLAUDE_CODE_OAUTH_TOKEN` from env →
`persistProviderToken`) and nothing else.

---

## 5. Provider-agnosticism

`CLAUDE.md` forbids hardcoding a provider or model into app logic. This design complies because:

- The router is untouched. `resolveModelForCapability` keeps picking by capability + tier.
- `ensureDefaultChatModel` already takes `providerKind` as a parameter; its `DEFAULT_CHAT_MODELS` map
  is existing shipped data, not new hardcoding, and the sentinel `providerModelId: "default"` means
  no model name is pinned.
- The provisioner takes the provider kind and the secret-file path from **config** (a dev config file
  or env), so pointing the dev instance at a different provider is a config edit, not a code change.

The fact that today's secret happens to be Anthropic is an operator fact, not a code fact. The spec
should state that explicitly so nobody "simplifies" it into an `if (provider === "anthropic")`.

---

## 6. Risk tier: **security** — confirmed

Arguments for, all independently sufficient:

1. It handles a **live long-lived credential** for a real (test/service) Anthropic account and writes
   it to disk. Mishandling leaks a spendable token.
2. It writes an **AES-256-GCM-encrypted credential row** and depends on key/env parity — a subtle
   mistake here produces the silent decryption failure class in §1.4.
3. It requires **instance-admin privileges** to satisfy the RLS INSERT policy, so the code path runs
   with the highest in-app authority. Any bug in its target-selection guard is an
   admin-privileged write against the wrong database.
4. It sits adjacent to two existing security fences (#1082 `assertTargetIsEphemeral`, #854
   `assertIsolatedTestDatabase`). Work near a fence is where fences get weakened.
5. It creates a **bootstrap owner** — the highest-privilege identity on the instance.

The only counter-argument is "it's dev-only tooling, never shipped in the api/worker bundle"
(#1258's own constraint). That lowers *production* blast radius but not the credential-handling or
admin-write risk, and "dev-only" is exactly the assumption that makes a prod-guard regression fatal.
**Classify security tier.** Practically that means: Opus adversarial QA pass, and the target-refusal
guard gets its own red-first test (the way `tests/unit/test-database-guard.test.ts` and
`tests/uat/seed/guard.test.ts` cover the existing two).

---

## 7. Why not the simpler alternatives

- **"Just have Ben re-paste it each time."** This is the status quo and it is what failed. It has
  failed at least twice with the current gpg file alone (created 2026-08-12 09:38, dev DB destroyed
  2026-08-12 14:10). It also fails silently and asynchronously — nobody discovers it until a live-path
  gate blocks a PR hours or days later, which is how #1649/#1650 got stuck.
- **"Stop people running `pnpm db:down`."** A rule cannot beat a dozen repo docs that recommend it
  (§1.2), and the wipe is sometimes genuinely necessary (checksum mismatch). The fix is to make reset
  and re-provision one operation, not to forbid reset.
- **"Bake the token into the dev docker image / commit an encrypted blob."** Violates
  secrets-never-escape; images are pushed to ghcr; and a committed blob's decryption key has to live
  somewhere anyway. Also solves nothing — the dev app runs from source on the host, not from an image.
- **"Add it to the migration chain / seed SQL."** RLS + `NOBYPASSRLS` migration role makes it
  structurally awkward (§3.1), and it would put a credential path in the production migration
  sequence that every real install runs.
- **"Reuse the #1121 UAT seeder against the dev DB."** Its `assertTargetIsEphemeral` guard exists
  specifically to refuse this, for a security reason (#1082). Removing the guard to reuse the code
  trades a real fence for a small amount of code reuse. See §4.
- **"Make the dev instance non-persistent — spin it up fresh per session."** Defensible, and worth
  Ben's consideration, but it is a much larger change (LAN URL stability, Ben's own login, connector
  OAuth state, vault contents) and it does not remove the need for an idempotent provision step —
  it makes that step run *more* often.

---

## 8. Open questions for Ben (must be answered before this becomes a spec)

1. **Does the persistent dev instance get a cli-runner?** The current gpg file holds a
   `CLAUDE_CODE_OAUTH_TOKEN`, which is the `authMethod: "cli"` path — it needs a running cli-runner
   process, and there is none on host-dev today (`docker ps` shows only the *prod* cli-runner). With
   no cli-runner, a seeded CLI provider row resolves but every chat turn 503s, and the live-path gate
   is still blocked. Two ways out: **(a)** run a dev cli-runner alongside `dev:api`, or **(b)** seed
   an `authMethod: "api_key"` HTTP provider instead, which needs a plain **API key** in the gpg file
   rather than an OAuth token. Option (b) is simpler and has no extra process, but changes which
   engine the dev instance exercises — and if the PRs being unblocked exercise the CLI engine, (b)
   proves the wrong thing. **This is the one question that decides the shape of the build.**
2. **Is `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (2026-07-20, old project name) stale and
   safe to delete?** Recommend yes, superseded by the `moss` one.
3. **Should the dev bootstrap-owner password also come from a host secret file** so `provision` can
   recreate Ben's dev login unattended, or does Ben want to re-signup by hand each reset?
4. **Scope check on #1258.** It already asks for `doctor` / `fix` / `providers` / `reset`. Should
   this land as the `provision` subcommand inside #1258, or should #1258 be split so the durable
   provisioning half ships first? Recommend: one issue, but sequence `doctor` first — it is read-only,
   it is the highest-value half, and it converts every future occurrence from a 90-minute
   misdiagnosis into a one-command answer.

---

## 9. Suggested acceptance evidence (for the eventual spec)

1. `pnpm db:reset` from the current empty state yields a dev instance where `doctor` exits 0.
2. Running `provision` twice in a row is a clean no-op the second time (idempotence, asserted).
3. `provision` refuses a production connection string — red-first test alongside the existing two
   guard suites.
4. Nothing in `provision`'s stdout/stderr, nor any log line, contains the token — asserted by test,
   not by inspection.
5. A round-trip decrypt of the written row succeeds **under the API's own env**, proving §3.4 parity.
6. Live-path proof: a real chat turn completes through the browser on the dev instance after a
   `db:reset`, recorded per the live-path gate.
