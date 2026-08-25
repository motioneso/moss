# Relay handoff — issue #1951 (chat transcript archive, backend half)

## State
- No live coordinator on this lane (fleet-daemon brief) — report via fleetctl, not
  herdr-pane-message.
- Spec already exists as the SPEC comment on issue #1951 (backend-only slice of #1368). Full
  plan written and committed at
  docs/superpowers/plans/2026-08-25-chat-archive-backend.md — read that file in full before
  doing anything else. It has every task's exact signatures, file paths, and the resolved
  filename-collision design decision. Do not re-derive it.
- Worktree: this one. Branch fleet/lane-1951. pnpm install already done, node_modules present —
  skip that Start step.
- Untracked, uncommitted files (not yet added to git):
  - docs/superpowers/plans/2026-08-25-chat-archive-backend.md (the plan — keep as is)
  - tests/unit/chat-archive-folder-validation.test.ts (task 1's test, 8 cases; confirmed RED
    against a missing function)
  - packages/shared/src/chat-archive-api.ts (task 1's implementation — has one known bug, fix
    first, see below)

## Known bug to fix before running tests again
Open packages/shared/src/chat-archive-api.ts and find the function validateChatArchiveFolder.
Inside it there is a check meant to reject a folder name that contains a null byte. As written,
that check tests whether the input contains a plain space character, not a null byte, so it will
never catch the case it is supposed to catch. Fix it so the check actually tests for character
code zero (in JavaScript, the escape sequence for that is backslash, u, four zeros). Do not type
a literal invisible byte into the source file by hand — that is exactly what produced the bug in
the first place (a literal space was pasted where a literal null byte was intended, and they look
identical in an editor). Use the explicit escape-sequence form so the fix is visible in the diff
and cannot be silently swapped again.

The test file (tests/unit/chat-archive-folder-validation.test.ts, the "rejects an embedded null
byte" case) already contains a real, working null byte in its string literal — checked this
session with a hex dump, confirmed byte value zero right after the word "Chats". That test case
is correct as-is. Only the implementation needs the fix.

## Next action for successor
1. Fix the bug described above.
2. Run: npx vitest run tests/unit/chat-archive-folder-validation.test.ts
   Confirm all 8 cases pass (this is the GREEN step of task 1's TDD cycle — not reached yet).
3. Commit task 1 (path-scoped add, not add -A):
   git add packages/shared/src/chat-archive-api.ts tests/unit/chat-archive-folder-validation.test.ts docs/superpowers/plans/2026-08-25-chat-archive-backend.md
   then commit.
4. Continue with task 2 in the plan (packages/settings/src/chat-archive-routes.ts), same
   TDD-per-task rhythm: write the test, watch it fail, write minimal code, commit, move on.
5. Follow the plan file task by task through task 10, then run coordinated-wrap-up per the brief
   (push, open PR, post a live-path proof comment whose first line is exactly LIVE-PATH PROOF,
   then node /home/ben/jarv1s-fleet/fleetctl.mjs set 1951 status=pr-open pr=<number>).

## Verified seams — do not re-research
Everything under "Verified seams" and "Open design decision" in the plan file was checked live
against this branch on 2026-08-25, with exact file and line citations. Trust it. Only re-check a
citation if what you see in that file clearly does not match what the plan says (drift from
something merged in the meantime).

## Reminder from the brief (binding)
- Never run pnpm verify:foundation or any database-touching test outside the verify-gate skill.
  Plain unit tests like task 1's are fine to run directly with npx vitest run <file>.
- Never pipe a gate command; always capture the exit code.
- Plain English in every PR description, blocked reason, log message, and any spawn prompt — no
  jargon, plain ASCII punctuation. Pass this rule to anything you spawn.
- One relay total is the budget. This is relay number one. If you also hit the context warning
  without an open PR, stop and report a re-slice need to fleetctl (a blocked_reason starting with
  "needs re-slice:") instead of relaying again.

## fleetctl
Not yet called relays=+1 for this lane — call it as the last step of this handoff.
