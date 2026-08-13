# Build Handoff — 1274-external-module-trust-lint

**GitHub issue:** #1274 — no separate spec doc; scoped fix, build off the issue text + the
Phase-0 collision map's pointer below. `gh issue view 1274` first.
**Risk tier:** `security` — external-module trust boundary at install time. Gets adversarial
Opus QA + **Ben's explicit merge sign-off**.
**Scope (Phase-0 collision map pointer):** `packages/module-registry/src/external/validate.ts` +
`packages/ai/src/gateway/input-validation.ts` — install-time schema lint for external modules.
Read the issue for the exact acceptance criteria; the collision map only located the files, it
did not resolve the fix shape — that's your plan to write.
**Worktree:** `.claude/worktrees/1274-external-module-trust-lint`
**Branch:** `1274-external-module-trust-lint` (off `origin/main` @ `198928da4`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan reviewer:** pane labelled `spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. `gh issue view 1274`.
3. **Plan-authorship rule (standing, non-negotiable tonight):** draft a short plan per
   `plan-build`, message the `Coordinator` label with the pointer, and STOP. Coordinator routes
   to Fable for review. Wait for explicit "approved" before writing code.
4. Once approved: TDD build, commit per step, follow `coordinated-build`/`coordinated-wrap-up`.

## Exit criteria

- Test proving a malformed/malicious external-module manifest is rejected at install-time schema
  lint, not merely at first use.
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.

## Collision notes

- #1275 serializes AFTER this lane — same file, `compilePattern`/pattern cache. Do not let #1275
  start until this PR lands; the Coordinator tracks that queueing.
- No other collisions identified against tonight's other lanes.
