# Build Handoff — 1467-permission-boundary-shell-quote

**GitHub issue:** #1467 — no separate spec doc; scoped fix, build off the issue text + the
Phase-0 collision map's pointer below. `gh issue view 1467` first.
**Risk tier:** `security` — permission boundary + shell-quoting on a live chat surface. Gets
adversarial Opus QA + **Ben's explicit merge sign-off**.
**Scope (Phase-0 collision map pointer):** `packages/chat/src/live/claude-permission-hook.ts` +
`vault-allowlist.ts`. Read the issue for the exact acceptance criteria; the collision map only
located the files, it did not resolve the fix shape — that's your plan to write.
**Worktree:** `.claude/worktrees/1467-permission-boundary-shell-quote`
**Branch:** `1467-permission-boundary-shell-quote` (off `origin/main` @ `198928da4`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan reviewer:** pane labelled `spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1467`.
3. **Plan-authorship rule (standing, non-negotiable tonight):** draft a short plan per
   `plan-build`, message the `Coordinator` label with the pointer, and STOP. Coordinator routes
   to Fable for review. Wait for explicit "approved" before writing code.
4. Once approved: TDD build, commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving a crafted vault path/argument cannot escape the permission hook's allowlist via
  shell-quoting tricks.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.
- Touches a live chat/tool-execution surface — **live-path proof required** (real notes read
  through the UI on live dev, screenshot on the PR), per the collision map's note on this issue.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets (real or placeholder-looking) in any doc, payload, log, or prompt.

## Collision notes

- None identified against tonight's other lanes — distinct files from every other lane's scope.
