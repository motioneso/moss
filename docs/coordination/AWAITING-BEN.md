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

## Open: #1319 plan review — 4th round in a row still red, should the lane pause?

#1319 (signed module catalog) has now been through 4 rounds of plan review. Each time, the build
agent correctly fixed everything flagged in the prior round — but the fix work itself introduced a
fresh batch of problems, so the plan has never come back clean. Round 4 fixed all 5 things round 3
flagged, but review found 4 new blocking issues (the browser-side override flow is still broken by
a different bug than before, one more missed spot in the server code, and a possible mismatch
between two data snapshots), plus some smaller stuff.

This isn't a case of the build agent doing sloppy work — the fixes are genuinely correct each
time. It's more that the plan keeps growing new edges as it gets patched. My read: four rounds of
"fix what's flagged, find something new" is a pattern, not bad luck, and a 5th round risks the same
thing happening again.

Options:
1. Let it run a 5th round anyway (same process, another Opus review after).
2. Pause the lane and have someone take a fresh, non-incremental pass at the plan instead of
   patching it round by round — likely faster than another iterative cycle.
3. Something else you'd prefer.

I'd lean toward option 2, but this is your call. Build agent is holding, not making further
changes, until I hear back.
