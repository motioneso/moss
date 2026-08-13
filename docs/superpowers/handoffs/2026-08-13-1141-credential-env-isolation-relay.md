# Relay — #1141 credential-env isolation

**Handoff origin:** `docs/coordination/handoffs/2026-08-13-1141-credential-env-isolation.md`
(commit `0736e2d37` on `coord/overnight-20260810` — not on this branch, read via `git show`).
**Issue:** #1141. **Risk tier:** security. **Branch/worktree:** this one, `1141-credential-env-isolation`.
**Coordinator:** Herdr label `Coordinator` (re-resolve pane fresh — do not trust any `…-N` written
here; confirm via session id `caef4e32-df22-4310-a42d-866771a0ba6c` if ambiguous).

## Status

Plan written and committed at `33f4b4832`:
`docs/superpowers/plans/2026-08-13-1141-credential-env-isolation.md`.

Plan-ready escalation already sent to the Coordinator (delivered — see `herdr pane read` to check
for a reply). **No code has been written yet.** Per the handoff's non-negotiable rule, do NOT write
code until the Coordinator approves (or explicitly says proceed) — check for a reply first.

## What's left

1. Check for the Coordinator's reply (approve / fork flag). If no reply yet, re-send a short nudge
   or wait — do not build unapproved.
2. Once approved, execute `docs/superpowers/plans/2026-08-13-1141-credential-env-isolation.md`
   Phase 1 via `superpowers:test-driven-development`, reading the plan **by section**, not in full
   (you already have the plan's content available from this doc's origin — re-reading it in full
   on boot is what caused prior relays in this run to burn context on reads instead of builds):
   - Edit `packages/chat/src/live/provider-probe.ts` per the plan's Decisions section.
   - New `packages/chat/src/live/provider-probe.test.ts` — 4 test cases per plan (regression proof
     is the primary one — a poisoned ambient `HOME` via `vi.stubEnv`).
   - Edit `packages/cli-runner/src/main.ts:207` and `packages/cli-runner/src/engine-host.ts:640-642`
     to thread `homeBase`.
   - Run the plan's Verification section commands (all unpiped, exit codes stated).
3. Commit per task, not as one giant commit.
4. Self-monitor context — relay again on the 70% meter warning, same trigger as this relay.
5. On completion: `coordinated-wrap-up` — gate via `verify-gate` skill (isolated gate DB), push
   after pre-push trio + rebase, open PR tagged `[SECURITY]`, state explicitly in the PR that this
   is an internal security-boundary fix with no new UI surface (live-path gate's "purely internal"
   carve-out — no UAT spec applies), report to Coordinator. **Never merge, never touch the board,
   never close the issue** — Ben gives explicit merge sign-off on this tier.

## Key facts (don't re-derive — verified this session against current tree)

- `provider-probe.ts:44-49` — `probeClaudeAuth` treats `credentialEnv` as a truthy/falsy switch;
  `readProviderCredentialEnv` returns `{}` (truthy, empty) for any identity with no persisted
  token — that's the exact input that defeats the current check.
- Both `TmuxIo` adapters (`createRealTmuxIo` in packages/ai, `createSanitizedTmuxIo` in
  cli-runner) spread `opts.env` last over a base env, but neither one sets `HOME` on its own — the
  "sanitized" adapter's base still allowlists `HOME`/`PATH` from the calling process's own env
  (`sanitized-env.ts` `ALLOWED_KEYS`), so it isn't actually isolating identity.
- Fix pattern already correct elsewhere: `terminal-session.ts:46-50` layers explicit
  `HOME: opts.homeBase` over a sanitized base — mirror this in `provider-probe.ts`.
- Both call sites (`main.ts` `LoginService.probe` callback, `engine-host.ts`
  `CliChatEngineHost.probeProvider`) already have `homeBase` in scope; only need to thread it
  through as one new field each.
- Scope excludes `PATH`, codex/gemini probes, and `chat-multiplexer.ts`'s separate
  `checkAnthropicProviderWithClaudeAuthStatus` (host-dev RPC-fallback path, no `credentialEnv`
  involved) — all deliberately out of scope per the issue/handoff; rationale is in the plan.

Full technical detail (exact signatures, env-merge expression, all 4 test cases, verification
commands) is in the committed plan — read that by section when you reach the matching step, not now.
