# Overnight handoff — dev-environment build (issue #1258)

Ben is heading to bed and will not have his phone on. **Fable has final call on anything that
would normally need Ben's decision tonight.** Do not sit idle waiting on Ben.

## What's running

**build-1258-phase1** — a background agent working on issue #1258 (the `pnpm dev:instance` CLI
that keeps AI chat working after a database reset). Branch: `build-1258-dev-instance-provisioning`,
in the shared checkout at `~/Jarv1s`. Message it by name with SendMessage to check status or give
direction.

Progress so far: Phase 1 complete and committed (7 tasks, doctor checks). Phase 2 in progress —
the secret-file reader and the settings reader are done and committed. It just wrote (uncommitted)
the piece that creates the admin account and the piece that sets up the AI provider/model rows, plus
a test file for both.

**Current blocker, being actively debugged by the agent itself, not escalated:** running the new
tests against a real database, 7 of 8 failed. All 7 fail the same way — writing the AI-provider row
gets rejected by the database's row-level-security policy, meaning the write is happening as the
wrong actor. This is a bug in the agent's own database-access-context wiring for that step, not a
design question — it does not need a decision, just a fix. It said it would report back once fixed
or if it gets stuck.

## What to do

- If build-1258-phase1 reports the bug fixed and tests passing: let it continue through the rest of
  Phase 2, then Phase 3 (file-side provisioning) and Phase 4 (the actual `pnpm dev:instance`
  command entry point, fix/wiring/docs). Keep nudging for real status if it goes quiet more than
  ~30–45 minutes without a commit.
- If it reports being genuinely stuck (not just slow) or hits a real design fork (like the one
  build-1418 hit today), route that decision to Fable instead of waiting for Ben.
- Do not merge or mark #1258 done overnight without the live-path gate (real UI proof) and the full
  verification gate — see CLAUDE.md and `docs/DEVELOPMENT_STANDARDS.md`. If it reaches a
  code-complete state overnight, leave it as a green PR with a clear report rather than merging
  solo on a user-facing feature — check with Fable first since it's a judgment call about whether
  the live-path gate has actually been satisfied.

## What's already done tonight (no action needed)

- Issue #1120 (module-sdk browser-safety fix) — merged, PR #1760.
- Issue #1463 (Moss-rename sweep in external modules) — merged, PR #1758.
- Issue #1418 (finance module type-check fix, moved finance to the modern rendering style per
  Ben's decision) — merged, PR #1761.

## One thing Ben flagged

He noticed build-1258-phase1 wasn't showing up in his Herdr pane view until he specifically asked
for its status, then asked me to confirm it's not a Herdr pane at all — it's a background subagent
dispatched from this coordinating session (not visible in the pane list the way a normal Herdr
session is). Worth being aware of if Ben asks about it again later: it's real work, just not
visible in the same UI as the other panes.
