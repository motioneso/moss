# 1754 build agent runner — relay 3

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
Read only the section for the task you're on (`grep -n "^### Task" <plan>` for exact line numbers
— they drift as the doc is edited, don't trust cached numbers).
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Done — commits on this branch, all green (tests pass, package typechecks pass)

11. `packages/module-registry/src/external/resolve-build-dir.ts` + test.
12. `packages/jobs/src/module-build-jobs.ts` (+ `ALLOWED_PAYLOAD_KEYS`) + test.
13. `packages/settings/sql/0189_module_builds.sql`, `module-builds-repository.ts` + test. Added
    `ModuleBuildsTable` to `packages/db/src/types.ts`.
14. `packages/ai/src/module-build/write-plan.ts` (`writeModuleBuildPlan`) + test. Real
    `generateStructured(scopedDb, input, deps)` signature — see the file, it's short, just read it
    rather than trusting a description here.
15. `packages/ai/src/module-build/run-build-step.ts` (`runModuleBuildStep`) + test. Also: extracted
    `isYoloActiveForActor(scopedDb, prefs)` out of `packages/settings/src/yolo-routes.ts`'s inline
    composition, and added missing barrel exports — `module-builds-repository.js` and
    `isYoloActiveForActor` from `@moss/settings`'s `index.ts`, `module-build-jobs.js` from
    `@moss/jobs`'s `index.ts` (both were created in Tasks 12/13 but never exported — needed now for
    cross-package imports in Tasks 16/17).

**Design note carried into Task 16/17:** `runModuleBuildStep` takes `launchLiveAgent` as an
injected dependency — it does NOT itself call `buildLaunchCommand` /
`writeClaudePermissionHook` (`packages/chat/src/live/`). Composing those into a real
`launchLiveAgent` implementation, scoped to the Task 11 build directory with a permission hook
that auto-approves in-directory writes, is wiring work for whichever task assembles the real
worker (Task 17's start-build flow, most likely) — it hasn't been done yet. Don't assume it exists.

**Recurring gotcha, now fixed generally:** every new `tests/unit/*.test.ts` needs explicit `.js` on
relative cross-package imports (moduleResolution node16). Also `vi.fn<() => Promise<T>>()` takes
ONE type argument (a function type), not two — `vi.fn<[], Promise<T>>()` fails typecheck.
Run `pnpm --filter <pkg> typecheck` for every package whose files you touched (source AND the
package the test file's imports typecheck against — a test can fail two packages' typechecks at
once if it imports across a boundary) before committing, not just `pnpm test:unit`.

## Next — Task 16: install the finished build as a draft (seam 1)

Read the plan's Task 16 section fresh (grep for exact lines). Test file per the established
convention: `tests/unit/module-registry-install-draft.test.ts` (flat `tests/unit`, not colocated —
this whole plan's tasks all use that convention now, not the plan's original colocated-path
guesses).

## Then Tasks 17-19

- Task 17: wire plan-approval + YOLO gate around the whole build. Uses `isYoloActiveForActor`
  (already extracted, exported from `@moss/settings`). Test files:
  `tests/unit/ai-module-build-start-build.test.ts` (new) — `settings-yolo-routes.test.ts` already
  exists (created in Task 15) so extend it in place if Task 17 needs more cases, don't create a
  second file.
- Task 18: self-operation boundary test (seam 4). Test file:
  `tests/unit/ai-self-operation-module-build.test.ts`.
- Task 19: restart-survival proof (seam 3) — this is an e2e/integration test against a real
  pg-boss instance. Grep `tests/integration/` for how the existing notes-indexing restart test is
  structured before assuming a location or command; this one needs the `verify-gate` skill, not a
  casual `pnpm test:integration` run — never run a DB-touching test command without it.

## Reminders (unchanged from relay-1/relay-2)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% meter warning or compaction summary.
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on `origin/main`)
  before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- This PR (Group C) has no UI surface of its own (that's #1755, a separate PR) — raise with the
  coordinator at wrap-up whether "code-complete, unverified" is the honest status for this PR
  specifically, rather than assuming either way.
