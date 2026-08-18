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

## #1319 signed module catalog — needs a real Ed25519 signing keypair from Ben (2026-08-18)

Build (relay4) finished Tasks 1-2 of the approved plan (18/18 + 12/12 unit tests, typecheck clean)
and hit the plan's designed kill gate before Phase 2: it cannot produce the required Phase-1 proof
(a real CI-produced catalog signature that verifies) because the production public-key list
(`MODULE_CATALOG_PUBLIC_KEYS`) is still a deliberately-empty placeholder. Only Ben can close this —
it needs a real Ed25519 keypair with the public half committed in code and the private half landed
as two GitHub secrets before any `workflow_dispatch` publish can self-verify.

What's needed from Ben: generate (or approve someone generating) an Ed25519 keypair for signing the
module catalog, then provide the private key material for the two GitHub secrets and confirm the
public key to commit. Not urgent tonight — build is holding cleanly at the gate, no data at risk —
but it blocks all of Phase 2 onward, so it should land soon.

Update: the Phase-1-only PR is posted — https://github.com/motioneso/moss/pull/1684 — explicitly
labeled code-complete/unverified per the live-path gate, not merged and not marked Done. The build
lane has stopped itself (no live session idling on this); Coordinator will spawn a fresh build agent
for Phase 2 once the key lands.

