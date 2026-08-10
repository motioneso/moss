# w5c-chat-surface relay 4 → 5 — 2026-08-09

**Issue:** #1254, lane C. **Branch/worktree:** `w5c-chat-surface`.
**Coordinator:** Herdr label `Coordinator` — **re-resolve fresh**, was pane `w1:p3R`,
agent_session `9c7ffdf7-4ccc-4378-aa3e-4f2f6f43a171` at this write. Don't reuse, re-resolve.

## State: implementation DONE, gate GREEN, two commits in, NOT pushed, no PR yet

Plan `docs/superpowers/plans/2026-08-09-1254-approval-card-action-label.md` fully executed via
TDD. Nothing left to design or re-derive — only mechanical wrap-up remains.

**Commits on this branch (HEAD, in order):**
1. `07de16fcf` — `feat(ai): approval-card summary prefers module actionLabel over raw description
   (#1254)` — the 4 contract changes (`module-sdk/src/index.ts`, `external-module.ts`,
   `module-registry/src/external/tool-manifests.ts`, `gateway.ts` `summaryFor()`).
2. `fbe53fa01` — `test(ai): cover actionLabel priority chain and wire-through (#1254)` — 3 test
   files (1 new: `tests/unit/gateway-summary-action-label.test.ts`; 2 extended:
   `tests/unit/external-tool-manifests.test.ts`, `tests/integration/external-module-gateway.test.ts`)
   plus the plan doc.

Both verified via `git show --name-only HEAD`/`HEAD~1` — each contains exactly its intended files,
tree is clean (`git status --porcelain` empty) as of this write.

**Full gate already run green this relay** (hand-rolled, not yet via `scripts/run-gate.sh` — that
script wasn't used; if the coordinator/QA wants the canonical form, rerun via
`scripts/run-gate.sh start`/`wait`/`status` instead of trusting this note alone):
`pnpm verify:foundation` on fresh isolated DB `jarvis_gate_1254c` (dropped after run) →
`### FINAL rc=0`. 186 test files / 1873 tests passed, 2 skipped. Confirmed via unpiped sentinel
line, not a wrapper `echo $?`. Included a `format:check` red→green loop (prettier flagged the plan
doc and the new test file; fixed with `pnpm exec prettier --write`, reran full gate clean).

## Next concrete steps (per `coordinated-wrap-up`, resume at step 3)

Steps 1 (clean tree/commit) and 2 (own green gate) are **done** — see above. Resume at:

3. Pre-push fast checks + push + PR:
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   git push -u origin w5c-chat-surface
   gh pr create --base main --head w5c-chat-surface \
     --title "feat(ai): approval-card summary prefers module actionLabel over raw description (#1254)" \
     --body "<scope: 4 contract files + 3 test files, plan link, VF_EXIT=0 (fresh gate DB
     jarvis_gate_1254c, 186 files/1873 tests), no deferred scope>"
   ```
   Note: this is a **server-only, non-UI-facing change** — `action-request-card.tsx` and
   `message-row.tsx` are untouched (confirmed in the plan's seams check). No live-path/UAT proof
   needed per the plan's "Why no new Playwright/e2e case" section — say so plainly in the PR body,
   don't skip the line silently.
4. Report to coordinator (re-resolve pane fresh, label `Coordinator`) via `herdr-pane-message`,
   terse, result-first: PR link, VF_EXIT=0, "Live-path: n/a, no user-facing surface", branch
   pushed/rebased sha, "Deferred: none", "Teardown: none started (no dev instance/seed rows this
   lane), worktree reapable". Then STOP — do not move the board, close the issue, or merge.
5. No dev instance or seeded rows were started this lane — teardown line is just the "none" report,
   not actual cleanup work.

## Relay trigger

Context-meter 70% warning fired again this relay (at 71%) right after the two commits landed — that
is why this handoff exists mid-`coordinated-wrap-up` rather than after full completion. If it fires
again before step 4 completes, write relay 5 from this doc's "Next concrete steps" position.
