# Relay 2 — w5a-chat-surface (#1449)

**Trigger:** context-meter 70% warning, mid-`coordinated-wrap-up`, no code left to write. Build is
done and committed; only the wrap-up mechanics remain.

**Spec:** `docs/superpowers/specs/2026-08-09-wave-5-chat-surface-correctness.md` (Lane A section) —
don't full-read, section only if needed.
**Plan:** `docs/superpowers/plans/2026-08-09-fix-1449-drawer-rehydration.md` (approved by
coordinator, already committed... no — **still untracked**, prettier-formatted, not yet added to
git. Fine to leave untracked or commit with the PR; not load-bearing).
**Issue:** #1449. Tier: `sensitive`.
**Worktree/branch:** this worktree, branch `w5a-chat-surface`, rebased on `origin/main`.
**Coordinator:** label `Coordinator` — re-resolve fresh via `herdr pane list` (session id rotates;
never reuse an id/pane-number written in any doc). Was told "plan ready, waiting for approval" and
replied "Approved ... Proceed with build" — that's the only coordinator contact so far. **Coordinator
does not yet know the build is done** — that message is still owed.

## Done (verified, not assumed)

1. Plan written and approved (see above).
2. TDD: red confirmed first (4 of 9 tests failed against pre-fix code —
   `pnpm exec vitest run tests/unit/app-shell-chat-surface.test.tsx` from repo root, **not**
   `pnpm --filter @moss/web exec vitest run ../../tests/...` — that form returns "No test files
   found" in this repo; root `vitest.config.ts` is the one that resolves `@moss/*` aliases).
3. One-line fix applied: `apps/web/src/shell/app-shell.tsx` now calls `useChatStream(activeSurface)`
   instead of `useChatStream(activeModuleSurfaceBranded ?? undefined)`. Stale comment above the call
   site rewritten to describe the real behavior (was describing the bug as intentional).
4. Green confirmed: 9/9 in `app-shell-chat-surface.test.tsx`, 11/11 in `use-chat-stream.test.tsx`
   (unchanged, sanity-checked).
5. Committed by **explicit path** (shared checkout — diff-read first, confirmed both files were
   entirely mine): commit `416fb3c2c` "fix: default chat drawer rehydrates approval cards (#1449)",
   exactly 2 files (`apps/web/src/shell/app-shell.tsx`,
   `tests/unit/app-shell-chat-surface.test.tsx`) — verified via `git show --name-only HEAD`.
6. Pre-push trio green: `pnpm format:check && pnpm lint && pnpm typecheck` → `EXIT=0` (had to
   `prettier --write` the plan doc first, one warning, fixed).
7. Rebased cleanly on `origin/main` (`git fetch origin main && git rebase origin/main`) — picked up
   `ba1acd70a` (#1136) and `7fc432f39` (#1055), no conflicts. Commit is now `416fb3c2c` on top of
   those. Re-ran both test files post-rebase: 20/20 green.

## Not yet done — pick up here

Continue `coordinated-wrap-up` (already invoked, mid-procedure) from **step 2**:

1. **Full gate, isolated DB, via `scripts/run-gate.sh`** — NOT yet run. This is the biggest
   remaining risk item; do not hand-roll it (see `verify-gate` / `gate-wait-on-sentinel-not-pgrep`
   memories — `pgrep` liveness checks are a known trap). `scripts/run-gate.sh start` →
   `scripts/run-gate.sh wait` (give Bash a 600000ms timeout) → `scripts/run-gate.sh status`. Read
   the `### FINAL rc=N` line, not a wrapper `echo $?`.
2. **Push + open PR** (only after gate is green):
   `git push -u origin w5a-chat-surface`, then
   `gh pr create --base main --head w5a-chat-surface --title "fix(chat): default drawer
   rehydrates approval cards (#1449)" --body "..."` — body needs: scope, spec link, VF_EXIT
   evidence, the plan link.
3. **Live-path proof** (this is user-facing — the exit criterion is explicit in the plan): seed a
   pending approval row, sign in, open default drawer with no module active, reload, reopen —
   assert the card is present and an API log shows the rehydration fetch fired on mount. Post as
   `gh pr comment`, or report **code-complete, unverified** if no live dev instance is reachable
   (check first whether another lane already has one up — `dev-instance-lan-spinup-trusted-origins`
   memory — before spinning a new one).
4. **Report to coordinator** via `herdr-pane-message` (re-resolve `Coordinator` label fresh, confirm
   exactly one pane, do not reuse any id from this doc): PR link, VF_EXIT, live-path status, branch
   pushed/rebased sha, "ready for QA + merge." Then stop — do not merge, close #1449, or touch the
   board.
5. **Teardown**: if you start a dev instance or seed rows for live-path proof, stop/delete them by
   recorded PID/id before reporting done — never by name pattern (memory:
   `prod-worker-looks-like-a-dev-orphan-in-ps`).

## Relay trigger for successor

Same meter 70% warning. Do not invent a higher threshold. If it fires again before you've pushed +
opened the PR, relay again with an updated doc rather than pushing through degraded.
