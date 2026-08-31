# Relay — issue 2154 module build post-completion failure

**Plan (approved by coordinator):** `docs/superpowers/plans/2026-08-31-2154-module-build-post-complete-failure.md` — read it in full, it's short.
**Worktree/branch:** this worktree, `fix/2154-module-build-post-complete-failure`.
**Coordinator:** agent name `coordinator`. Confirm exactly one live agent has that name via `herdr agent list` before messaging.
**Last commit:** `9526edb12` — all three production fixes AND their tests are now wired and committed. Nothing in the plan is unbuilt. What's left is running the tests, pre-push checks, and wrap-up.

## Coordinator's approval boundary (must hold — already satisfied by the current code)

Saved failure text in `module_builds.error` must be useful but must **never** include a stack
trace, secrets, or unrelated raw data (e.g. a filesystem path from a raw fs exception).
`apps/worker/src/module-build-step-runner.ts` now has a `ModuleBuildSafeError` class and a
`safeModuleBuildErrorMessage()` helper: only a `ModuleBuildSafeError`'s own message is ever
stored; any other thrown value degrades to a generic `"module build failed (<ErrorName>)"`
sentence. Every throw site whose message the code itself composed (no raw path/secret risk) was
switched to `ModuleBuildSafeError` — see commit `9526edb12` for the full list. This mirrors the
existing pattern at `packages/notes/src/error-sink.ts`.

## Done

- Plan written and approved.
- All three plan tasks implemented and committed in `9526edb12`:
  1. Real error message preserved (via the safe-error scheme above), catch block now calls
     `safeModuleBuildErrorMessage(error)`.
  2. `createRunModuleBuildStepForJob`'s early-return now also covers `build.status === "failed"`,
     so a pg-boss retry never re-launches the live coding agent against an already-failed build.
  3. `installModuleDraft`'s `statSync(manifestPath)` is wrapped in try/catch, returning
     `{ ok: false, errors: ["the build did not produce jarvis.module.json"] }` instead of letting
     a raw fs ENOENT propagate.
- Test changes, same commit:
  - `tests/unit/worker-module-build-step-runner.test.ts`: the pre-existing "(regression)" test's
    expectation was updated from `error: "Error"` to `error: "module build failed (Error)"`
    (it throws a plain `Error`, which is intentionally NOT preserved verbatim — only
    `ModuleBuildSafeError` messages survive). Two new tests added: one throwing a
    `ModuleBuildSafeError` and asserting its exact message is stored, and one asserting a build
    already `status: "failed"` short-circuits before `prepareRunStepDeps`/`runStep` are ever
    called.
  - `tests/unit/module-registry-install-draft.test.ts`: new test asserting a missing
    `jarvis.module.json` resolves to `{ ok: false, errors: ["the build did not produce
    jarvis.module.json"] }` instead of throwing.

## Left to do, in order

1. **Run both test files**, confirm every test passes (first confirm the `--filter` package
   names against each `package.json`'s `name` field — don't guess):
   ```bash
   pnpm --filter @moss/worker exec vitest run tests/unit/worker-module-build-step-runner.test.ts > /tmp/2154-step-runner.log 2>&1; echo "EXIT=$?"
   pnpm --filter @moss/module-registry exec vitest run tests/unit/module-registry-install-draft.test.ts > /tmp/2154-install-draft.log 2>&1; echo "EXIT=$?"
   ```
   If anything is red, read the log (bounded — `tail -n 80`, don't cat unbounded) before touching
   code again.
2. **Pre-push trio + rebase:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
3. **`coordinated-wrap-up`**: full isolated gate via the `verify-gate` skill (never run
   `pnpm verify:foundation` directly, never pipe it), push, open the PR, fill in the Release note
   section (this is an internal error-message/reliability fix, no new UI or user-visible screen —
   likely `Category: N/A`, confirm against `docs/DEVELOPMENT_STANDARDS.md`'s release-note rule
   before deciding), report to the coordinator with commit SHAs and exact check output.
4. This fix is not a user-facing UI/feature change (no new screen, no new chat surface) — the
   live-path gate likely does not apply, but confirm against `docs/DEVELOPMENT_STANDARDS.md` →
   Live-Path Gate before skipping it.

## Guardrails still in force

- Never touch `packages/module-sdk` (PR #2153 collision).
- Never repeat PR #2101's browser proof in this lane.
- Stage explicit paths only; never `git add -A`.
- Never run a database-touching test outside `verify-gate`.
- This is relay 1 of a 1-relay budget — if you also hit the 70% context warning before a PR is
  open, do not relay again: push what you have, update this doc, and tell the coordinator the
  slice needs re-scoping.
