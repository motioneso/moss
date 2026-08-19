# Relay 5: #1311 install-time grant — negative control done, finding #1 done, finding #2 next

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` present — do not `pnpm install`. Tree clean at `d1e9b1fe`
(only `.claude/context-meter.log` dirty, ignore it).

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` each time (ephemeral
pane ids). Not yet told about this relay's progress — send the step-3 update below once finding #2
lands.

**Plan doc:** `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read by
section only. Task 3 lines 136-154, Task 4 lines 156-163, Task 5 lines 165-177, Verification lines
188-210.

**Prior handoff (superseded, full history there if needed):**
`docs/superpowers/handoffs/2026-07-27-1311-install-grant-relay-4.md`

## Done this relay

1. **Confirm_always negative control — CLOSED, coordinator's outstanding ask satisfied.** Live
   dispatch against the dev instance (see below): POST `/api/chat/turn` asking the assistant to use
   `web.read` (`packages/web-research/src/manifest.ts`, `selfOperationGrant: "confirm_always"`, no
   `actionFamilyId` — structurally can't self-heal). Result: `app.ai_assistant_action_requests` got
   a `pending` row for `web.read` (the confirm-card equivalent), zero `app.preferences` rows
   written (checked `key ilike '%web%'` and `%action_policy%`, both 0 rows). Rejected it via POST
   `/api/chat/action-requests/<id>/resolve` `{"status":"rejected"}` to unblock the held
   `/api/chat/turn` call; final audit row: `web.read | rejected | denied`. No screenshot taken (did
   this via curl, not browser — no browser/MCP tool was available this session; DB evidence is
   the proof). If the coordinator wants additional evidence, attach bounded DOM/network/log output;
   granted to whichever session does it.
2. **Finding #1 — DONE, committed `d1e9b1fe`.** Added an explicit boot-time assertion in
   `packages/ai/src/gateway/self-operation.ts` (`assertBuiltInSelfOperationManifests`, right after
   the existing `defaultTier === "always_confirm"` check ~line 331): a `granted_at_install`
   family's `defaultTier` must never be `"trusted_auto"` (cast to `string` for the comparison —
   the type union already excludes that literal, so this is deliberate defense-in-depth for a
   family manifest built outside strict typing). New test in
   `tests/unit/self-operation-chassis.test.ts`: "rejects a granted_at_install tool whose family
   defaults to trusted_auto". Both `tests/unit/self-operation-chassis.test.ts` and
   `tests/unit/self-operation-startup.test.ts` pass (`pnpm vitest run` on both, exit 0). Already
   wired at `server.ts:626` — no server.ts change needed, the assert function itself was the whole
   fix.

## Still outstanding — Finding #2, then continue the plan order

**Finding #2 — revocation-defeat path (latent, not reachable in prod today), NOT started.** If
`buildActionPolicy` (`packages/chat/src/routes.ts` ~851, the conditional guard) is ever composed
WITHOUT `preferences`, a `tasks/task_changes` miss falls through to the generic heal, writes
canonical `trusted_auto`, ignoring a legacy `tasks.agency_auto_execute=false` revocation — compat
layer then prefers the newer canonical row, revocation lost. Unreachable only because
`module-registry/src/index.ts:1299` always passes `agencyPreferences` (caller-dependent safety).
Fix: make it structural — pick whichever is smaller: (a) skip the generic heal entirely for
`tasks/task_changes` in `routes.ts`'s `getFamilyTier`, or (b) remove the conditional so preferences
are always required (never optionally absent). Note in the PR which was chosen and why. Do NOT
touch `policy.ts`, `allowedTiers`, or any `defaultTier` value — structural guard only. Escalate
`[SECURITY]` first if a `policy.ts` edit looks genuinely necessary (it shouldn't).

TDD this like finding #1: commit separately from Task 3.

## Order for the successor

1. **Finding #2** (code + test, `routes.ts`). Commit separately from finding #1 (already committed)
   and from Task 3.
2. Send coordinator: kill gate before/after (already confirmed, relay-4) + confirm_always negative
   control done (DB evidence, this relay) + both findings fixed. Wait for ack before continuing if
   any pushback.
3. **Task 3**: `packages/tasks/src/action-policy.ts` `getResolvedTaskChangesPolicy` — neither-row
   branch must call `grantInstallTimeTrustIfUnset` then RE-READ storage (never assert
   `trusted_auto`), same re-read discipline as `selfHealGrantedAtInstallTier`. New
   `tests/integration/tasks-action-policy-self-heal.test.ts`, 4 tests per plan lines 136-154.
   Pattern reference: `tests/integration/chat-action-policy-self-heal.test.ts` (already read in
   full by a prior relay, not modified).
4. **Task 4**: live-path UAT proof. Dev instance still up, reuse — **re-check PIDs first, they
   drift across relays**: API :3099 (confirmed alive this relay, actual PID `1085121` not the
   stale `928691/928754` from relay-4 — `ss -ltnp | grep 3099` to get the current one), web :5175
   (PID `929441` confirmed alive). Login `ben@ben.com` / `jarvistest123!`
   (`6dc52034-a0ee-4944-9bfc-ef477af4370b`). Log at `/tmp/1311-dev/api.log`. Record bounded DOM,
   network, and DB assertions in a `gh pr comment`.
5. **Task 5**: PR description per plan lines 165-177 — tasks-was-broken correction,
   `grantInstallTimeTrustIfUnset` justification, 6-conditions-to-tests mapping, over-grant-by-design
   note (Path A grants every `granted_at_install` family — correct by design), live-path link, UAT
   trigger-map rows for touched files. Also note: the tasks compat helper stays (still load-bearing
   for legacy arbitration + dual-key install guard), and two paths now decide the same policy
   (generic self-heal path + tasks compat path) — document, don't collapse. Also mention the
   confirm_always negative control result (DB evidence, no screenshot) and both security findings.
6. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`.
7. Isolated gate DB: `GATEDB=jarvis_gate_1311installgrant`, drop/create,
   `JARVIS_PGDATABASE=$GATEDB pnpm verify:foundation` (expect rc=0), drop after.
8. `coordinated-wrap-up`: clean tree, push, open PR, report to coordinator. Never touch
   board/milestones/merge.

## Cleanup reminder (still not done — UAT proof still needs the instance)

Kill throwaway dev instance once Task 4 proof is captured. Re-check PIDs first (drift every
relay) — this relay found API actually on PID `1085121` (port 3099) and web on `929441`/`929312`/
`929440` (port 5175/5199 — two vite ports were up, 5175 is the one that answered).

## Hard constraints (verbatim, unchanged)

Never widen a `defaultTier`, change a grant, edit `allowedTiers`, or loosen `policy.ts` to make a
test pass — fix the test, never the policy; escalate `[SECURITY]` if a policy change looks
genuinely necessary. Path B self-heal (and any new Task 3 code) must always RE-READ storage and
return the stored value, never assert `trusted_auto`.

## Trap discovered this relay (also saved to agentmemory)

`/api/chat/turn` blocks synchronously until the triggered tool's confirm/timeout resolves — a
second POST while one is pending returns 409. Unblock with POST
`/api/chat/action-requests/<id>/resolve` `{"status":"<confirmed|rejected|cancelled>"}`. Pending
confirmations live in `app.ai_assistant_action_requests` (NOT `app.action_requests` — that table
doesn't exist), audit trail separately in `app.jarvis_action_audit_log`.
