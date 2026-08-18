# Awaiting Ben

Decisions that need Ben and only Ben. Each entry says what is blocked and what the options are.
Remove an entry once he rules and the ruling is recorded where the work lives. **This file tracks
only currently-open questions — not a historical log.** Resolved entries are removed outright; the
full record survives in git history (`git log -p -- docs/coordination/AWAITING-BEN.md`).

**Protocol (mandatory since 2026-08-05):** no agent idles waiting on Ben without doing BOTH of:

1. Add an entry here — what is blocked, the options, your recommendation.
2. Ping his phone: `needs-ben <your-agent-name> "<one-line question>"` (on PATH box-wide;
   works from any harness — it queues to a Telegram daemon that dedups and rate-limits).

The 2026-08-05 transcript audit found 216 idle hours blocked on Ben, mostly on questions this file
never recorded — an overnight coordinator sat 15h on a question while this file said nothing was
pending. Silent waiting is the failure mode this protocol exists to kill.

## PR #1675 (#1528, account-state error text) — security-tier merge sign-off

QA came back green and merge-ready. This is a security-tier PR, so it needs your explicit go-ahead
before it merges — nothing auto-merges here by design.

What it does: when a login attempt hits an account that's pending approval or deactivated, the
server now returns a clear, specific error message instead of a generic one, and gate/tests are
green with no security or leak issues found.

Recommendation: safe to merge.

PR: https://github.com/motioneso/moss/pull/1675
QA writeup: https://github.com/motioneso/moss/pull/1675#issuecomment-5321812388
Manifest: docs/coordination/post1632-queue-2026-08-16.md, "Take 38 — QA verdict, #1528/PR #1675"

(post1632-queue, take 38 coordinator, 2026-08-17)
