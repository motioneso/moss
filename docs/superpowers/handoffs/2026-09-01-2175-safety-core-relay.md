# Relay handoff — build-2175-safety-core

Original handoff: `docs/superpowers/handoffs/2026-09-01-2175-safety-core.md`
This is relay 1 of 1 (budget is one — do not relay again; if you also hit the 70% trigger with
no PR open, message the coordinator and ask for the lane to be re-sliced instead).

Worktree: `~/Jarv1s/.claude/worktrees/2175-safety-core`
Branch: `build/2175-safety-core` (clean, plan doc committed at `8c9e6406a`)
Coordinator: confirmed sole live agent named `coordinator`, pane `w1:p7M` (re-verify with
`herdr agent list` before messaging — pane numbers reflow).

## State

No source code written yet. Only research and planning happened so far:
- Read the spec, the plan (Tasks 1-4 sections plus Task 8), and every file Tasks 1-4 touch.
- Wrote and committed the build plan: `docs/superpowers/plans/2026-09-01-2175-safety-core-build.md`.
  It has the seams check (file:line citations proving every spec premise still holds on this
  branch), and concrete signatures/DDL/test cases for all four tasks.
- **The plan has NOT been sent to the coordinator for approval.** That is your first action.

## Your first action

Message the coordinator (`herdr-pane-message`, pane `w1:p7M`, confirmed by name `coordinator`)
with:
1. A pointer to `docs/superpowers/plans/2026-09-01-2175-safety-core-build.md`.
2. The three open items at the bottom of that plan file, asked plainly:
   - Is SQL migration number `0208` free, or has another lane already claimed it?
   - Are the plain-success envelope summaries ("Action performed successfully." / "Read
     succeeded.") acceptable wording?
   - Should the new one-line prompt rule apply to every chat surface, not just the default one?
3. Your own immutable session id and registered agent name (find them with `herdr agent list`
   matched on your own pane).
4. Signed with your own pane id.

Then **STOP and wait for approval before writing any code** — this is a hard gate from the brief.

## After approval

Build Tasks 1-4 in order with `superpowers:test-driven-development`, one task per commit, explicit
`git add <files>` only (never `-A`/`.`), `Co-Authored-By: Claude` trailer on every commit. The plan
doc has everything: exact file paths, widened types, the `call-memory.ts` API, the SQL migration,
the `routes.ts`/`repository.ts` plumbing points, the system-prompt insertion point, and unpiped
verification commands with expected exit codes.

Read the spec/plan by section only, never front-to-back again — you already have the grounding in
the committed plan doc; re-reading the source specs in full would just burn your budget for no new
information.

When Tasks 1-4 are green: pre-push trio (`format:check && lint && typecheck`, then rebase on
`origin/main`), then `coordinated-wrap-up` — gate via the `verify-gate` skill (never improvised,
never unscoped, never piped), push, open PR, and report to the coordinator. The kill gate (a live
check with Ben on the real dev instance, never port 1533) happens after your PR is reviewed —
that's the coordinator's call to arrange, not yours to force.

Never merge, close the issue, or touch the project board.
