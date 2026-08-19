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

## PR #1691 (#1138 weather SSRF hardening) — security-tier merge sign-off (2026-08-19)

Opus adversarial QA came back GREEN: all four findings (#12, #13, #17, #18) implemented with
regression tests, CI green, no blocking issues, no new security vulnerability. Verdict posted to
the PR: https://github.com/motioneso/moss/pull/1691#issuecomment-5336821507

4 non-blocking follow-ups noted (not blockers, worth filing separately): a malformed-but-valid
upstream JSON shape still returns a generic 500 instead of degrading; two of the three outbound
fetches (weather lookup, IP geocoding) still lack a timeout — only the background upgrade-check
has one; the private-IP guard only covers IPv4 dotted-quad forms, misses IPv6 private ranges (not
an SSRF risk — fixed host — but an info-disclosure gap); and no response-size cap on any of the
three JSON parses.

What's needed from Ben: this is security tier, so it needs your explicit go-ahead before merge —
QA green alone doesn't merge it. Recommendation: merge as-is (findings are real hardening, non-
blocking gaps are pre-existing or narrow) and file a follow-up issue for the 4 non-blocking notes.
Reply "merge #1691" (or similar) and Coordinator will merge + file the follow-up.

