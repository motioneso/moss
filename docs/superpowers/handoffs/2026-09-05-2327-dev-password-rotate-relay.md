# #2327 dev password rotate — relay handoff

Context hit 70% mid-task. Follow `coordinated-build`. Coordinator is currently the agent named
`coordinator` (re-resolve pane fresh via `herdr agent list` / `herdr pane list` before messaging —
do not trust any pane id written in this doc).

## State

- Worktree/branch: this worktree, `build/2327-dev-password-rotate`. Tree is clean, all work
  committed: `687ed0960` (live test files read the password from an environment variable),
  `7df6b8202` (scrubbed the password from 25 handoff docs plus the stray status file),
  `bcdccd058` (new guard script, wired into `verify:static`), `6a3f8e7b3` (pointed the scrubbed
  notes and the live-test error messages at the real place the password lives, instead of a dead
  end that just said "kept outside the repository").
- Guard script `scripts/check-no-dev-password.ts` passes clean on the tree right now (checked
  by hand, twice) and was proven to actually fail when a fake hardcoded password was added, then
  removed again.
- Format, lint, and typecheck all pass clean as of the last commit.
- **The password itself has NOT been rotated.** That step is deliberately on hold — the
  coordinator told me two other lanes still need to sign in to the development instance with the
  current password for their own work, and will send an explicit go-ahead once they're clear.
  Do not rotate until that go-ahead arrives.

## What the coordinator asked for, and where it stands

The coordinator raised three things in the same message. Here is each one and its status:

1. Whether the environment variable change breaks the two other lanes' ability to sign in.
   Answered and sent: manual browser sign-in is unaffected (the actual password has not changed
   yet). Only the four specific test files under tests/live need the new environment variable, and
   nothing on this box sets it automatically — confirmed by checking the shell, its startup
   files, and every system service. The coordinator has this answer already and said they were
   satisfied.
2. A real, findable pointer, not a dead end. The coordinator noticed that a future reader hitting
   the missing-password error, or reading one of the scrubbed handoff docs, would be told the
   password is "kept outside the repository" with no way to actually find it. Fixed in commit
   `6a3f8e7b3`: the four live test files' error message and all scrubbed docs now name the actual
   place — a memory note called dev-instance-lan-spinup-trusted-origins — without printing the
   password itself anywhere.
3. Whether the guard could fire on something innocent (a document that just talks about
   passwords, or an obviously fake example value). Checked by hand: the guard passes clean today
   even though several files in the tree mention "password" near the owner email in fake-example
   or seeded-test-account form. No false positive found.

## Immediate next step — open the pull request

This has not been done yet. Do it next, in this order:

1. Push the branch: `git push -u origin build/2327-dev-password-rotate`.
2. Open the pull request against main. In the description:
   - Summarize tasks 1 through 3 in plain words (test files read the password from an environment
     variable now, the old password is gone from every document, a new automated check stops it
     from coming back).
   - State plainly that the fourth step, changing the actual password, is not done yet and is
     being held back on purpose by the coordinator, because two other people's work still depends
     on the current password. Say this clearly so a reviewer does not mistake it for something
     forgotten.
   - Fill in the release note section. This change is not visible to a person using the product,
     so write that plainly (Category: N/A) rather than leaving it blank.
3. Send the pull request number to the coordinator (re-resolve the coordinator's current pane or
   agent name first, never reuse an old one). Say plainly that it is waiting on an independent
   review by a different model before it can merge, and that the rotation step is still on hold.

## After that — still ahead, do not start early

- Wait for the coordinator's explicit go-ahead before touching the actual password. This has not
  arrived yet as of this handoff.
- Once given the go-ahead: rotate the password on the development instance only (never port
  1533, that is the real live system), using whatever admin script or method the repository
  provides for that.
- Record the new password only outside the repository: update the two existing memory files that
  currently carry the old one in place (the "always loaded" section of MEMORY.md, and the memory
  note dev-instance-lan-spinup-trusted-origins.md), and write a new file under
  ~/.coord-briefs/. Do not create a duplicate memory entry.
- Prove it: sign in to the development instance by hand with the new password, and run at least
  one of the four live test files against it with the new password set only in the shell
  environment (never written to a file), then post that output on the pull request. Never let the
  new password itself appear in the pull request, a commit message, or any file in the repository.

## Rules carried forward

- Plain English in everything a human reads: no jargon, no invented shorthand, plain keyboard
  punctuation, at most one piece of code formatting per sentence. Pass this on to anyone you spawn.
- Sign every message to the coordinator with your own current pane id, re-resolved fresh each time.
- One relay is the budget for this slice. If you also hit the 70% mark before finishing, that
  means this slice was cut wrong — report that back to the coordinator and ask for a re-slice
  instead of relaying again.
- Never merge, move the board, or close the issue. That is the coordinator's job.
