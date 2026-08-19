# Relay 4: #1311 install-time grant — kill gate PASSED, 2 security fixes queued, Task 3 next

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` present — do not `pnpm install`. Tree clean at `3bf2b293`
(no uncommitted code; only `.claude/context-meter.log` dirty, ignore it).

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` each time (ephemeral
pane ids). Already told: kill gate passed with before/after live evidence (see below) — NOT yet
told about the two security findings' fix status (send that once done).

**Plan doc:** `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read by
section only. Task 3 lines 136-154, Task 4 lines 156-163, Task 5 lines 165-177 (UAT trigger-map
rows), Verification lines 188-210.

## Kill gate: PASSED, personally observed before AND after (do not re-run)

Dev instance still up, reuse: API :3099 (PID 928691/928754, log `/tmp/1311-dev/api.log`), web
:5175 (PID 929312/929440/929441). Login `ben@ben.com` / `jarvistest123!`
(`6dc52034-a0ee-4944-9bfc-ef477af4370b`). Both point at shared dev Postgres (`jarv1s-postgres`,
db `jarv1s`) — not the isolated gate DB.

- **Before** (`packages/chat/src/routes.ts` reverted to `bf3e8fd8^`, self-heal absent): confirm
  card appeared for `news.addTopic`, timed out unapproved → audit log
  `news.addTopic | timeout | denied | 2026-07-27 22:57:49`.
- **After** (routes.ts restored to HEAD, self-heal wired): first live dispatch with no prior
  policy row → NO confirm card, real tool execution, audit log
  `news.addTopic | auto | success | 2026-07-27 22:51:14`, `app.preferences` row flipped to
  `trusted_auto` for key `assistant.action_policy.v1.news.news_personalization`.
- Both confirmed via `docker exec jarv1s-postgres psql -U postgres -d jarv1s` against
  `app.jarvis_action_audit_log` (columns: `tool_name, approval_mode, outcome, occurred_at`,
  filter `owner_user_id`) and `app.preferences` (columns: `key, value_json, updated_at`).

**Known flaky artifact, already explained, not a blocker:** a 3rd repro attempt (topic
"after-fix repro topic v2") hit the confirm card again even with the fix active, with no new
audit row (request still pending when screenshot taken, no timeout yet). Root cause: `getFamilyTier`
in `routes.ts` calls `selfHealGrantedAtInstallTier` (`packages/ai/src/gateway/self-operation.ts:475`),
which fails closed (returns `null`) if `grantSelfOperationForModule`'s insert throws — plausible
here given a prior request had pinned a DB connection for 150s (see `req-10` in `api.log`,
`responseTime:150014`), likely pool contention. `null` falls through to `manifest.defaultTier`
in policy.ts — safe today only because `news_personalization`'s defaultTier isn't `trusted_auto`.
This is exactly finding #1 below — don't re-chase it, just fix #1 and move on. A stray pending
confirm card for "after-fix repro topic v2" may still be sitting unresolved server-side; harmless,
will timeout/deny on its own, ignore it.

## Coordinator's adversarial security review (received at commit `3bf2b293`) — NOT MERGE BLOCKING, verified sound

Core mechanism confirmed correct: heal only reaches insert-if-absent, re-reads storage (never
asserts), external manifests strip grant fields so external modules can't reach it,
`confirm_always`/`user_promotable` still return null with tests. Two findings to fold in as ONE
fix pass (compose together, individually LOW):

**Finding #1 — add boot invariant.** `apps/api/src/server.ts:626` already has a boot assert
block (from #1263 Task 14 / `assertBuiltInSelfOperationManifests`,
`packages/ai/src/gateway/self-operation.ts` ~line 300-430). Add: a family whose grant can be
`granted_at_install` must never declare `defaultTier: "trusted_auto"` — process must refuse to
boot if one does. Today "fail closed on self-heal error" is safe only by convention (every
built-in family's defaultTier happens to be safe); this converts it to a hard constraint. Small
addition to the existing assert function in `self-operation.ts`, wired at the existing
`server.ts:626` call site.

**Finding #2 — revocation-defeat path (latent, not reachable in prod today).** If
`buildActionPolicy` (`routes.ts` ~851, the conditional guard) is ever composed WITHOUT
`preferences`, a `tasks/task_changes` miss falls through to the generic heal, writes canonical
`trusted_auto`, ignoring a legacy `tasks.agency_auto_execute=false` revocation — compat layer then
prefers the newer canonical row, revocation lost. Unreachable only because
`module-registry/src/index.ts:1299` always passes `agencyPreferences` (caller-dependent safety,
same shape as #1). Fix: make it structural — pick whichever is smaller: (a) skip the generic heal
entirely for `tasks/task_changes` in `routes.ts`'s `getFamilyTier`, or (b) remove the conditional
so preferences are always required (never optionally absent). Note in the PR which was chosen and
why. Do NOT touch `policy.ts`, `allowedTiers`, or any `defaultTier` value to do this — structural
guard only. Coordinator's standing rule: escalate `[SECURITY]` first if a `policy.ts` edit looks
genuinely necessary (it shouldn't for either finding).

**Still outstanding, coordinator flagged twice:** the `confirm_always` negative control on the
live instance — never yet run. Candidate tools (all `defaultEnabled` modules, easy to reach):
`packages/web-research/src/manifest.ts:83`, `packages/email/src/manifest.ts:263`,
`packages/memory/src/manifest.ts:258`, all `selfOperationGrant: "confirm_always"`. Pick whichever
has the simplest one-shot input, dispatch live, confirm: confirm card DOES appear (correct — must
never self-heal), no `app.preferences` row gets created either way. This closes the coordinator's
last open ask before Task 3-5 are reported done.

## Order for the successor

1. Confirm_always negative control (live, quick, closes coordinator's outstanding ask).
2. Findings #1 + #2 (code, in `self-operation.ts` + `server.ts` + `routes.ts`; TDD, commit
   separately from Task 3).
3. Send coordinator: kill gate before/after confirmed (evidence above) + both findings fixed +
   confirm_always negative control done. Wait for ack before continuing if any pushback.
4. **Task 3**: `packages/tasks/src/action-policy.ts` `getResolvedTaskChangesPolicy` — neither-row
   branch must call `grantInstallTimeTrustIfUnset` then RE-READ storage (never assert
   `trusted_auto`), same re-read discipline as `selfHealGrantedAtInstallTier`. New
   `tests/integration/tasks-action-policy-self-heal.test.ts`, 4 tests per plan lines 136-154.
   Pattern reference: `tests/integration/chat-action-policy-self-heal.test.ts` (read in full
   already, not modified).
5. **Task 4**: live-path UAT proof — reuse before/after assertions and logs (03, 04, plus
   05/06 if useful) in a `gh pr comment`.
6. **Task 5**: PR description per plan lines 165-177 — tasks-was-broken correction,
   `grantInstallTimeTrustIfUnset` justification, 6-conditions-to-tests mapping, over-grant-by-design
   note (Path A grants every `granted_at_install` family — correct by design), live-path link, UAT
   trigger-map rows for touched files. Also note in the PR: the tasks compat helper stays (still
   load-bearing for legacy arbitration + dual-key install guard), and that two paths now decide the
   same policy (generic self-heal path + tasks compat path) — document, don't collapse.
7. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`.
8. Isolated gate DB: `GATEDB=jarvis_gate_1311installgrant`, drop/create,
   `JARVIS_PGDATABASE=$GATEDB pnpm verify:foundation` (expect rc=0), drop after.
9. `coordinated-wrap-up`: clean tree, push, open PR, report to coordinator. Never touch
   board/milestones/merge.

## Cleanup reminder (still not done — UAT proof still needs the instance)

Kill throwaway dev instance once Task 4 proof is captured: re-check PIDs first (may have
changed), likely still `928691 928754 929312 929440 929441`.

## Hard constraints (verbatim, unchanged)

Never widen a `defaultTier`, change a grant, edit `allowedTiers`, or loosen `policy.ts` to make a
test pass — fix the test, never the policy; escalate `[SECURITY]` if a policy change looks
genuinely necessary. Path B self-heal (and any new Task 3 code) must always RE-READ storage and
return the stored value, never assert `trusted_auto`.
