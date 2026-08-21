# 1754 build agent runner — relay 2

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`,
lines 1053-1799 (Tasks 11-19). Read only the section for the task you're on.
**Prior corrections doc (still valid, keep applying):**
`docs/superpowers/handoffs/2026-08-21-1754-build-agent-runner-relay.md` — migration number,
RLS pattern, `generateStructured` real signature, YOLO composition, `MODULE_ID_RE` name, and the
full test-path remap table (every task's test lives in `tests/unit/<name>.test.ts`, not colocated).

**Coordinator:** label `Coordinator` in Herdr (confirm fresh via `herdr pane list` before
messaging — do not trust a pane id from this doc, it reflows). Already messaged this relay.

## Done — commits on this branch, all green

1. Task 11 — `packages/module-registry/src/external/resolve-build-dir.ts` +
   `tests/unit/module-registry-resolve-build-dir.test.ts`.
2. Task 12 — `packages/jobs/src/module-build-jobs.ts` (+ `ALLOWED_PAYLOAD_KEYS` in `pg-boss.ts`) +
   `tests/unit/jobs-module-build.test.ts`.
3. Task 13 — migration `packages/settings/sql/0189_module_builds.sql` (NOT 0161 — that number was
   stale; re-check `ls packages/settings/sql | sort -V | tail` before any further migration in case
   another lane landed one), `packages/settings/src/module-builds-repository.ts`,
   `tests/unit/settings-module-builds-repository.test.ts`. Also added `ModuleBuildsTable` to
   `packages/db/src/types.ts` and registered it in the `MossDatabase` map — needed for Kysely
   typing, not itself one of the plan's named files, don't be surprised by it in `git log`.

   **Note on RLS test scope:** the "cannot read another user's row" case from the plan's Step 2 is
   NOT tested with a real Postgres connection — this repo's `tests/unit` convention (confirmed by
   reading `tests/unit/module-preferences-routes.test.ts`) is a fully faked Kysely `db` object;
   real RLS enforcement is proven by the migration's policy and by live/integration tests
   elsewhere, never spun up from a unit test (CLAUDE.md: never run a DB-touching test command
   without the `verify-gate` skill). The committed test checks the repository functions' own
   logic (default status, null-on-no-row), not live cross-user isolation. If wrap-up's live-path
   gate wants direct proof of this table's RLS, that's a `verify-gate`-gated integration check, not
   something to add casually to `tests/unit`.

   **Typecheck note:** all new/edited `tests/unit/*.test.ts` files need explicit `.js` extensions
   on relative imports (`node16`/`nodenext` moduleResolution) — I had to fix this on Tasks 11/12's
   test files too when Task 13's `pnpm --filter @moss/db typecheck` caught it. Run
   `pnpm --filter <pkg> typecheck` after adding each new test file that imports from `packages/`
   by relative path, not just `pnpm test:unit`, or a real error only surfaces at the pre-push
   trio / CI.

## In progress — Task 14 (write-plan step), NOT committed

- **Test written and confirmed red:** `tests/unit/ai-module-build-write-plan.test.ts` (uncommitted,
  sitting on disk in this worktree — you don't need to rewrite it, just pick up from here).
- **Not yet done:** create `packages/ai/src/module-build/write-plan.ts` (directory doesn't exist
  yet — `mkdir -p packages/ai/src/module-build` first).
- **Real `generateStructured` signature** (already confirmed by reading
  `packages/ai/src/structured/generate-structured.ts` in full — don't re-read the whole file,
  just the signature below is enough):
  ```
  generateStructured(scopedDb: DataContextDb, input: GenerateStructuredInput, deps: GenerateStructuredDeps): Promise<GenerateStructuredResult>
  GenerateStructuredInput = { service: ModuleServiceKey; schema: Record<string, unknown>; prompt: string; ...optional fields }
  GenerateStructuredResult = { ok: true; object: unknown; usage } | { ok: false; error: "needs_config"|"validation_failed"|"provider_error"|"aborted" }
  ```
  `ModuleServiceKey = \`module.${string}\`` (from `@moss/shared`). Use
  `"module.moss.workshop-build-plan"` as the service key (matches the first-party-caller
  convention seen in `packages/connectors/src/extract-deps.ts`'s `EMAIL_EXTRACT_SERVICE`).
- **My planned signature for `writeModuleBuildPlan`** (differs from the plan's placeholder, which
  assumed a simpler `generateStructured(deps, input)` — that's stale, this is the real shape):
  ```ts
  writeModuleBuildPlan(
    scopedDb: DataContextDb,
    deps: { generateStructured: typeof generateStructured; generateStructuredDeps: GenerateStructuredDeps },
    input: { description: string; conversationExcerpt: string }
  ): Promise<ModuleBuildPlan>
  ```
  Throw on `result.ok === false` (the test file already has a third case for this: "throws when
  generateStructured cannot produce a plan"). The JSON schema for `MODULE_BUILD_PLAN_SCHEMA` should
  follow the `additionalProperties: false` / `required: [...]` convention shown in
  `packages/connectors/src/extract-deps.ts`'s `EMAIL_SIGNALS_SCHEMA` — five properties:
  `whatItDoes` (string), `whatItReaches` (array of string), `whatItKeeps` (string), `whenItRuns`
  (string), `roughCost` (object: `{ time: string; budgetCents: number }`).
- Next: implement, run `pnpm test:unit tests/unit/ai-module-build-write-plan.test.ts`, confirm
  PASS, run `pnpm --filter @moss/ai typecheck`, then commit both files with message
  `feat(#1754): write a module build plan as five plain lines`.

## Then continue Tasks 15-19 in order

Read each task's plan section (line ranges: Task 15 ~1439-1544, Task 16 ~1545-1628, Task 17
~1629-1718, Task 18 ~1719-1760, Task 19 ~1761-1898 — re-grep `grep -n "^### Task" <plan>` to
confirm exact boundaries, don't trust these numbers blindly) plus the relay-1 corrections doc
for Tasks 15/17's YOLO composition and Task 11's `MODULE_ID_RE` naming (already applied, just
context for why those tasks' code looks the way it does). Test paths per relay-1's remap table:
- Task 15 → `tests/unit/ai-module-build-run-step.test.ts`
- Task 16 → `tests/unit/module-registry-install-draft.test.ts`
- Task 17 → `tests/unit/settings-yolo-routes.test.ts` (extend existing suite if one exists — check
  first) + `tests/unit/ai-module-build-start-build.test.ts`
- Task 18 → `tests/unit/ai-self-operation-module-build.test.ts`
- Task 19 → check `tests/integration/` for the notes-indexing restart test's actual location
  before assuming `tests/unit` — Task 19 is explicitly an e2e test against a real pg-boss
  instance (needs `verify-gate` skill, not a casual `pnpm test:integration` run).

## Reminders (same as relay-1, still true)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% meter warning or compaction summary — don't invent a higher
  threshold.
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on `origin/main`)
  before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- This PR's own live-path status is worth a one-line check-in with the coordinator at wrap-up —
  Group C (this PR) has no UI surface of its own (that's #1755, a separate PR), so
  "code-complete, unverified" may be the honest status for this PR specifically. Confirm with the
  coordinator rather than assuming either way.
