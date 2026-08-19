# Relay 3: #1311 install-time grant — kill gate in progress

**Worktree/branch:** `/home/ben/Jarv1s/.claude/worktrees/1311-install-grant`, branch
`1311-install-grant`. `node_modules` present — do not `pnpm install`.

**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list` (was `w1:p11T`,
session `43e5f5e2-0deb-4ab5-9237-436e8795b611`, `coord-1262` worktree; re-confirm exactly one
pane holds the label before messaging). Already told: Task 2 done (`bf3e8fd8`), kill-gate in
progress.

**Plan doc:** `docs/superpowers/plans/2026-07-27-1311-install-grant-default-enabled.md` — read by
section only. Kill gate text lines 179-186, Task 3 lines 136-154, Task 4 lines 156-163, Task 5
lines 165-177, Verification lines 188-210.

## Done

**Task 1** (prior session) — `selfHealGrantedAtInstallTier` in
`packages/ai/src/gateway/self-operation.ts`, committed `909ce93a`.

**Task 2** (this lane) — wired generic self-heal into `packages/chat/src/routes.ts`'s
`buildActionPolicy` `getFamilyTier`. New `tests/integration/chat-action-policy-self-heal.test.ts`
(3 tests, all green: heals granted_at_install, never overrides always_confirm, never heals
confirm_always). Committed `bf3e8fd8`. No regressions in
`tests/integration/action-policy-install-grants.test.ts` or
`tests/unit/chat-gateway-dependencies.test.ts` (re-ran both, green).

## In progress: Kill gate (MUST pass before Task 3 — coordinator was explicit on this)

Required check: dispatching a `granted_at_install` tool on a `defaultEnabled` module with no
prior explicit enable action produces NO confirm card, live on a real dev instance.

**Dev instance already running — reuse, don't relaunch:**
- API: port 3099, PID 928691 (parent)/928754 (tsx watch child), log `/tmp/1311-dev/api.log`.
  Healthy per `curl http://localhost:3099/health` → 200.
- Web: intended `--port 5199` but Vite actually bound **5175** — re-verify with
  `curl -sI http://localhost:5175` and `/tmp/1311-dev/web.log` before trusting the port; PID
  929312 (parent)/929440/929441 (vite child).
- Both point at shared dev Postgres (`jarv1s-postgres` container, db `jarv1s`) — standard recipe,
  not an isolated gate DB (that's only for the final `verify:foundation` run).
- Login: `ben@ben.com` / `jarvistest123!` (id `6dc52034-a0ee-4944-9bfc-ef477af4370b`).

**Chosen test tool:** `news.addTopic` — `packages/news/src/manifest.ts` ~line 334-356. Family
`news_personalization`, `selfOperationGrant: "granted_at_install"`, module `news` has
`defaultEnabled: true`. Needs only a `label` input (e.g. "climate policy") — no prior-state
dependency, unlike `confirmSource`/`removeSource`/`removeTopic`.

**Unresolved blocker:** action-policies DB table name not yet confirmed — `\dt app.*action*` came
back empty, `app.action_policies` doesn't exist. Don't guess again — read
`packages/ai/src/repository.ts` ~1877-1970 (`listActionPolicies`/`setActionPolicy`/
`insertActionPolicyIfAbsent`) directly for the real table/schema name before trying to
pre-check/clear a row for ben@ben.com + news + news_personalization.

**`chromium-cli` is NOT installed here.** Fallback per the `run` skill's playwright.md: write a
standalone script using `import { chromium } from "playwright"` (or `@playwright/test`'s
`chromium`), `chromium.launch({ args: ["--no-sandbox"] })`, `newContext()` → `newPage()` →
`goto("http://localhost:5175")`. Coordinator requires actual live assertions in the PR proof, not just
a description.

**Kill-gate steps remaining:**
1. Resolve action_policies table name (repository.ts read), confirm no pre-existing row for this
   user/module/family (or note if one exists from an earlier local test — if so use a different
   test user, e.g. `ids.userB` equivalent, or clear it manually with an explicit DELETE you write
   after confirming the table).
2. Playwright script: log in, open chat, ask to follow news topic "climate policy" (or similar),
   assert before/after DOM state, confirm NO confirm-card rendered, confirm the topic was actually added
   (proves the dispatch executed, not just skipped).
3. Query DB: row for (ben@ben.com, news, news_personalization) now `trusted_auto`.
4. **If it fails** (confirm card still appears): STOP. Do not start Task 3. Escalate to
   coordinator with SECURITY or DESIGN-FORK tag, describe exactly what was observed. Do not loosen
   `policy.ts`, `allowedTiers`, or `defaultTier` to force it green — fix the design, not the gate.
5. **If it passes:** this verification run doubles as Task 4's live-path proof (same assertions,
   same dispatch) — no need to repeat it later, just carry the assertions/evidence forward to the PR
   comment at wrap-up.

## Remaining after kill gate

- **Task 3**: `packages/tasks/src/action-policy.ts:18` — re-read stored tier after
  `grantInstallTimeTrustIfUnset`, never assert `trusted_auto` directly (insert-if-absent must not
  clobber an existing `always_confirm`). New `tests/integration/tasks-action-policy-self-heal.test.ts`,
  4 tests per plan lines 136-154.
- **Task 4**: live-path UAT proof — `gh pr comment` with assertions/evidence at wrap-up (reuse kill-gate
  run if it already covers this).
- **Task 5**: PR description — tasks-was-broken correction, `grantInstallTimeTrustIfUnset`
  justification, 6-conditions-to-tests mapping, over-grant-by-design note (Path A grants *every*
  `granted_at_install` family in the manifest — correct by design), live-path link. Plus UAT
  trigger-map rows for the three touched files (plan lines 165-177).
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`) + `git fetch origin main &&
  git rebase origin/main`.
- Isolated gate DB: `GATEDB=jarvis_gate_1311installgrant`, drop/create,
  `JARVIS_PGDATABASE=$GATEDB pnpm verify:foundation` (expect rc=0), drop gate DB after.
- `coordinated-wrap-up`: clean tree, push, open PR, report to coordinator. Never touch
  board/milestones/merge.

## Cleanup reminder

Kill the throwaway dev instance when the kill-gate/UAT work is fully done (`kill 928691 928754
929312 929440 929441` or re-check PIDs first — they may have changed if a successor restarted
anything).

## Hard constraints (coordinator, verbatim ruling this lane)

Never widen a `defaultTier`, change a grant, edit `allowedTiers`, or loosen `policy.ts` to make a
test pass — fix the test, never the policy. PR does not merge without a live end-to-end proof
comment (real UI, live dev instance, UAT run, DOM/API assertions) — CI-green or mocked tests alone don't
discharge it.
