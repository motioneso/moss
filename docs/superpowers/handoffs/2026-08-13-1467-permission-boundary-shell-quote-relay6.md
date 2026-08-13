# Relay 6 — #1467 permission-boundary-shell-quote

**Status: PR #1610 still open, code/tests unchanged (fix already merged into this branch,
51/51 unit tests green per relay5). Live-path proof NOT YET EXECUTED. This relay only
scoped and de-risked the proof mechanism — ran out of context before executing it. No git
commits made by this relay other than this handoff.**

## Why relay5's plan changed

Relay5's handoff proposed a bare host-dev instance (`pnpm dev:api` + `pnpm dev:web`) proof.
Investigation this relay found that path is currently a dead end:

- Dev DB (`jarv1s-postgres`, `:55433`, db `jarv1s`, schema `app`) has **zero rows** in
  `app.users` and `app.ai_provider_configs` right now — no dev login exists (stale memory
  said otherwise).
- Host-dev has no dev-scoped `cli-runner`. The only running `cli-runner` process on the box
  belongs to **prod** (mounted from the `jarv1s-prod` volume) — do not touch it.
- If `JARVIS_CLI_RUNNER_SOCKET` is left unset, chat falls back to an in-process one-shot
  engine (`packages/chat/src/live/engine-selection.ts`) that still needs a DB-configured,
  real-credentialed `ai_provider_configs` row to route a turn at all. Fabricating one isn't
  viable without a real OAuth flow or a schema-valid encrypted credential.

## Decided path: reuse the `real-chat-onboarding` UAT container harness

`tests/uat/provisioner.ts` + `tests/uat/specs/real-chat-onboarding.uat.spec.ts` already solve
real signup + real provider credential end-to-end, gated on env var
`JARVIS_UAT_REAL_CHAT_TOKEN_FILE` (GPG-encrypted `CLAUDE_CODE_OAUTH_TOKEN`) — **confirmed set
in this environment**, so no new secrets needed. This harness runs `docker-compose.prod.yml`,
which bundles a working cli-runner inside the API container, sidestepping the host-dev gap.

Confirmed via read: `writeUatEnvFile()` (`tests/uat/provisioner.ts:183-253`) writes a fixed
env line list to a mkdtemp'd `env.production.local` (mode 0600) *before* compose up, with no
built-in passthrough — but since it's a plain file, an **uncommitted driver script** can
`fs.appendFileSync()` an extra line onto the path it returns, after calling `writeUatEnvFile()`
and before starting the stack. This keeps the fix's UAT-plumbing genuinely out of scope (no
edits to checked-in `tests/uat/*`), matching relay5's ruling that wiring NOTES_ROOTS into the
UAT provisioner is out of scope for #1467.

`real-chat-onboarding.uat.spec.ts` (152 lines, read in full) is **not itself usable as-is** —
it proves a real chat reply, not vault-root permission-card behavior. It's a template only.
Its sequence, confirmed correct and required in this order (uat-real-chat-onboarding-cli-tools-
missing trap): `signIn()` → `POST /api/onboarding/provider-install {providerKind:"anthropic"}`
(must precede login/begin or begin wrongly reports `awaiting_token`) → `POST
/api/onboarding/provider-login/begin {providerKind:"anthropic"}` → poll `GET /api/ai/models`
(exp. backoff, 60s deadline) until a `status:"active"`+`capabilities:["chat",...]` model
appears → `POST /api/chat/turn {text: "..."}`.

## Concrete next steps (not started)

1. Write a new, **uncommitted** driver script (e.g. under scratchpad, not `tests/uat/`) that:
   - Calls `writeUatEnvFile()`, then appends `MOSS_NOTES_ROOTS=<container-writable-path>` (e.g.
     `/tmp/uat-1467-notes`) to the returned `path` before compose up.
   - Brings the stack up via `provisionForUat()` (`tests/uat/provisioner.ts:677`) or its
     lower-level pieces — read that function next, it wasn't read this relay.
   - After the stack is healthy, `docker exec` into the API container to create one small file
     under the configured root (e.g. `mkdir -p /tmp/uat-1467-notes && echo "proof-1467" >
     /tmp/uat-1467-notes/proof.txt`).
   - Drives the onboarding+model-ready sequence above (copy, don't import, per the spec file's
     own established convention — importing across spec files double-registers `test()` calls).
   - Sends a real chat turn asking to read `/tmp/uat-1467-notes/proof.txt` and asserts (a) the
     reply contains `proof-1467`, and (b) **no permission-card / pending-approval state** was
     hit — **still need to identify the concrete signal for "no card appeared"** (check
     `packages/chat/src/live-routes.ts` turn response shape and any permission-pending
     endpoint/SSE event before writing this assertion; not yet investigated).
   - Tears the stack down via the provisioner's cleanup.
2. Record the proof as a `gh pr comment` on #1610: exact commands run, exit codes, and the
   specific pass/fail observation — no screenshots (banned post-`2852a12c3`).
3. Full gate via `verify-gate` skill (isolated gate DB — never run `pnpm verify:foundation`
   unscoped).
4. Security tier: adversarial cross-model QA (AGY specifically, not Fable, not gemini-cli) +
   Ben's explicit merge sign-off.
5. On merge, `coordinated-wrap-up`: comment on #1467 + update project board (**project 2**,
   "Issue and Roadmap Work" — not archived project 1/3).

## Fallback if the UAT-container proof proves too costly

If a successor relay burns significant budget and the container proof still isn't landing,
the fallback is: cite the existing unit test ("omits JARVIS_NOTES_ROOTS ... when no root is
configured") plus a narrow, direct proof of the injection point (call
`vaultRootsEnvEntry()`/the hook-writer function directly against a controlled env, show the
emitted command string contains `JARVIS_NOTES_ROOTS=<roots>` with `MOSS_NOTES_ROOTS` set vs.
absent without it) — but that is **not** a live-UI proof, so it does not satisfy the Live-Path
Gate on its own. Using it would require flagging the gap explicitly in the PR comment and
getting Ben's explicit sign-off to accept a narrower proof for this PR (AWAITING-BEN entry +
`needs-ben` ping per box-wide CLAUDE.md) — don't merge on the strength of the fallback alone
without that sign-off.

## Traps (carried over + new)

- `Moss`/prod container on :1533 and the prod `cli-runner` process — never touch.
- Ports 5173/5197 already held by other worktrees' dev servers; :3000/:5199 were free as of
  this relay.
- Commit by explicit path only (shared checkout); `git show --name-only HEAD` after each commit.
- If `herdr agent start` (self-spawn) is denied, don't retry — message Coordinator to spawn
  instead.
- `tests/uat/specs/real-chat-onboarding.uat.spec.ts` is a template for provider bootstrap only —
  do not try to run it directly expecting it to prove #1467; it asserts nothing about vault
  roots or permission cards.
