# Build Handoff — 1141-credential-env-isolation

**GitHub issue:** #1141 — no separate spec doc; scoped security fix, build off the issue text
(the issue fully specifies the fix). Read `gh issue view 1141` first.
**Risk tier:** `security` — credential-env leakage. Gets adversarial Opus QA + **Ben's explicit
merge sign-off** — no delegated sign-off assumed tonight.
**Scope (from Phase-0 analysis):** `packages/chat/src/live/provider-probe.ts:44-49` — an empty
`credentialEnv` object (`{}`) is truthy, so `io.run`'s merge falls through to ambient
`process.env` instead of an isolated env. Pass an explicit minimal env (`HOME`/`PATH`) the way
`terminal-session.ts:46-50` already does — mirror that pattern. Verify current code first.
**Worktree:** `.claude/worktrees/1141-credential-env-isolation` **Branch:** `1141-credential-env-isolation` (off `origin/main`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1141` for full scope.
3. **Plan-authorship rule (standing, non-negotiable tonight):** you do NOT approve your own plan.
   Write a short plan per `plan-build`, message the `Coordinator` label with the pointer, and
   STOP. The coordinator routes it to Fable for review; wait for explicit "approved" before code.
4. Once approved: TDD build, commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving no ambient env var leaks into the probe subprocess when `credentialEnv` is absent.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Touches a live chat-provider path — if it's reachable through the UI, get live-path proof; if
  it's purely internal probing with no user-facing surface, say so explicitly in the PR instead.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- Phase-0 flagged `packages/chat/src/live/*` is also touched by #1467 tonight, but on disjoint
  files (this lane: `provider-probe.ts`; #1467: `claude-permission-hook.ts`). Confirmed against
  #1556's file set too — no overlap.
