# Relay 6: #1311 install-time grant — findings #1+#2+residual all done, Task 3 next

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` present — do not `pnpm install`. Tree clean at `b2ab1242`
(only `.claude/context-meter.log` dirty, ignore it).

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` each time (ephemeral
pane ids). Already told about this relay's progress (residual + relay notice sent).

**Plan doc:** `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read by
section only. Task 3 lines 136-154, Task 4 lines 156-163, Task 5 lines 165-177, Verification lines
188-210.

**Prior handoff (superseded, full history there if needed):**
`docs/superpowers/handoffs/2026-07-27-1311-install-grant-relay-5.md`

## Done this relay

1. **Finding #2 — DONE, committed `473080cd`** (from before this relay's start, see relay-5).
2. **Coordinator's residual security question — RESOLVED, committed `b2ab1242`.** Question: could
   `getFamilyTier`'s `null` → `policy.ts`'s `?? manifest.defaultTier` fallback fail OPEN for a
   family that is NOT `granted_at_install` (confirm_always/user_promotable) but whose
   `defaultTier` is `trusted_auto`, since finding #1's boot assert only covered
   `granted_at_install`? Answer: **yes, real gap for `user_promotable`** — same null-fallback
   mechanism, assert never checked it. Widened `assertBuiltInSelfOperationManifests`
   (`packages/ai/src/gateway/self-operation.ts`, in the `user_promotable` block ~line 385) with
   the same `defaultTier !== "trusted_auto"` guard finding #1 added for `granted_at_install`. New
   unit test in `tests/unit/self-operation-chassis.test.ts` ("rejects a user_promotable tool whose
   family defaults to trusted_auto"). `confirm_always` is separately safe by construction: its
   promotability check already forces `trusted_auto` out of `allowedTiers`, and `defaultTier` must
   be one of `allowedTiers`, so it can never be `trusted_auto` either — no code change needed
   there, just note this reasoning in the PR (Task 5). Verified no built-in manifest hits the
   user_promotable gap today: `task_changes`/`task_cleanup` (tasks), `calendar_writeback`/
   `calendar_management` (calendar) all default to `ask_each_time` or `always_confirm` — this was
   a structural gap, not a live bug. Both `tests/unit/self-operation-chassis.test.ts` and
   `tests/unit/self-operation-startup.test.ts` pass (exit 0, `/tmp/1311-t3.log`).
3. Sent coordinator the status update (finding #2 + residual resolution + relay notice) via
   `herdr agent prompt w1:p11T` — session id `43e5f5e2-0deb-4ab5-9237-436e8795b611`, re-resolve
   fresh, don't reuse `w1:p11T` verbatim.
4. Saved durable state to agentmemory (project `jarv1s`, type `architecture`).

## Order for the successor

1. **Task 3**: `packages/tasks/src/action-policy.ts` `getResolvedTaskChangesPolicy` — the
   neither-row branch (`if (!canonical && !legacy) return "ask_each_time";`) must instead call
   `grantInstallTimeTrustIfUnset(db)` then RE-READ storage and return the actually-stored value
   (never assert `trusted_auto`) — same re-read discipline as `selfHealGrantedAtInstallTier`
   (`packages/ai/src/gateway/self-operation.ts:495-519`). New
   `tests/integration/tasks-action-policy-self-heal.test.ts`, 4 tests per plan lines 136-154.
   Pattern reference: `tests/integration/chat-action-policy-self-heal.test.ts` (already modified,
   don't touch further, just mirror its DB/runner setup). Run via
   `pnpm test:integration -- tests/integration/tasks-action-policy-self-heal.test.ts` (note: the
   `--` filter does NOT actually narrow the run — full suite runs anyway, ~850s, backgrounds past
   120s; that's fine, just expect it).
2. **Task 4**: live-path UAT proof. Coordinator suggested reusing/inverting
   `live-uat-1310.spec.ts` on branch `1264-settings-self-operation` (worktree at
   `/home/ben/Jarv1s/.claude/worktrees/1264-settings-self-operation`, pane `w1:p14D` per last
   `herdr pane list` — re-resolve) rather than building a new harness: same tool
   (`settings.themeMode.set`, `granted_at_install`), same real dev instance, assert NO card appears
   and the tool auto-executes (inverse of #1310's pre-fix reproduction: card appeared, timed out
   at 150s). This also resolves the coordinator's open kill-gate A/B validity concern. Re-check dev
   instance PIDs first (API :3099, web :5175 — drift every relay, `ss -ltnp | grep -E '3099|5175'`).
   Login using the development sign-in details (kept outside the repository). Trap: `/api/chat/turn` blocks synchronously on
   confirm/timeout; unblock via POST `/api/chat/action-requests/<id>/resolve`
   `{"status":"confirmed"|"rejected"|"cancelled"}`.
3. **Task 5**: PR description per plan lines 165-177 — cover: tasks-was-broken correction,
   `grantInstallTimeTrustIfUnset` justification, 6-conditions-to-tests mapping, over-grant-by-design
   note, live-path link, UAT trigger-map rows, tasks compat helper stays load-bearing note, "two
   paths decide the same policy, document don't collapse" note, confirm_always negative control
   (DB evidence, no screenshot, from relay-5), both security findings (#1 `d1e9b1fe`, #2
   `473080cd`), the residual security fix (`b2ab1242`) with the confirm_always-safe-by-construction
   reasoning spelled out, and the #1310 live-evidence corroboration (required module, not just
   defaultEnabled).
4. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
   git rebase origin/main`.
5. Isolated gate DB: `GATEDB=jarvis_gate_1311installgrant`, drop/create,
   `JARVIS_PGDATABASE=$GATEDB pnpm verify:foundation` (expect rc=0), drop after.
6. `coordinated-wrap-up`: clean tree, push, open PR, report to coordinator. Never touch
   board/milestones/merge.

## Hard constraints (verbatim, unchanged, still binding)

Never widen a `defaultTier`, change a grant, edit `allowedTiers`, or loosen `policy.ts` to make a
test pass — fix the test, never the policy; escalate `[SECURITY]` if a policy change looks
genuinely necessary. Path B self-heal (and any new Task 3 code) must always RE-READ storage and
return the stored value, never assert `trusted_auto`. (The residual-question fix this relay
widened an *assert's coverage*, not any policy value — consistent with this constraint.)

## Trap discovered prior relay (also in agentmemory)

`/api/chat/turn` blocks synchronously until the triggered tool's confirm/timeout resolves — a
second POST while one is pending returns 409. Pending confirmations live in
`app.ai_assistant_action_requests` (NOT `app.action_requests`), audit trail in
`app.jarvis_action_audit_log`.
