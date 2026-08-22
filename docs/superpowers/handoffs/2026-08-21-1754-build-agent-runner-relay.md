# 1754 build agent runner — relay handoff

**Handoff doc (read first, has coordinator label/session, bans, exit criteria):**
`docs/coordination/1754-build-agent-runner-handoff.md` — but that file lives only on branch
`coord-1258-postmerge`, not on this branch. Fetch it with:
`git show coord-1258-postmerge:docs/coordination/1754-build-agent-runner-handoff.md`
(or `git show a980965e7:...` — same content, pinned commit).

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md` (already read in full
last turn — no need to re-read unless a specific question comes up).

**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`,
lines 1053-1799 (`# Group C — #1754: the build agent`, Tasks 11-19). Read that range, not the
whole file. Groups A (#1752) and B (#1753) are already merged into main and this branch — confirmed
by `git log`, migrations 0187/0188 exist with the draft/owner columns Group B was supposed to add.

**Coordinator:** name `coordinator` (resolve fresh via `herdr agent list` — do not trust a pane
number from this doc). Already messaged twice this run and approved proceeding with the
corrections below. No open question pending with it right now.

**Status: no code committed yet.** This relay happened during grounding/verification (step ½ of
`coordinated-build`), before Task 11's first line of code. Nothing to `git status` check — tree is
clean except this new doc.

## What was verified against the actual branch (don't re-verify — build directly on these)

The plan flags several spots as "confirm before implementing, mechanical adjustment not a design
change." All confirmed; here is what's actually on the branch, not what the plan guessed:

1. **Migration numbering (Task 13):** plan guessed `0161`. Latest on branch is `0188`
   (`packages/settings/sql/`). Use **`0189_module_builds.sql`** — check `ls packages/settings/sql/
   | sort -V | tail` again right before writing it, in case another lane landed one meanwhile.

2. **RLS pattern (Task 13):** plan sketched `current_setting('app.current_user_id', true)`. The
   real convention, seen in `packages/ai/sql/0016_ai_assistant_action_requests.sql`, is: a named
   function `app.current_actor_user_id()`, `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL
   SECURITY`, an explicit `GRANT ... TO jarvis_app_runtime`, and **separate** SELECT/INSERT/UPDATE
   policies each checking `app.current_actor_user_id() IS NOT NULL AND owner_user_id =
   app.current_actor_user_id()`. Copy that file's shape for `app.module_builds`.

3. **`generateStructured` signature (Task 14):** plan sketched `generateStructured(deps, input)`
   returning the plan object directly. Real signature (`packages/ai/src/structured/generate-structured.ts:72`):
   `generateStructured(scopedDb: DataContextDb, input: GenerateStructuredInput, deps: GenerateStructuredDeps): Promise<GenerateStructuredResult>`
   where `GenerateStructuredResult = { ok: true, object: unknown, usage } | { ok: false, error: "needs_config"|"validation_failed"|"provider_error"|"aborted" }`.
   `input.service` is an `AiServiceKey` (`AiModelCapability | \`module.${string}\``), not a free
   `capability` string. First-party (non-module) callers still use the `module.<namespace>.<name>`
   shape as a service key even though they aren't an installed module — see
   `packages/connectors/src/extract-deps.ts`'s `EMAIL_EXTRACT_SERVICE = "module.connectors.email-extract"`.
   Use something like `"module.moss.workshop-build-plan"` for Task 14's plan-writing call.

4. **YOLO composition (Task 15/17):** plan guessed a standalone check around line 189 of
   `packages/settings/src/yolo-routes.ts`. The real composition is inline inside the `readSelf`
   function: `instanceEnabled && allowed && enabled`, using `readMaster(scopedDb)` +
   `prefs.get(scopedDb, YOLO_ALLOWED_PREF_KEY)` + `prefs.get(scopedDb, YOLO_ENABLED_PREF_KEY)`.
   Extract `isYoloActiveForActor(scopedDb: DataContextDb, prefs: ProfilePreferencesPort):
   Promise<boolean>` from that composition (scopedDb is already actor-scoped via
   `dataContext.withDataContext({actorUserId, ...}, ...)`, so no separate `actorUserId` param is
   needed the way the plan sketched it) and have `readSelf` call it instead of duplicating the
   `&&`.

5. **`MODULE_ID_PATTERN` (Task 11):** the plan's placeholder name doesn't exist. The real thing is
   `MODULE_ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` exported from
   `packages/module-registry/src/external/validate.ts:36`. Import and reuse it in
   `resolve-build-dir.ts` rather than redefining the regex.

6. **Test file location — the important one, not yet in the plan's own caveats.** The plan writes
   every task as `Test: packages/<pkg>/src/.../foo.test.ts` (colocated). **That is wrong for this
   repo outside a short whitelist.** `vitest.config.ts`'s `test.include` only picks up colocated
   tests from `packages/people/src/__tests__/`, `packages/db/src/__tests__/`,
   `packages/chat/src/live/*.test.ts`, and `packages/calendar/src/*.test.ts` — nothing else,
   including `module-registry`, `jobs`, `settings`, `ai` (my four target packages). Everything else
   must live under **`tests/unit/<package>-<topic>.test.ts`** (flat, prefixed, not nested) — see
   existing precedent: `tests/unit/ai-generate-structured.test.ts`, `tests/unit/jobs-pg-boss.test.ts`.
   `pnpm test:unit` runs `vitest run tests/unit` by default (see `scripts/test-unit.ts`) — a
   colocated test file would never run in that command and would look green by omission. Also note
   the correct package name for filtering is `@moss/module-registry` etc., not `@jarvis/...` as the
   plan's `pnpm --filter @jarvis/... test` commands say — and there is no per-package `test`
   script anyway; use `pnpm test:unit tests/unit/<file>.test.ts` to scope a single file, or just
   `pnpm test:unit` for the whole suite.

   **Concretely, remap every task's test path:**
   - Task 11 → `tests/unit/module-registry-resolve-build-dir.test.ts`
   - Task 12 → `tests/unit/jobs-module-build.test.ts`
   - Task 13 → `tests/unit/settings-module-builds-repository.test.ts`
   - Task 14 → `tests/unit/ai-module-build-write-plan.test.ts`
   - Task 15 → `tests/unit/ai-module-build-run-step.test.ts`
   - Task 16 → `tests/unit/module-registry-install-draft.test.ts`
   - Task 17 → `tests/unit/settings-yolo-routes.test.ts` (add to existing suite if one exists there
     already — check first) + `tests/unit/ai-module-build-start-build.test.ts`
   - Task 18 → `tests/unit/ai-self-operation-module-build.test.ts`
   - Task 19 → likely belongs with the other job-restart e2e tests; check
     `tests/integration/` (run via `pnpm test:integration`, not `test:unit`) for the notes-indexing
     restart test's actual location before assuming `tests/unit` is right for this one task — it's
     explicitly an integration/e2e test against a real pg-boss instance, which is the kind of thing
     that lives in `tests/integration/` elsewhere in this repo. Confirm by grep, don't guess.

## Next concrete step

Start Task 11 exactly as written in the plan (source file path is correct, only the test path
changes per #6 above): write the failing test in
`tests/unit/module-registry-resolve-build-dir.test.ts`, run
`pnpm test:unit tests/unit/module-registry-resolve-build-dir.test.ts`, confirm it fails, implement
`packages/module-registry/src/external/resolve-build-dir.ts` (import `MODULE_ID_RE` from
`./validate.ts` per #5 instead of redefining the pattern), confirm it passes, commit with
`git add packages/module-registry/src/external/resolve-build-dir.ts
tests/unit/module-registry-resolve-build-dir.test.ts` and the message the plan already specifies.
Then continue Task 12, 13, ... in order, applying corrections #1-#4 as each task comes up, and the
test-location remap from #6 throughout.

**Read the plan's Task 11-19 text (lines 1053-1799) again as you reach each task** — this doc gives
corrections, not the full task content; don't try to work from memory of it.

## Reminders carried from the handoff doc (don't re-derive, just obey)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to coordinator.
- Relay again at the next 70% meter warning or compaction summary — don't invent a higher personal
  threshold. If you relay having committed nothing again, that's a real problem worth flagging to
  the coordinator plainly, not softening.
- Run the pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on
  `origin/main`) before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- This is a user-facing feature (spec says so) — plan for the UAT spec
  (`tests/uat/specs/<slug>.uat.spec.ts`) and a row in
  `.claude/skills/coordinate/uat-trigger-map.tsv` per the `coordinated-build` skill's step 1 note,
  even though Group C's own tasks (11-19) don't list one explicitly — that's Group D/E's page, but
  check whether wrap-up for *this* PR needs anything at all live-path-provable on its own (a build
  job with no UI surface yet) or whether "code-complete, unverified" is the honest status for this
  PR specifically since the Workshop page (#1755) is a separate PR. Worth a one-line check-in with
  the coordinator when you get to wrap-up, not a blocking question now.
