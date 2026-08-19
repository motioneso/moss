# Dev-Instance Provisioning CLI — doctor + seed AI providers on a persistent dev DB

Status: Draft (awaiting review)
Date: 2026-08-19
Owner: Ben
Issue: #1258
Risk tier: **security** (handles a real spendable credential; requires instance-admin-level DB writes)

## Context

The shared, persistent dev instance (source-run from `~/Jarv1s`, LAN URL, `jarv1s-postgres` DB)
periodically loses its AI provider configuration entirely — not a stale credential, the **whole
database gets destroyed and rebuilt empty**. `pnpm db:down && pnpm db:up` (`docker compose down -v`)
is documented, in multiple places in this repo, as the normal remedy for routine situations
(migration checksum mismatches, wanting a clean onboarding run). Nothing re-provisions the instance
afterward. Every chat-touching PR then fails the live-path gate with "no active chat-capable model
configured," which reads identically to an application bug and has cost up to 90 minutes of
misdiagnosis in the past (2026-07-25 incident, recorded in #1258). Ben has fixed this by hand
multiple times; a one-off manual fix cannot survive because the underlying wipe is a sanctioned,
frequently-run workflow.

A second, independent design draft (`docs/coordination/2026-08-17-shared-ai-provider-durable-setup-draft.md`)
investigated this on the live instance, confirmed the root cause forensically (empty
`app.ai_provider_configs`/`app.ai_configured_models`/`app.users`, a Docker volume recreated hours
before a single 1.3-second migration batch, zero live dev processes), ruled out every alternative
cause (integration tests, the UAT harness, the gate scripts, migrations), and produced a recommended
mechanism. Ben resolved the one open design question that shaped the build (2026-08-17): **the dev
instance must fully mirror prod's setup** — a real dev `cli-runner` process, CLI OAuth token only,
no API-key billing for Codex or Claude for the foreseeable future.

This spec formalizes that draft plus three follow-up decisions (2026-08-19): delete the stale
pre-rename credential file, have `provision` also recreate the dev admin account unattended from a
secret file, and ship the read-only checkup and the actual fix as one piece of work rather than two.

## Goals

1. Make a `pnpm db:reset` (wipe + rebuild) end in a **working** dev instance in one command, every
   time — admin account exists, AI provider configured, chat actually resolves to a live model.
2. Make "is dev actually usable right now" answerable in one command instead of a 90-minute
   investigation, with the concrete repair named.
3. Handle the underlying credential so it is never present in argv, stdout, a log line, an agent
   transcript, or git.
4. Keep this dev-only tooling: never shipped in the `api`/`worker` bundles.
5. Reuse the same production code paths that create a chat-capable provider, rather than a second,
   parallel insertion mechanism that can drift from what the real app does.

## Non-Goals

- The `#1121` ephemeral UAT seeding path — stays a separate entry point, untouched (see
  "Relationship to the UAT seeder" below).
- Making the dev instance non-persistent (spin up fresh per session). Discussed and explicitly
  deferred — much larger change (LAN URL stability, connector OAuth state, vault contents), and
  doesn't remove the need for an idempotent provision step; it would just run more often.
- Hardening `assertIsolatedTestDatabase` to check host/port in addition to database name, and
  scoping `pnpm smoke:compose` with `-p` on the dev branch. Real gaps found during investigation,
  filed as their own small follow-up issues, not part of this build.
- A `PreToolUse` hook blocking `docker compose down -v` — flagged as a possible mitigation but is a
  settings/config change and Ben's call to make separately, not part of this spec.

## Resolved Decisions

| #   | Decision                 | Choice                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Credential engine        | Dev runs its own `cli-runner` process, CLI OAuth token, same as prod                                                                                                                                          | Ben's ruling 2026-08-17 — dev must mirror prod's process/lifecycle so testing never hits "didn't get started/restarted" drift; standing policy against API-key billing for Codex/Claude.                                                                                                                                                                |
| 2   | Trigger shape            | A `provision` subcommand of the CLI, called automatically by a new `db:reset` script; not a migration hook, not a cron                                                                                        | Migration-time writes would need an RLS carve-out or `BYPASSRLS` (forbidden); a standing scheduled reconciler would need always-hot decrypt access to the credential for a dev-convenience benefit only. The actual trigger is a human/agent running a documented command, so the fix is making that command's documented form include re-provisioning. |
| 3   | Idempotence              | Every step of `provision` is a no-op if already satisfied; safe to run any number of times                                                                                                                    | Matches the existing `ensureDefaultChatModel` contract; avoids a second insertion path with different semantics.                                                                                                                                                                                                                                        |
| 4   | Stale credential file    | Delete `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (2026-07-20, pre-rename) as part of this work                                                                                                       | Confirmed superseded by the current `~/.config/moss/uat/anthropic-oauth.env.gpg` (2026-08-12). Ben's decision, 2026-08-19.                                                                                                                                                                                                                              |
| 5   | Admin account recreation | `provision` recreates the dev admin login unattended, from a password in a host secret file, if `app.users` is empty                                                                                          | One command should fully rebuild dev after a wipe, no manual signup step. Ben's decision, 2026-08-19.                                                                                                                                                                                                                                                   |
| 6   | Sequencing               | Ship the checkup (`doctor`) and the fix (`provision`) together, as one piece of work                                                                                                                          | Ben's decision, 2026-08-19 — supersedes the draft's suggestion to sequence `doctor` first.                                                                                                                                                                                                                                                              |
| 7   | Scope vs #1258           | Land as subcommands of the existing `pnpm dev:instance` CLI from #1258 (`doctor`, `fix`, `providers`, `reset` already asked for there); this spec adds `provision` as the mandatory second half of `db:reset` | One issue, one coherent tool; avoids splitting a small CLI across two issues.                                                                                                                                                                                                                                                                           |

## Architecture

### What "a chat-capable provider" requires

Two disjoint halves, grounded in the existing `packages/ai` repository and auto-register service.
The existing manual fix has only ever reliably done the first:

- **Database half**: an active instance-admin user; a provider config row (kind, display name,
  status active, auth method, encrypted credential — purpose defaults `assistant`); a model row
  under it with `chat` capability; exactly one provider flagged as the instance default. All writes
  go through the existing data-context wrapper under an admin actor — no RLS carve-out, no
  `BYPASSRLS`. `AiAutoRegisterService.ensureDefaultChatModel` already performs this whole half,
  idempotently, and is the only production path that creates a chat-capable row — `provision` calls
  it rather than re-implementing it.
- **File half**: for the CLI auth method, the actual credential is a token file written to a
  per-instance home base by the existing token-persistence helper. The database row for a
  CLI-authenticated provider carries only a sealed sentinel, not the token itself — a `cli-runner`
  process has to be running and pointed at that home base, or the row resolves but every chat turn
  fails at request time. `provision` starts a dev `cli-runner` mirroring prod's and writes the token
  through the same helper.

### `provision`, in order (each step a no-op if already satisfied)

1. **Refuse anything that isn't the dev database.** Hard fail unless the target matches an
   allowlist by database name and port — same pattern as the two existing guards that protect the
   ephemeral UAT seeder and the integration-test database reset from ever touching something real.
2. **Ensure the dev admin account exists.** If `app.users` is empty, drive the real bootstrap-owner
   signup route (not a raw database insert) with a password read from a host secret file — never
   from a command-line argument.
3. **Ensure the provider + model rows**, via `ensureDefaultChatModel`, under an admin actor. Provider
   kind comes from config, not a hardcoded literal (see "Provider-agnosticism" below).
4. **Ensure the file half**: decrypt the host credential file to a private temp location, start (or
   confirm running) a dev `cli-runner` process pointed at the dev home base, persist the token
   through the existing token-store helper, then shred the temp plaintext.
5. **Run `doctor` and exit non-zero on any residual defect.** `doctor` is the acceptance evidence,
   not a separate deliverable — see Goal 2.

### `doctor` (read-only; also runnable standalone at any time)

Checks, each naming its own concrete repair on failure:

- Database reachable, migrations current.
- An active instance admin exists.
- Exactly one provider is flagged instance-default (covers both "zero rows" and "two rows, no
  default" — they present identically to an operator and must be treated as the same defect class).
- Chat capability resolves to a live model (a round-trip: not just "a row exists" but "the API's own
  environment can decrypt it and the router picks it").
- No leftover UAT fixture rows on the persistent dev database.
- Dev `cli-runner` process is actually running and reachable.

### How the credential moves without ever entering an agent's context

Decrypted only into a private `mktemp -d` directory (mode 0600 under a restrictive umask), removed
by an exit trap; passed to the CLI as an environment variable, never as a command-line argument
(argv is world-readable via `/proc`); the CLI itself never echoes the value, printing only
`token: present` / `token: absent`. The decrypt step stays interactive (a passphrase prompt), so an
agent running `provision` cannot silently exfiltrate the token — it never appears in output for the
agent to see, and the human step in the middle is a deliberate control, not an oversight.

### Env-parity requirement

`provision` must run with the same encryption-key environment and unset `NODE_ENV` as the dev API
and worker processes, or the credential row it writes will fail to decrypt at read time with an
opaque authentication-tag error rather than a clear one. `provision` refuses to run with `NODE_ENV`
set, and `doctor`'s "chat capability resolves to a live model" check is specifically a round-trip
decrypt under the API's own environment — this is the difference between "a row was written" and
"a row that actually works," and the spec treats it as a first-class requirement.

### Provider-agnosticism

The router is untouched — it keeps selecting by capability and tier, never a hardcoded provider
name. `ensureDefaultChatModel` already takes a provider kind as a parameter; `provision` reads that
kind, and the path to the credential file, from config. Today's credential happens to be Anthropic;
that is an operator fact recorded in config, not a code fact, and the spec is explicit about this so
a later pass doesn't "simplify" it into a hardcoded conditional.

### Relationship to the UAT seeder (#1121 / #1082 / #1025)

The ephemeral UAT seeding path and this persistent-dev path stay two separate entry points and must
not be collapsed. Their guards are logical inverses: the UAT seeder's `assertTargetIsEphemeral`
throws precisely when a real user already exists — which is exactly the state `provision` requires
before it will create one. They may share the convention for how a token moves from environment
variable into the token-store helper, and nothing else. Merging them would delete one of the two
fences that currently keep the ephemeral seeder from ever writing a loginable owner into a real
instance.

## User Stories

1. As an agent working on a chat-touching PR, I want the dev instance to have a working AI provider
   by default, so that the live-path gate doesn't fail for a reason unrelated to my change.
2. As an agent about to investigate a failing live-path gate, I want to run one command that tells
   me definitively whether the dev instance itself is healthy, so that I don't spend an hour
   misdiagnosing an environment problem as an application bug.
3. As Ben, I want a database reset to fully rebuild a working dev instance — admin account and AI
   provider both — without me re-pasting a credential or signing up by hand, so that "reset dev" is
   one command rather than a multi-step manual recovery.
4. As Ben, I want the tool to hard-refuse to run against anything that isn't the dev database, so
   that a mistaken invocation can never seed a credential or create an admin account on a real
   instance.
5. As an agent or Ben decrypting the host credential file, I want the plaintext token to never
   appear in stdout, a log line, an agent transcript, or git history, so that a spendable credential
   is never accidentally exposed.
6. As an agent running `provision` twice in a row (e.g., after a partial failure), I want the second
   run to be a clean no-op where things already succeeded, so that re-running is always safe.
7. As an agent debugging "chat says no model is configured" on dev, I want `doctor` to distinguish
   "zero providers," "two providers with no default," and "provider exists but the credential won't
   decrypt" as named, distinct failures, so that the repair is obvious instead of another
   investigation.
8. As a future maintainer, I want the dev instance to exercise the same `cli-runner` engine prod
   uses, so that a PR's live-path proof on dev is representative of what actually happens in
   production, not a different code path that happens to also produce a "chat works" result.
9. As Ben, I want the old, pre-rename credential file removed as part of this work, so that there is
   exactly one credential file to reason about, not two of ambiguous status.
10. As an agent reading the repo's documented reset procedure, I want it to point at `pnpm db:reset`
    (wipe + re-provision) rather than bare `pnpm db:down`, so that following the documented remedy
    for a routine problem (a checksum mismatch, wanting a clean slate) can no longer be the thing
    that silently breaks dev for everyone else.

## Implementation Decisions

- **Modules touched**: the `#1258` `pnpm dev:instance` CLI gets a new `provision` subcommand (and
  `doctor`/`fix` land alongside it per #1258's original ask, since they ship together per Decision
  6). `package.json` gains a `db:reset` script that chains `db:down && db:up && db:migrate &&
dev:instance provision`. Every repo doc currently recommending bare `pnpm db:down` as the routine
  remedy is updated to point at `pnpm db:reset` instead; `pnpm db:down` itself stays (CI's own
  teardown depends on it) but stops being the documented dev-operator remedy.
- **No new insertion path.** `provision` calls the existing `AiAutoRegisterService.ensureDefaultChatModel`
  under the existing data-context wrapper with an admin actor — it does not write a parallel SQL
  path for provider/model rows.
- **Admin recreation** goes through the real bootstrap-owner HTTP signup route, not a direct
  database insert, so the created account is indistinguishable from a real signup in every other
  system (auth, RLS, audit).
- **Cli-runner**: a dev-scoped instance of the same background process prod uses, started or
  confirmed running as part of `provision`, pointed at the dev home base directory.
  API-key/HTTP-provider seeding is explicitly not built — Decision 1 rules it out.
  Codex support is out of scope for the initial build; the credential file and provider kind are
  Anthropic-only for now, expressed as config, not hardcoded.
- **Guard implementation** mirrors the existing `assertIsolatedTestDatabase` / `assertTargetIsEphemeral`
  pattern: an allowlist on database name plus port, never a denylist.
- **Secret file contract**: the admin password and the AI provider credential are each read from a
  host-local secret file path supplied via config/env, decrypted only into a `mktemp -d` (mode
  0600), passed onward as an environment variable, and shredded via an `EXIT` trap. No secret is
  ever accepted as a CLI argument.

## Testing Decisions

Tests only exercise external behavior (a command's exit code, its stdout/stderr content, and the
resulting database/file state) — never internal call structure.

- **Red-first guard tests**: `provision` refuses a non-dev target — one test per each of database
  name mismatch and port mismatch, mirroring the existing test suites for
  `assertIsolatedTestDatabase` and the UAT seeder's `assertTargetIsEphemeral`.
- **Idempotence test**: running `provision` twice against a freshly-migrated, empty dev database
  produces the same end state as running it once, and the second run performs zero writes to rows
  that already existed (or asserts on the no-op log line, whichever the codebase's existing
  idempotence tests prefer).
- **No-leak test**: asserts that no captured stdout/stderr line across a full `provision` run
  contains the test credential's literal value.
- **Round-trip parity test**: after `provision`, a decrypt of the written provider credential
  succeeds using the same environment the dev API process runs under (Env-parity requirement) —
  this is the test that would have caught the historical key/`NODE_ENV` mismatch failure mode.
- **`doctor` unit tests**: one per named defect (zero providers, two providers, no default flagged,
  UAT fixture rows present, migrations behind, `cli-runner` not reachable) — each asserting both the
  non-zero exit and that the reported repair names the actual problem.
- Given the security tier (Risk tier above), this work gets an adversarial QA pass before merge, in
  addition to the automated suite — consistent with how #1082 and #854's guards were reviewed.

## Exit Criteria

1. `pnpm db:reset` from a fully wiped state yields a dev instance where `doctor` exits 0 — admin
   account exists, AI provider configured, `cli-runner` running, chat capability resolves.
2. Running `provision` twice in a row is a clean no-op the second time (asserted by test).
3. `provision` refuses a non-dev target (asserted by red-first test, not manual inspection).
4. No stdout/stderr/log line from any `provision` run contains the credential (asserted by test).
5. A round-trip decrypt of the written credential row succeeds under the dev API's own environment
   (asserted by test) — proves the env-parity requirement, not just "a row exists."
6. Live-path proof: a real chat turn completes through the browser on the dev instance immediately
   after a `pnpm db:reset`, recorded per the Live-Path Gate in `docs/DEVELOPMENT_STANDARDS.md`.
7. The stale pre-rename credential file is deleted.
8. Every repo doc identified as recommending bare `pnpm db:down` as the dev remedy is updated to
   `pnpm db:reset`.

## Hard Invariants Honored

- **No admin private-data bypass**: `provision` acts _as_ an admin actor through the normal
  data-context wrapper; it does not add an RLS carve-out or a `BYPASSRLS` role anywhere.
- **Secrets never escape**: the AI credential and the admin password are handled exclusively via
  temp files under a restrictive umask and environment variables, never argv/stdout/logs; the
  encrypted-at-rest requirement for the provider credential is unchanged (AES-256-GCM, existing
  keyring).
- **Provider-agnostic AI**: provider kind and credential path are config, not a hardcoded literal;
  the router is untouched.
- **Module isolation**: `provision` calls the existing `AiAutoRegisterService` public method; it
  does not reach into `packages/ai`'s internals or write to its tables directly.
- **Never edit an applied migration**: no part of this design touches the migration chain; seeding
  happens entirely at the application layer, post-migration.
- **A PR must never break prod**: this tooling is dev-only and explicitly never shipped in the
  `api`/`worker` bundles (Goal 4); it introduces no new required env var in any deployed
  environment.

## Out of Scope

- Non-persistent ("fresh per session") dev instances — see Non-Goals.
- `assertIsolatedTestDatabase` host/port hardening and `smoke:compose` project-scoping on the dev
  branch — real gaps, filed separately, not part of this build.
- A pre-commit or pre-tool-use hook blocking `docker compose down -v` — a settings decision left to
  Ben, not built here.
- Codex/API-key provider seeding — explicitly ruled out by Decision 1 (standing policy, no API-key
  billing).
- Any change to the ephemeral UAT seeder (#1121/#1082/#1025) beyond sharing the env-var-to-token-store
  convention.

## Further Notes

- Primary source material: `docs/coordination/2026-08-17-shared-ai-provider-durable-setup-draft.md`
  (forensic root-cause investigation and initial mechanism recommendation) and Ben's 2026-08-17 and
  2026-08-19 rulings recorded there and in this session.
- This closes the loop that stalled PR #1703 and PR #1717's live-path proofs on "same dev AI
  provider gap."
