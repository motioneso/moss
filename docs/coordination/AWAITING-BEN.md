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

## #1560 live-path persona cleanup

The #1560 live-path proof temporarily set `ben@ben.com`'s `assistantName` to `Nova`, but the lane
did not record the prior value and `persona.bundle` has no audit history. The temporary briefing row
was deleted and verified absent. Please choose the value to restore, or approve leaving `Nova`.
Recommendation: provide the intended name rather than guessing or clearing personal data.

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
