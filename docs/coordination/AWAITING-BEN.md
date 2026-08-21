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

<!-- Resolved 2026-08-19: PR #1703 (calendar rebuild) and PR #1717 (all-day scheduling) both merged.
Ben ruled "let's just merge all of these, I'll test in prod" — live-path proof on the dev instance
is no longer the gate for this batch. -->

<!-- Resolved 2026-08-11: #1560 live-path persona cleanup. Ben ruled: "nova is fine for testing,
yep" — approved leaving `ben@ben.com`'s `assistantName='Nova'` as-is, no restore needed. Ruling
recorded on issue #1560 (https://github.com/motioneso/moss/issues/1560#issuecomment-5255044578). -->

<!-- Resolved 2026-08-12: #1533 chat-surface-build Phase 4 live-path proof blocker. PR #1574
("feat(chat): thread surface through send routing (#1533)") merged 2026-08-12T03:11:37Z — the
real-chat-token gap this entry described is moot now that the PR landed. -->

<!-- Resolved 2026-08-19: #1319 signed module catalog. Ben generated the Ed25519 keypair, set the
two GitHub secrets, and shared the public key. Public half committed to PR #1684
(commit 851f9ba70). Real publish/verify proof confirmed (verified: true, key moss-catalog-2026-a).
Ben approved merge; PR #1684 merged. -->

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

<!-- Resolved 2026-08-20: #1524 sports follows migration-runner DELETE question. Ben ruled: add
"delete rows" to the shared migration allow-list (packages/db/src/migrations/module-sql-runner.ts).
Lane unblocked. Ben also asked to leave issue #1524 open after merge -- he's planning more sports
follows work and will file a separate new issue for it rather than folding it into this one. Full
note in docs/coordination/1739-stage1-workshop-run.md. -->

## OPEN 2026-08-21: #1526 (PR 1803) — one test keeps failing in CI, not on the lane's own machine

The terminal socket backpressure fix itself looks done and pushed. But one specific test (the one
that checks the connection closes properly) has now failed the same way twice in a row on GitHub's
CI, while it passes every time when run locally. A reviewer (Fable) looked at the test and believes
it is the test itself that's flaky — timing-sensitive, sometimes doesn't notice something happen in
time — not a real bug in the fix.

**Options:**
1. Rewrite the flaky test to not depend on timing (the fix the reviewer recommends) — safest, but
   needs someone to do it and re-run CI.
2. Ben looks at the CI failure directly and makes the call.
3. Retry CI a third time — **not recommended**, the standing rule here is two identical failures
   means stop and think, not try again.

**Recommendation:** option 1. Pinged via `needs-ben`.

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
