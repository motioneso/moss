# Relay — issue 2154 module build post-completion failure

**Plan (approved by coordinator):** `docs/superpowers/plans/2026-08-31-2154-module-build-post-complete-failure.md` — read it in full, it's short.
**Worktree/branch:** this worktree, `fix/2154-module-build-post-complete-failure`.
**Coordinator:** agent name `coordinator`. Confirm exactly one live agent has that name via `herdr agent list` before messaging.
**Last commit:** `fa02c9d6d` — WIP, tests + safe-error helper added but not yet wired in.

## Coordinator's approval boundary (must hold)

Saved failure text in `module_builds.error` must be useful but must **never** include a stack
trace, secrets, or unrelated raw data (e.g. a filesystem path from a raw fs exception). This is
why Task 1 below isn't a plain `error.message` passthrough — see the pattern already used at
`packages/notes/src/error-sink.ts` (`sinkSafeErrorMessage`), which this fix mirrors on a smaller
scale.

## Done

- Plan written and approved.
- `tests/unit/worker-module-build-step-runner.test.ts`: added two new tests —
  `"preserves the thrown error's real message instead of just its name (#2154)"` and
  `"does not retry against a build already marked failed (#2154)"`. Both currently FAIL (that's
  expected — the production code isn't changed yet). Read them for the exact expected shape.
- `apps/worker/src/module-build-step-runner.ts`: added `ModuleBuildSafeError` class and
  `safeModuleBuildErrorMessage()` helper (near the top of the file, above
  `RunModuleBuildStepForJobDeps`). Not yet called anywhere.

## Left to do, in order

1. **Wire the safe-error helper into the catch block.** In
   `apps/worker/src/module-build-step-runner.ts`, find the catch block (`error: error instanceof
   Error ? error.name : "unknown error"`, around line 105 after the additions) and change it to
   `error: safeModuleBuildErrorMessage(error)`.
2. **Mark the known-safe throw sites.** These currently throw plain `new Error(...)` with
   messages the code itself composed (no raw path/secret risk) — switch them to
   `ModuleBuildSafeError` so their real text survives:
   - `apps/worker/src/module-build-step-runner.ts`: `throw new Error("module build was not
     found")` (~line 50, inside `createRunModuleBuildStepForJob`).
   - `apps/worker/src/worker.ts`: `throw new Error("no chat model is configured for module
     build")` (~line 252), `throw new Error("module build was cancelled")` (~line 268), and
     `throw new Error(\`generated module failed validation: ${installed.errors.join("; ")}\`)`
     (~line 293). Import `ModuleBuildSafeError` from `./module-build-step-runner.js`.
3. **Add the no-retry-on-failed guard** (Task 2 of the plan). In
   `createRunModuleBuildStepForJob`, extend the existing `if (build.status === "cancelled")`
   early-return (~line 51) to also cover `"failed"`:
   `if (build.status === "cancelled" || build.status === "failed") return { deferred: false };`
4. **Task 3 — `installModuleDraft` missing-manifest case.** In
   `packages/module-registry/src/external/install-draft.ts`, wrap the `statSync(manifestPath)`
   call (~line 44) in try/catch, returning `{ ok: false, errors: ["the build did not produce
   jarvis.module.json"] }` on failure instead of letting the raw fs error propagate. Add a new
   test in `tests/unit/module-registry-install-draft.test.ts` (follow the existing fake-dependency
   pattern in that file) asserting this exact resolved shape for a `buildSourceDir` with no
   manifest file.
5. **Run both test files**, confirm every new test passes and nothing else regressed:
   ```bash
   pnpm --filter @moss/worker exec vitest run tests/unit/worker-module-build-step-runner.test.ts > /tmp/2154-step-runner.log 2>&1; echo "EXIT=$?"
   pnpm --filter @moss/module-registry exec vitest run tests/unit/module-registry-install-draft.test.ts > /tmp/2154-install-draft.log 2>&1; echo "EXIT=$?"
   ```
   (If the `--filter` package names above don't match — check each `package.json`'s `name` field
   first; don't guess.)
6. **Pre-push trio + rebase:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
7. **`coordinated-wrap-up`**: full isolated gate via the `verify-gate` skill (never run
   `pnpm verify:foundation` directly, never pipe it), push, open the PR, fill in the Release note
   section (this is an internal error-message/reliability fix — likely `Category: N/A` unless it's
   judged user-visible; use your judgement reading `docs/DEVELOPMENT_STANDARDS.md`'s release-note
   rule), report to the coordinator with commit SHAs and exact check output.
8. This fix is not a user-facing UI/feature change (no new screen, no new chat surface) — the
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
