# 1754 build agent runner — relay 5

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
Read only the section for the task you're on (`grep -n "^### Task" <plan>` for exact line numbers).
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Done this relay — two commits, both green

- `150d28dbb` — Task 16, install a finished build as a draft. Files: `packages/module-registry/src/external/install-draft.ts`,
  `packages/module-registry/src/node.ts` (barrel export added), `packages/settings/src/repository-external-modules.ts`
  (new `setExternalModuleDraft`), `packages/settings/src/repository.ts` (wired + re-exported), tests
  `tests/unit/module-registry-install-draft.test.ts` and `tests/unit/repository-external-modules-draft.test.ts`.
  Built per the relay-4 doc's coordinator-approved re-scope (do not redo the design discussion —
  it's settled): no call into `scripts/module-install.ts`; reuses `stageModuleDir` +
  `hashExternalPackage`/`hashCanonicalManifest` from module-registry; new sibling repository
  function to `setExternalModuleEnabled`.
- `db03ab558` — Task 17, gate a build behind YOLO. New file `packages/ai/src/module-build/start-build.ts`
  (`startModuleBuild`, `approveModuleBuildPlan`) + `tests/unit/ai-module-build-start-build.test.ts`.
  **Found on arrival: the plan's Step 1-2 "extract `isYoloActiveForActor`" work was already done**
  by an earlier task — it already exists at `packages/settings/src/yolo-routes.ts:173`, already
  exported, already tested in `tests/unit/settings-yolo-routes.test.ts`. No changes needed there;
  I only added `start-build.ts`. Its deps are bound async functions (same injection style as
  `run-build-step.ts`), not a real or faked `DataContextDb` — nothing in this task wires it to a
  real queue/DB yet; that wiring (routes, chat's "build it" button, pg-boss `sendJob`) is not named
  as its own task in the plan and may belong to whichever later task adds the chat-side UI, or may
  need a small connecting task — flag this to the coordinator if Task 18/19 don't cover it.

Both commits pass `pnpm vitest run` on their own test files and `tsc --noEmit` for their package
(`@moss/module-registry`, `@moss/settings`, `@moss/ai` all typecheck clean as of this relay).
Full `pnpm verify:foundation` NOT run this relay (use the `verify-gate` skill when you do).

## Next — Task 18

Read `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` starting at line ~1719 (grep for
`### Task 18` to confirm the exact line — it may have shifted). Task 18 is "Self-operation boundary
test — seam 4". Then Task 19 ("Restart-survival proof — seam 3"). Read each section only when you
reach it, not both up front.

**Before implementing Task 18/19, resolve the start-build wiring gap noted above with the
coordinator** if it isn't already scoped into one of them — a plan-approval/YOLO gate with no
caller wired up is dead code until something calls `startModuleBuild`/`approveModuleBuildPlan`.

## Reminders (unchanged from relay-1 through relay-4)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% meter warning or compaction summary. Read the plan by SECTION only.
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on `origin/main`)
  before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- This PR (Group C) has no UI surface of its own (that's #1755, a separate PR) — raise with the
  coordinator at wrap-up whether "code-complete, unverified" is the honest status for this PR
  specifically.
- Plain English in every message to the coordinator and in every spawn prompt — no jargon, no
  coined shorthand, exact names only for things Ben must act on (a command, a file, an error
  string). This is a standing rule from Ben, carried on every relay.
