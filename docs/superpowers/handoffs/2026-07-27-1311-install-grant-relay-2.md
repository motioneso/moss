# Relay 2: #1311 install-time grant — build in progress

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` already present — do not `pnpm install`.

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` (currently the
`coord-1262` worktree pane, session `43e5f5e2-0deb-4ab5-9237-436e8795b611`; re-confirm exactly one
pane holds the label before messaging, per `herdr-pane-message`).

**Plan (approved, build in progress):**
`docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read it in full, it's
short. It already contains the coordinator's required Path-B fix and both smaller asks, folded in.

## State

Coordinator approved the plan 2026-07-27 with one **required** change (already in the plan doc):
Path B (tasks) must re-read the stored tier after calling `grantInstallTimeTrustIfUnset` and
return that, never assert `"trusted_auto"` directly — the insert is insert-if-absent, so it can
succeed silently against a row that already exists (including one the user set to
`always_confirm`). Both self-heal paths must derive their answer from storage, not assert it.
Plus two smaller asks, also folded into the plan: (1) PR description must explain Path A grants
*every* `granted_at_install` family in the manifest, correct by design, not an over-grant bug; (2)
add rows to the UAT trigger map for the three touched files so future lanes get the trigger
automatically.

Coordinator also ruled (on the record, telling Ben directly): no dedicated spec file is needed —
this restores already-approved #1263 behavior, so the spec-before-build gate doesn't apply here.

**Task 1 — DONE, committed `909ce93a`.** `selfHealGrantedAtInstallTier` added + exported from
`packages/ai/src/gateway/self-operation.ts` (and re-exported via `gateway/index.ts` + top-level
`packages/ai/src/index.ts`). 3 unit tests green in
`tests/unit/self-heal-granted-at-install.test.ts`.

## Next concrete steps (Tasks 2-5, exact detail in the plan doc)

1. **Task 2** — wire the generic path into `packages/chat/src/routes.ts`'s `buildActionPolicy`
   `getFamilyTier` (non-tasks branch, currently ~line 846-861): on no stored policy, resolve the
   module manifest via `args.resolveActiveModules(ctx.actorUserId)` and delegate to
   `selfHealGrantedAtInstallTier`. New `tests/integration/chat-action-policy-self-heal.test.ts`
   via the exported `buildChatGatewayDependencies` — 3 tests per plan (heals, revocation-survival,
   confirm_always never healed). **Check the manifest-shape open question in the plan's seams
   check first** — `tsc` will tell you fast if `SelfOperationManifestInput` isn't satisfied by
   what `resolveActiveModules` returns.
2. **Task 3** — tasks path fix in `packages/tasks/src/action-policy.ts:18`, re-read not assert
   (see plan for exact behavior). New `tests/integration/tasks-action-policy-self-heal.test.ts`,
   4 tests per plan.
3. **Kill gate** after Task 2 (before Task 3): live-verify the generic path kills the confirm card
   on a live dev instance. If it doesn't, stop and escalate to the coordinator instead of letting
   Task 3 repeat a wrong design.
4. **Task 4** — live-path UAT proof, assertions/evidence, `gh pr comment` at wrap-up.
5. **Task 5** — PR description (tasks-was-broken correction, `grantInstallTimeTrustIfUnset`
   justification, 6-conditions-to-tests mapping, over-grant-by-design note, live-path link) + UAT
   trigger-map rows for the three touched files.

Then pre-push trio + rebase, isolated gate DB run (`GATEDB=jarvis_gate_1311installgrant`, exact
commands in the plan doc's Verification section), `coordinated-wrap-up`.

Relay to the coordinator already sent for this handoff — no need to re-announce Task 1 completion,
just pick up at Task 2. Relay again yourself at the next 70% context warning, per
`coordinated-build`.
