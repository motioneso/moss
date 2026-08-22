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

## Pull request 1838 (issue #1529, security-sensitive fix) — automated checks have now failed twice

This is a sign-in and permissions fix, so it needs to be extra careful before it merges. Its
automated checks failed once already (two new fake test accounts had ID numbers already used by
other test files, which is not a security problem, just a collision) - that got fixed and
re-checked. The re-check has now also come back failed. The rule for a change this sensitive is
that a second failed check means stop and get a ruling rather than trying a third time.

Update: the team reported back, and I checked their claim myself against the real logs. Both
failures are the exact same browser test, failing at the exact same line - a chat window test
waiting for the text "Tick 2" to appear on screen. I found that same test failing, at that same
line, on a totally unrelated change that had just landed on the main line of the project, with
nobody's work involved. This pull request only ever changed two ID numbers in a database test
helper file - nothing to do with chat or that test. The very next change after that one passed
fine, so this looks like a test that fails on its own sometimes (flaky), not one that is always
broken, and not one this pull request has any hand in.

Options:
1. Treat this failure as unrelated noise and let this pull request go on to its security review
   without waiting for a fully green run - I'd log the exact failing run as the proof for skipping
   it, so anyone reading the pull request later can see why.
2. Have the team (or someone else) fix the flaky test itself first, then re-run, even though it's
   outside the scope of this fix.
3. Your call.

My recommendation: option 1. The evidence is solid - same test, same line, failing on an unrelated
change, self-recovering on the very next run - and pinning down the fix would be entirely separate
work.

## Pull request 1654 — security fix cannot get its required live proof, real bug in the way

The security fix itself (audit-logging honesty plus outbound-network safety) hasn't changed since
it was last checked over, and every automated check passes. But before it can merge, the rule is
it must be proven working end-to-end in a real running copy of the app, and that proof keeps
failing for a reason unrelated to this fix: when the live test tries to have a conversation with
the app's AI assistant, the assistant program never actually starts, so the conversation times out
before it ever reaches the code this pull request is supposed to prove. The lane tried running that
same start-up command by hand outside the app, and it worked fine — so it's something in how the
app itself launches that program, not a broken command. This is the same underlying problem as
open issue #1252.

Options:
1. Pause pull request 1654 until #1252 (the assistant program not starting) is understood and
   fixed, then re-run the live proof. Safest, but 1654 stays unmerged with no clear timeline.
2. Have a lane specifically chase down #1252 now, in parallel, since it's now blocking a
   security fix and not just a general bug.
3. Ben decides some other form of live proof is acceptable for 1654 given the code hasn't changed
   and only the automated test harness is failing — but this needs to be his call since it means
   accepting less than the usual live-path evidence on a security-tier change.

My recommendation: option 2 — this bug is now blocking a security fix, not just a general
annoyance, so it's worth a dedicated lane rather than waiting for it to come up naturally.
