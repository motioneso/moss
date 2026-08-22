# Handoff: finish pull request 1654 (audit-log truthfulness) and get it merged

## What this is

Pull request 1654 fixes issue #1252: the app's audit log can currently say a network action
"succeeded" even when it actually failed. The code fix has been done for days and every automated
check passes. It got stuck because proving the fix works in the real running app depended on a
separate bug (#1659) in the test setup. That bug is now fixed and closed. Nobody has gone back to
finish #1654 since. Ben asked to get this merged as soon as possible.

This is a security-related change (touches audit logging and network-request safety), so it
cannot merge without Ben's explicit sign-off, even once everything else is green.

## Where the work lives

- Existing worktree: `.claude/worktrees/groupA-audit-truth-ssrf-share-tests`
- Branch: `groupA-audit-truth-ssrf-share-tests`
- Pull request: #1654
- Issue: #1252

The branch is currently far behind the main branch (about 500 commits) and needs to be brought up
to date before anything else. It also still contains a revert of a fix for the old blocking bug
(#1659) that has since landed properly on the main branch - when you rebase, that revert pair
should just disappear as a duplicate; if it does not disappear cleanly, stop and flag it rather
than guessing.

## What to do, in order

1. `pnpm install` in the worktree.
2. Fetch and rebase the branch onto the current main branch. Resolve any conflicts using your own
   judgment about the audit-truthfulness fix's intent (read the pull request description on
   GitHub for that intent) - do not guess blindly.
3. Push the rebased branch.
4. Confirm the automated checks are still passing on the rebased version (`gh pr checks 1654`).
5. Produce the live proof this pull request has been waiting on: install and actually exercise the
   audit-truthfulness fix on a live running copy of the app (not just the automated test suite),
   and post that proof as a comment on pull request 1654 through GitHub, including what you ran and
   what you saw. This is what "unblocks" the pull request.
6. Report back that this is done and ready for review. Do not merge it yourself - it needs a
   review pass and Ben's sign-off first, because it is security-related.

## Rules for this worktree

- Do not touch anything under `docs/coordination/` - that is coordinator-only.
- Do not run a repo-wide formatter or a broad `git add`. Commit only the specific files you meant
  to change.
- If you get stuck on something only Ben can decide, say so plainly and stop - do not guess and
  keep going.

Report progress and results in plain, everyday language - no jargon, no invented shorthand. Say
what you did and what happened, the way you'd explain it to someone who does not read code.
