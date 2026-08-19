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

## #1698 calendar lifecycle (PR #1703) — live-path proof blocked on dev-environment account state (2026-08-19)

Code is complete: create, reschedule, and delete calendar events all work and have tests, PR
#1703 is up to date. The only thing missing is proving it works end-to-end in the real app, and
that's blocked by two things on the dev instance that need a person, not more coding:

1. One of the connected Google accounts on the dev instance has stale sign-in details — someone
   needs to sign back into Google through the browser on that dev instance.
2. That same account has no real AI provider set up (leftover fake/test ones), so chat won't run
   for it — someone needs to pick and configure a real AI provider for that account.

Not urgent — the code side is done and safe to sit as "code-complete, unverified" per the
live-path rule; nothing is at risk overnight. Ben said tonight to ask Fable if I get stuck rather
than wake him, so I'm pinging Fable rather than his phone for this one. If Fable can't unblock it
either, this should get a `needs-ben` ping in the morning.

## #1319 signed module catalog — needs a real Ed25519 signing keypair from Ben (2026-08-18)

Build (relay4) finished Tasks 1-2 of the approved plan (18/18 + 12/12 unit tests, typecheck clean)
and hit the plan's designed kill gate before Phase 2: it cannot produce the required Phase-1 proof
(a real CI-produced catalog signature that verifies) because the production public-key list
(`MODULE_CATALOG_PUBLIC_KEYS`) is still a deliberately-empty placeholder. Only Ben can close this —
it needs a real Ed25519 keypair with the public half committed in code and the private half landed
as two GitHub secrets before any `workflow_dispatch` publish can self-verify.

<!-- Resolved 2026-08-11: #1560 live-path persona cleanup. Ben ruled: "nova is fine for testing,
yep" — approved leaving `ben@ben.com`'s `assistantName='Nova'` as-is, no restore needed. Ruling
recorded on issue #1560 (https://github.com/motioneso/moss/issues/1560#issuecomment-5255044578). -->

<!-- Resolved 2026-08-12: #1533 chat-surface-build Phase 4 live-path proof blocker. PR #1574
("feat(chat): thread surface through send routing (#1533)") merged 2026-08-12T03:11:37Z — the
real-chat-token gap this entry described is moot now that the PR landed. -->

What's needed from Ben: generate (or approve someone generating) an Ed25519 keypair for signing the
module catalog, then provide the private key material for the two GitHub secrets and confirm the
public key to commit. Not urgent tonight — build is holding cleanly at the gate, no data at risk —
but it blocks all of Phase 2 onward, so it should land soon.

Update: the Phase-1-only PR is posted — https://github.com/motioneso/moss/pull/1684 — explicitly
labeled code-complete/unverified per the live-path gate, not merged and not marked Done. The build
lane has stopped itself (no live session idling on this); Coordinator will spawn a fresh build agent
for Phase 2 once the key lands.

<!-- Resolved 2026-08-05 (PM, via Telegram relay): PR #1379 — Ben ruled delegate the review; QA
lane dispatched. Overnight Codex coordinator pid 1799977 — Ben ruled kill; killed with its MCP
sidecars, verified dead. -->

<!-- Resolved 2026-08-05: Codex grinder lanes (#1246 / #1327) — Ben ruled kill both; sessions
stopped, ruling recorded on issue #1246 and PR #1379. -->

<!-- Resolved 2026-08-11: host disk at 97% (15G free), caused a live ~15-20min ENOSPC blackout of
the coordinator's Bash tool. Root cause found: `docker system df` showed Build Cache at 92.89GB
total / 90.77GB reclaimable — not images, volumes, or the 52 worktrees (only 8.1G combined).
Another agent's earlier `docker system prune` had cleaned images/containers but not build cache.
Ben ruled: run `docker builder prune -f`. Result: 14G → 104G free (97% → 74% used). Resolved, no
further action needed. -->

<!-- Resolved 2026-08-12: Ben ruled "just merge this, tell me how to test there" — merged PR #1574
as 33b722a0f rather than continuing to block on the missing JARVIS_UAT_REAL_CHAT_TOKEN_FILE. Ben
will do the live-path verification himself post-merge; test steps given in the manifest and in
chat. Entry below kept for the historical record, no longer blocking. -->

## RESOLVED 2026-08-11: #1533 live-path proof blocked — missing real-chat UAT credential

**Draft PR open: https://github.com/motioneso/moss/pull/1574** — code-complete, gate green,
sensitive-tier check done, verified via `gh pr view 1574` (draft, correct branch). Build lane is
finished and its worktree is ready for reap. **Only the live-path proof is outstanding —
do not merge, do not mark #1533 Done until it's supplied.**

Repeated drawer-regression UAT reruns (run3 through run7) on #1533 kept failing identically. Root
cause is **not a code defect**: `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` is absent from env, so the
real-chat UAT harness can't authenticate to the live LLM chat endpoint at all — every real-chat
UAT spec fails this way regardless of #1533's own correctness. Coordinator confirmed it also
lacks this token (`env | grep -i JARVIS_UAT_REAL_CHAT_TOKEN` → 0 matches), so cannot self-serve.

Full entry with details lives in the **build agent's own worktree copy** of this file (a
different file — tracked paths aren't shared across worktrees):
`.claude/worktrees/1533-chat-surface-build/docs/coordination/AWAITING-BEN.md`. Mirrored here so
Ben finds it from the canonical run location too.

**Options** (build agent's framing):
1. Ben or a coordinator session with `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` configured runs the two
   UAT specs (`1533-chat-surface-drawer-regression.uat.spec.ts`,
   `1533-chat-surface-live-path.uat.spec.ts`) and hands back the evidence.
2. Manual live-path proof on a live dev instance with real CLI login already in place — browser
   walkthrough per the spec (Job Search → Profile → "Change in chat" → screenshot approval card →
   deny → capture network evidence). Doesn't need the UAT harness at all.
3. Open #1533 as a draft PR now, code-complete, live-path proof outstanding and blocking merge —
   not marked Done, per the live-path-gate invariant.

**Build agent's recommendation:** option 2 if a live dev instance is reachable now (fastest,
matches the spec literally); otherwise option 1. Pinged via `needs-ben` (see
`~/.needs-ben/sent/1786483243535565600.msg`). Everything else in #1533 Phase 4 is done — this is
the only open item. Build agent is waiting event-driven, not polling; coordinator likewise.
