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

## Main CI red, twice, same failure — post1632-queue run

Main went red at commit `cd08ed79c` (PR #1671 merge): `chat-drawer-surface.test.tsx` "resets state
on a flip in both directions" failed. Coordinator (take 41) reran the failed job to check for the
known flake pattern (issue #1607 — this exact test fails full-suite-only, passes in isolation,
unrelated to whatever PR triggered it). The rerun failed again with the identical test, line, and
assertion. That's two reds at the same commit, not a red-then-green, so it doesn't clear the bar
the flake theory needs to self-resolve automatically.

**What's blocked:** whether to treat main as green (waive this check) and resume merging new work,
or hold everything until the flake itself is fixed.

**Options:**
1. Waive it — the failure signature matches the known flake exactly and PR #1671's own diff
   (notes/path-guard change) doesn't touch this test or its surface. Record a CI waiver in the
   run manifest and resume.
2. Hold — spin up a lane to actually fix the flake (issue #1607) before trusting main's gate again.
3. Try one more rerun to see if it's simply intermittent enough that two-in-a-row can still happen.

**Coordinator's recommendation:** option 1 (waive) — the evidence strongly matches the documented,
pre-existing pattern and the merged PR doesn't touch that code path, but two-same-way failures is
the stop-the-line threshold in the CI waiver protocol, so this needs your sign-off rather than a
unilateral coordinator call.

No new build agents are being spawned onto main (including the two new issues below) until this
is resolved.

## Two new specs ready to queue — need your OK before spawning

Ben approved specs for #1319 (sign and verify the module distribution index — security tier) and
#1586 (Moss self-diagnostics — likely sensitive tier, re-deriving from the spec) on 2026-08-17.
Neither has a build agent spawned yet. Once main CI is resolved (see above), the coordinator will
add both to the run manifest with tier + worktree/branch plan and present it here for sign-off
before spawning either.
