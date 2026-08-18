# 1686-ui-polish — relay (context-meter 70%)

**Spec:** `docs/superpowers/specs/2026-08-18-1686-ui-polish.md`
**Plan:** `docs/superpowers/plans/2026-08-18-1686-ui-polish.md` (coordinator-approved)
**Handoff:** `docs/coordination/handoff-1686-ui-polish.md`
**Branch/worktree:** `1686-ui-polish`, `~/Jarv1s/.claude/worktrees/1686-ui-polish`
**Coordinator:** label `Coordinator`, session `1f677d74-7a87-4ee3-a5a4-8066500aefc4` — resolve pane
fresh via `herdr pane list` before messaging.

## Done (all committed, on branch, do not redo)

- Cherry-picked spec+handoff onto this branch: `a7662016f`, `88b7fd96b` (they weren't on
  origin/main yet when this worktree was cut from it).
- Plan written + coordinator-approved: `a749c89a4`.
- Task 1 (sidebar contrast): `a206d25ca`
- Task 2 (Today empty-state copy): `9459772fd`
- Task 3: intentional no-op per spec, nothing to do.
- Task 4 (notifications breathing room): `dfa0fb30a`
- Task 5 (settings appearance margin): `f3b328eea`
- Task 6 (button hover shadow + focus guard): `3c749c11d`
- `pnpm --filter web typecheck` → EXIT=0 (clean).

## Not done yet — pick up here

1. **`pnpm format:check` is red on 4 files:**
   - `apps/web/src/styles.css` — **caused by task 6's edit**, needs `prettier --write` on just
     this file (not repo-wide `pnpm format` — banned in the handoff's run-specific bans).
   - `apps/web/src/styles/tokens.css` — **pre-existing**, confirmed by checking prettier against
     the base commit `4aa0d8777:apps/web/src/styles/tokens.css` (already fails there, before any
     of my edits). Do not "fix" this — out of scope, would touch unrelated lines. Note it in the
     PR body as pre-existing.
   - `docs/superpowers/specs/2026-08-18-1686-ui-polish.md` and the plan md — both pre-existing /
     inherited via cherry-pick, not this lane's to fix; docs aren't part of `pnpm --filter web
     typecheck` scope anyway.
   - **Action:** `pnpm exec prettier --write apps/web/src/styles.css`, verify with
     `pnpm exec prettier --check apps/web/src/styles.css` (expect exit 0), commit that file alone.
2. Run `pnpm lint` (scoped, not full repo if there's a `--filter web` option — check
   `package.json`), fix anything my 7 touched files introduced.
3. Pre-push trio per `coordinated-build` step 3b: `pnpm format:check && pnpm lint && pnpm
   typecheck` (all three, unpiped, check exit codes) + `git fetch origin main && git rebase
   origin/main`.
4. `coordinated-wrap-up`: isolated gate DB run, push, open PR against `origin/main`, live-path
   proof (`gh pr comment` — see the 5 verification bullets in the plan's "E2E / live-path proof"
   section: sidebar contrast, Today empty copy, notifications gap, settings margin, button
   hover-vs-focus-visible distinction), report PR + evidence to coordinator. Do NOT merge, touch
   the board, or close #1686 — coordinator's job.

## Gotcha hit this session — do not repeat

`git stash` / `git stash pop` in this shared checkout: running plain `git stash` when your own
tree is already clean does nothing useful, but a subsequent `git stash pop` will pop *whatever's on
top of the shared stash stack* — which may belong to a completely different lane/branch (hit a
real conflict with an unrelated `1265-module-content-self-operation` stash here). **Never use `git
stash` in this repo** — if you need to check "is this format failure pre-existing," diff against a
base commit with `git show <sha>:<path> > /tmp/x` instead, as done above. If you ever do pop a
stray stash by accident: check `git stash list` — if the conflicting entry is still listed, it
wasn't dropped; `git reset --hard HEAD` cleans your tree without touching the stash list.
