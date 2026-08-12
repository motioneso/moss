# Awaiting Ben

Decisions that need Ben and only Ben. Each entry says what is blocked and what the options are.
Remove an entry once he rules and the ruling is recorded where the work lives.

**Protocol (mandatory since 2026-08-05):** no agent idles waiting on Ben without doing BOTH of:

1. Add an entry here — what is blocked, the options, your recommendation.
2. Ping his phone: `needs-ben <your-agent-name> "<one-line question>"` (on PATH box-wide;
   works from any harness — it queues to a Telegram daemon that dedups and rate-limits).

The 2026-08-05 transcript audit found 216 idle hours blocked on Ben, mostly on questions this file
never recorded — an overnight coordinator sat 15h on a question while this file said nothing was
pending. Silent waiting is the failure mode this protocol exists to kill.

The two 2026-07-27 entries that lived here before (the live-path gate, and the voice/STT spec
approval) are both resolved and were removed on main — the live-path gate was adopted and is now a
hard invariant in `CLAUDE.md`, and the voice/STT spec turned out to be already approved and built
(#874), only its status line was stale.

<!-- Resolved 2026-08-11: #1560 live-path persona cleanup. Ben ruled: "nova is fine for testing,
yep" — approved leaving `ben@ben.com`'s `assistantName='Nova'` as-is, no restore needed. Ruling
recorded on issue #1560 (https://github.com/motioneso/moss/issues/1560#issuecomment-5255044578). -->

<!-- Resolved 2026-08-09: `git push origin main` blocked by the auto-mode classifier during Wave 2
wrap-up. Ben re-ran ("try now") and it went through — pushed 39 commits, `f78992b14..46ec9965d`.
Note: GitHub reports this repo moved to `motioneso/moss.git`; push still succeeded via the old
remote URL (auto-redirected), not yet acted on beyond noting it. -->

<!-- Resolved 2026-08-09: CI waiver for PR #1479 (#1207), first in Wave 2 merge order. Ben ruled
(a) — approved the fable-proxy's scoped waiver (2 UAT specs, pre-existing Moss-rename locator
break tracked as #1481, unrelated to this diff). Ruling recorded on the manifest row (`gh pr
comment` stayed blocked by the auto-mode classifier all session, so the paper trail lives in
`docs/coordination/2026-08-08-non-feature-wave-2.md` instead of on the PR). Separately, `gh pr
merge`/`git commit` were ALSO blocked by the classifier for this session — Ben granted scoped
merge permission directly in chat ("you can merge any PR, not just 1479"); all four ready Wave 2
PRs (#1479/#1207, #1480/#1155, #1478/#1115, #1477/#1433) merged squash, worktrees+branches
cleaned up, manifest fully updated to `merged`. Wave 2 complete. -->

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

## OPEN 2026-08-11: #1533 live-path proof blocked — missing real-chat UAT credential

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

