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

## #1533 chat-surface-build (build/1533-chat-surface-routing): Phase 4 live-path proof blocked on real-chat token

Everything else in Phase 4 is done: full gate green, sensitive-tier invariant check clean, code
complete. Only the live-path proof (spec's "Live-path proof: action request without reload"
section, `docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md`) remains, and it
cannot be produced from this session.

**What's blocked:** `tests/uat/specs/1533-chat-surface-drawer-regression.uat.spec.ts` and
`tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts:116` both fail — not from a bug in the
#1533 surface-routing code, but because the ephemeral UAT container has no real chat credential.
Live instrumentation (`docker exec cat` on the transcript mid-run) proved the `claude -p` CLI
invocation returns a synthetic `{"error":"authentication_failed","message":{"content":[{"text":
"Not logged in · Please run /login"}]}}` record almost instantly — the transcript-path/RPC
mechanism is working correctly, it's the credential that's missing. Per the #1121 design
(`docs/superpowers/handoffs/2026-07-20-1121-uat-chat-relay-4.md`), real-chat UAT runs are opt-in
via `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` (a GPG-encrypted OAuth token), and a coding session must
*never* touch/view that token — the mandatory real-token run is explicitly meant to happen outside
the build session, run by Ben or a Coordinator. This session's environment has no such token set
(confirmed: absent from `env`), so every real-chat UAT spec will show this same auth failure
regardless of #1533's own code correctness.

**Options:**
1. Ben or a Coordinator session with `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` configured runs
   `pnpm test:uat tests/uat/specs/1533-chat-surface-drawer-regression.uat.spec.ts` and
   `tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts`, captures the network/screenshot
   evidence per the spec's 7-step procedure, and hands the artifacts back for the PR.
2. Do the live-path proof manually against a live dev instance (not the ephemeral UAT stack) where
   real CLI login already exists — per the spec, this is a browser walkthrough (Job Search →
   Profile → "Change in chat", submit, screenshot the approval card within 5s, deny, record
   network evidence) that doesn't strictly require the UAT harness at all.
3. Rule that #1533 can open as a draft PR now, code-complete, with live-path proof explicitly
   marked outstanding and blocking merge — not marking Done per the live-path-gate invariant.

**My recommendation:** option 2 if a live dev instance with working chat is available and reachable
now (fastest, and matches what the spec literally asks for); otherwise option 1, since option 3
still needs someone to eventually do 1 or 2 before merge.

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
