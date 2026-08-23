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

<!-- Resolved 2026-08-12: #1533 live-path proof, PR #1574 merged as 33b722a0f. Ben ruled "just
merge this, tell me how to test there" and did live-path verification himself post-merge. This
section stayed in the file as a live-looking entry past its resolution; removed by the eighth
coordinator on 2026-08-22 once confirmed done. -->

<!-- Resolved 2026-08-22 13:10: Ben ruled "go with your rec" for both open questions below.

Pull request 1838 — treating the failing check as unrelated flaky-test noise (proof: same test,
same line, also failing on an unrelated main-line change, self-recovering the very next run).
Waiver logged in the run manifest. Proceeding straight to security-tier review without waiting
for a fully green run.

Pull request 1654 — spinning up a dedicated lane to chase issue #1252 (the app's assistant
program not starting during the live test) now that it's blocking a security fix. -->

<!-- Resolved 2026-08-22: Ben ruled "yes fix" on pull request 1654's two real problems (the
security regression and the missing approval prompt). The pull request 1654 lane has been sent
back with instructions to fix both, re-run the live test, and post fresh proof before it comes
back for review. -->

<!-- Resolved 2026-08-22 23:02: Ben replied "Yes merge" to the phone ping. Pull request 1838
merged. -->

<!-- Resolved 2026-08-23: Ben replied "yes merge" (typed into the outgoing coordinator's pane).
Pull request 1654 merged (squash), issue #1252 closed, lane reaped. -->

<!-- Resolved 2026-08-23: Ben replied three times ("Yes merge", "I replied to merge 1.5 hours ago,
did you?", "Merge please") to the phone ping about pull request 1862. Merged (squash), issue
#1530 closed, both the build lane and the review lane fully cleaned up (panes closed, work
folders and branches removed). -->

Issue #1511 stays blocked because issue #1246 is still open — not a decision for Ben, just a
status note.

## Open - 2026-08-23: PR #1874 security-tier merge approval

PR #1874 has a final GREEN security QA verdict, green required CI, accepted socket-level live
recovery proof, and no blocking findings. Security-tier policy requires Ben's explicit approval
before merge. Question: may the coordinator merge PR #1874? Recommendation: yes; the remaining
three QA observations are non-blocking follow-up issues.
