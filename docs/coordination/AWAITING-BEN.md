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

## OPEN 2026-08-11: host disk at 97% (15G free), caused a live ENOSPC failure

Coordinator's own Bash tool went fully non-functional for ~15-20 min this evening — every
invocation failed with `ENOSPC` on the session's `/tmp` task-output filesystem (0MB free). It
recovered on its own (host must have freed some space, or another session's cleanup landed), but
`df -h /` still reads 413G size / 377G used / **15G avail / 97% use**. `git worktree list` shows
**52 worktrees** under `.claude/worktrees/`, several 200MB-1.5GB each (largest:
`1533-chat-surface-build` 1.5G, `w5b-chat-surface` 722M). This is a host-wide resource problem,
not scoped to one session — it can recur and take down any lane's Bash tool mid-run, not just
mine.

**What's blocked:** nothing right now (Bash recovered), but this is a live risk to the rest of
tonight's run, not a hypothetical.

**Options:**
(a) Ben frees disk directly (host-level: old Docker images/volumes, other reap-eligible
worktrees, log rotation) — fastest, no agent risk.
(b) Coordinator runs a careful reap sweep of clearly-stale/merged-PR worktrees only (the same
4-gate reap-safety check already used for #1547/#1121 this run: idle pane, no orphan processes,
clean git status, PR already merged) — slower, and I'd need to cross-reference all 52 against
live lanes in the manifest before touching any, since most are other sessions' in-flight work.
(c) Do nothing until it recurs — not recommended, this already caused one ~15-20min blackout of
the coordinator's own tooling tonight.

**Recommendation:** (a) if Ben's available now (fastest, zero risk to in-flight lanes); otherwise
(b) once the run reaches its next natural stopping point (currently waiting on #1533 to land,
which triggers a full cleanup sweep already planned for other reasons).
