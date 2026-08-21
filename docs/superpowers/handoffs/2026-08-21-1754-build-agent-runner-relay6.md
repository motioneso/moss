# 1754 build agent runner — relay 6

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
Read only the section for the task you're on (`grep -n "^### Task" <plan>` for exact line numbers).
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Done this relay — one commit, green

- `0f7a0f009` — Task 18, the test proving a build cannot touch settings/YOLO/self-authority tools.
  New file `tests/unit/self-operation-module-build.test.ts`, three tests, all passed on first run
  (no boundary violation found in the existing build code). No production code changed.

## Next — Task 19 (last task in Group C)

Read `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` at line 1761, "Task 19:
Restart-survival proof — seam 3". The plan text cites a precedent file
(`packages/notes/src/jobs.ts` restart test) that **does not exist in this codebase** — checked, it
is not there. Do not go looking for it again. The plan also names a possible test file location
`packages/jobs/src/module-build-jobs.e2e.test.ts` "or the existing job-restart e2e location" — that
does not exist either.

**What I worked out already, so the next agent does not have to re-derive it:**

1. The real precedent to copy is `tests/integration/module-distribution.e2e.test.ts` — it is a real
   test using a real Postgres database and a real pg-boss job queue (not a fake one), which is what
   Task 19 needs. Read its `beforeAll`/`afterAll` and imports for the pattern: `createDatabase` and
   `DataContextRunner` from `@moss/db`, `connectionStrings` and `resetFoundationDatabase` and `ids`
   from `tests/integration/test-database.ts`.
2. Everything Task 19 needs already exists and is real, not fake:
   - The build job and its queue: `packages/jobs/src/module-build-jobs.ts`
     (`createModuleBuildWorker`, `MODULE_BUILD_QUEUE`, `sendJob`).
   - The database row functions: `packages/settings/src/module-builds-repository.ts`
     (`createModuleBuild`, `getModuleBuild`, `updateModuleBuildStatus` — all take a real scoped
     database handle, this is not a fake).
   - The step logic: `packages/ai/src/module-build/run-build-step.ts` (`runModuleBuildStep`) — this
     is the piece that proves restart-survival: it reads the step to resume from the database row
     you pass it, not from the incoming job's own data. So the test's job is to actually wire these
     three real pieces together (something no earlier task did) and only fake the one piece that
     must stay fake in a test: `launchLiveAgent` (the thing that would otherwise start a real paid
     coding agent run).
3. **One real gap I found, not a design question, just needs fixing as part of this task:** the
   build job's queue name (`MODULE_BUILD_QUEUE`, the string `"module-build"`) was never added to
   the list of queues the app creates when it starts up
   (`FOUNDATION_QUEUES` in `packages/jobs/src/pg-boss.ts`, around line 20 next to the very similar
   existing entry `PLATFORM_MODULE_CONTROL_QUEUE`). Without this, sending a build job for real
   would fail today, in production, not just in the test. Add `MODULE_BUILD_QUEUE` to
   `FOUNDATION_QUEUES` there (small object, same shape as the `PLATFORM_MODULE_CONTROL_QUEUE`
   entry) as the first step of Task 19 — this also makes `resetFoundationDatabase()` in the test
   database helper create the queue automatically for the test, since it already creates every
   queue in that list.
4. `ALLOWED_PAYLOAD_KEYS` in that same file already includes `buildId` and `step` — nothing to add
   there.

**Suggested file for the new test:** `tests/integration/module-build-restart.e2e.test.ts` (matches
how the real precedent file is named and where it lives — do not put it under `packages/jobs/src/`,
that is not where this kind of test lives in this codebase).

I did not write any test code yet — only researched. The next agent should write the plan (short,
since the pieces above are already identified), get it approved by the coordinator, then build it.

## Reminders (unchanged from earlier relays)

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
  invented terms, exact names only for things Ben must act on (a command, a file, an error
  string). This is a standing rule from Ben, carried on every relay.
