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

## Two new specs ready to queue — need your OK before spawning

Main CI is resolved — you waived the flaky test ("Waive is fine", 2026-08-17) and it's recorded as
a CI waiver in the run manifest. That was the only thing blocking this ask.

Ben approved specs for #1319 (sign and verify the module distribution index) and #1586 (Moss
self-diagnostics) on 2026-08-17. Both now have manifest queue entries (tier, worktree/branch plan)
— nothing has been spawned yet, still waiting on your go-ahead:

- **#1319** — security tier, no blockers, ready to spawn as soon as you say go.
- **#1586** — security tier (upgraded from the first "likely sensitive" guess — it adds a shared
  field other modules can plug into, and its news-refresh action writes through the same
  audit-logging code as the audit-truthfulness work already in flight). Issue relabeled security
  on GitHub already. Even after you approve it, it can't start building until PR #1654 lands —
  same blocker the in-flight audit-truthfulness lane is already stuck on, not a new wait.

Say go and I'll spawn #1319 immediately and queue #1586 to start the moment PR #1654 lands.
