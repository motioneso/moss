# Plan — #1949 Workshop live build, part 2 of #1889

Spec: `docs/specs/1949.md`. Risk tier: sensitive (adversarial QA + Ben merge sign-off).
This plan carries decisions only — no function bodies. Citations verified against
`fleet/lane-1949` at commit `93a3177db` (current HEAD before this plan's commits).

## Seams check (file:line, verified this session)

- Approval hook point: `apps/web/src/chat/module-build-plan-record.tsx:66-73` (`onBuildIt`
  handler, calls `approveModuleBuild(props.buildId)`).
- Router hook available in that tree: `apps/web/src/app.tsx:11,395` imports `useNavigate` from
  `react-router`; `apps/web/src/app.tsx:392` imports `useChatControls` from
  `./shell/chat-controls-context`. `module-build-plan-record.tsx` currently imports neither.
- Polling target: `packages/workshop/src/web/workshop-page.tsx:25-31`, `useMyModuleBuilds()` —
  `useQuery` with no `refetchInterval`.
- Build row fields: `packages/shared/src/workshop-api.ts:103-116` `ModuleBuildSummary` — has
  `step`, `fetchedUrls`, `costCents`; no written-files field.
- Live agent already returns files written but they're discarded:
  `packages/ai/src/module-build/run-build-step.ts:11-15` (`LaunchLiveAgentResult.wroteFiles`),
  only `fetchedUrls` is persisted (same file, loop before `nextBuildStep`).
- Worker composition root: `apps/worker/src/worker.ts:189-232` `runModuleBuildStepForJob`.
  Success path sets status at line ~218-221; failure path in `catch` at ~223-228. Existing
  notification-construction pattern to copy: lines 289-300 (`moduleNotifications` +
  `postModuleNotification`, `new NotificationsRepository(undefined,
createNotificationPreferencePort())`, then `dataContext.withDataContext(access, (scopedDb) =>
repo.create(scopedDb, input))`).
- `NotificationsRepository.create` always writes recipient = the access context's own actor
  (`packages/notifications/src/repository.ts:34-53` docblock) — the existing `access` object built
  at `worker.ts:190-193` from `payload.actorUserId` is already the build owner (builds are created
  and jobs enqueued for the owner only, confirmed by `start-build.ts:43-49` / `88-99`), so no
  second scoped-DB block is needed.
- `href` validation: `packages/notifications/src/repository.ts:176-182` — same-origin path only.
  `/workshop` passes (starts with `/`, no `//`, no `:`).
- `WORKSHOP_MODULE_ID = "workshop"`: `packages/workshop/src/manifest.ts:6`. `apps/worker` does not
  currently depend on `@moss/workshop` (`apps/worker/package.json:12-23` has no entry) — add it.
- Buttons, all three currently inert: `packages/workshop/src/web/workshop-groups.tsx` — Stop
  (`BuildingNowCard`, line 84-86), Ask for a change + Turn on for everyone (`LiveModuleRow`, line
  103-110, the "everyone" button gated on `mod.scope === "you"`).
- No cancel mechanism exists anywhere (`grep -rn "cancel" packages/ai/src/module-build*` returns
  nothing app-side). Mirror `approveModuleBuildPlan`'s exact shape
  (`packages/ai/src/module-build/start-build.ts:88-99`: `ModuleBuildNotFoundError` when
  `!build || build.ownerUserId !== actorUserId`, else status update) and its route
  (`packages/ai/src/module-build-routes.ts:59-75`) and composition wiring
  (`packages/module-registry/src/index.ts:1494-1515`).
- Cancellation only takes effect between steps — pg-boss re-enqueues one job per step with
  `singletonKey: build:<id>` (`packages/jobs/src/module-build-jobs.ts:25-37`); no mid-step
  interruption exists or should be built (`packages/module-sdk/src/worker.ts:63-67`, deliberate
  no-`ctx.signal` design). Check happens in `runModuleBuildStepForJob` right after
  `getModuleBuild` (`worker.ts:195-196`), before any work starts.
- "Ask for a change" wiring precedent (own draft, already shipped): `apps/app.tsx:392,454`
  (`openChat` from `useChatControls()`, NOT `openChatWith`/`openAssistantWithDraft`) +
  `apps/web/src/chat/draft-banner.tsx` (`onAskForChange={openChat}` when already mounted on the
  draft's own route). Docking is separate from opening: `apps/web/src/shell/app-shell.tsx:279-283`
  computes `dockChat` from `location.pathname.startsWith("/m/")` and the target module's
  `draft === true`; navigating alone changes docking, `openChat()` alone changes drawer-open state.
  Workshop's row is a different route, so it needs both: `navigate("/m/" + moduleId)` then
  `openChat()`.
- "Turn on for everyone" — backend already complete, no new backend work:
  `apps/web/src/api/client.ts:451-460` `shipExternalModule(id)` →
  `packages/settings/src/routes-modules.ts:302-335` `POST /api/admin/modules/:id/ship`, already
  ownership + admin scoped, already flips `status: draft -> enabled` (the entire scope-widening
  mechanism — `scope` is derived in `packages/settings/src/routes-serializers.ts:74`, not stored).
- Ownership trap (defense in depth, not a new gap): `app.external_modules` SELECT policy is
  `USING (true)` for every authed actor (`packages/settings/sql/0152_external_modules.sql:46-49`);
  draft ownership (`owner_user_id`) was added later by
  `packages/settings/sql/0187_external_modules_draft_owner.sql` with a CHECK constraint but **no
  new SELECT policy** — so any new query against that table for draft rows must filter
  `owner_user_id = actorUserId` in application code. `app.module_builds` DOES have real per-owner
  RLS (`packages/settings/sql/0189_module_builds.sql:22-54`), so the new cancel path is safe by
  construction; add the explicit ownership check anyway to match `approveModuleBuildPlan`'s
  correct-404-vs-403 pattern.
- Next migration number: highest existing is `0189_module_builds.sql` — use `0190`. Re-check
  `ls packages/settings/sql/ | sort | tail -3` immediately before writing the file in case another
  lane landed one first (this repo has hit migration-number collisions before, per `0187`'s own
  commit history).
- Test conventions confirmed this session: root-suite component tests use `renderToString` (SSR,
  no jsdom, no click simulation) — `tests/unit/workshop-page.test.tsx`. Interaction tests (button
  click -> callback) use `@vitest-environment jsdom` + `react-test-renderer`'s `act`/`create`,
  finding buttons by their text child and calling `.props.onClick()` directly —
  `tests/unit/plan-approval-card.test.tsx`. `WorkshopGroups`/`LiveModuleRow`/`BuildingNowCard`
  need per-row callback props to be testable this way; there is currently no interaction test file
  for `workshop-groups.tsx` (only the SSR structure one), so add a new jsdom one alongside it.
- Ownership test pattern to copy for the cancel route:
  `tests/unit/ai-module-build-routes.test.ts:77-100` ("returns only the caller's own build, not
  another user's").
- Live test pattern: `tests/live/workshop-1888-uat.spec.ts` already drives a full real build from
  chat through approval (`test.describe.configure({ mode: "serial" })`,
  `test.setTimeout(300_000)`, real AI, real Postgres). `tests/live/workshop-1945-uat.spec.ts`
  checks `/workshop` renders pre-existing data, does not itself start a build.

## Determinism boundary

All Workshop-page feedback (status, step, cost, written files, notification) renders from the
`module_builds` row via polling — never from a chat model turn. The worker posts the
finish/failure notification directly (`postModuleNotification`, no chat message). The three
buttons call plain REST endpoints; none of them touch the model. No prompt or guidance text is
added or changed by this work.

## Phase 1 — live status pipeline (spec items 1 and 2)

Ships alone. Proves navigation, polling, and notification end to end before phase 2 touches the
buttons.

**Task 1.1 — persist written files.**

- New migration `packages/settings/sql/0190_module_builds_written_files.sql`:
  ```sql
  ALTER TABLE app.module_builds
    ADD COLUMN written_files jsonb NOT NULL DEFAULT '[]'::jsonb;
  ```
- `packages/settings/src/...` (wherever `appendModuleBuildFetchedUrl` and
  `updateModuleBuildStatus` live — confirm exact file at build time) gets a sibling
  `appendModuleBuildWrittenFile(scopedDb, buildId, path)` and the row-read path returns
  `writtenFiles: readonly string[]` alongside `fetchedUrls`.
- `packages/ai/src/module-build/run-build-step.ts`: `RunModuleBuildStepDeps` gets
  `readonly recordWrittenFile: (buildId: string, path: string) => Promise<void>`; after the
  existing `fetchedUrls` loop, loop `result.wroteFiles ?? []` calling it.
- `apps/worker/src/worker.ts` wires `recordWrittenFile` next to the existing
  `recordFetchedUrl: (buildId, url) => appendModuleBuildFetchedUrl(scopedDb, buildId, url)`.
- `ModuleBuildSummary` (`packages/shared/src/workshop-api.ts`) gets `readonly writtenFiles:
readonly string[]`, added to the JSON schema's `required`/`properties` the same way
  `fetchedUrls` is.
- `packages/ai/src/module-build-routes.ts`'s `/mine` handler maps `writtenFiles: build.writtenFiles`.
- `packages/workshop/src/web/workshop-groups.tsx`: `BuildingNowCard` renders `writtenFiles` (reuse
  the existing `FetchedUrls`-shaped list component, renamed or generalized to take a `label`
  prop) — this is "what it has written" per spec item 2; the existing `fetchedUrls` display stays
  as-is (it's what the build read, not what it wrote — no spec item asks to remove it).
- Test: unit test for `run-build-step.ts` — behaviour "when `launchLiveAgent` returns
  `wroteFiles`, `recordWrittenFile` is called once per path" (mirror the existing `fetchedUrls`
  test in `tests/unit/*module-build*run-build-step*` — confirm exact filename at build time).

**Task 1.2 — navigate to Workshop on approval, drawer stays open.**

- `apps/web/src/chat/module-build-plan-record.tsx`: import `useNavigate` from `react-router`,
  call `navigate("/workshop")` inside `onBuildIt` only after `approveModuleBuild` resolves
  successfully (not before — a failed approve must not navigate away from the error message).
- Test (jsdom + react-test-renderer, new file `tests/unit/module-build-plan-record.test.tsx`):
  behaviour "clicking Build it navigates to /workshop only after the approve call resolves" (mock
  `approveModuleBuild` to control resolution timing) and "a rejected approve call does not
  navigate" (existing error-message behaviour must still fire).
- Manual/live check only for "drawer stays open" — it's a structural fact about where this
  component mounts (inside the persistent drawer), not new logic; verify in the live proof, not a
  new unit test.

**Task 1.3 — poll while a build is running.**

- `packages/workshop/src/web/workshop-page.tsx`: `useMyModuleBuilds()`'s `useQuery` gets
  `refetchInterval: (query) => hasActiveBuild(query.state.data) ? 3000 : false` where
  `hasActiveBuild` is a small named function checking any build has `status === "planning" ||
status === "building"` (terminal-ish statuses `awaiting_plan_approval`/`awaiting_change` don't
  need urgent polling per the spec's own reasoning — they're waiting on the human, not progressing
  on their own; `ready`/`failed`/`cancelled` are terminal).
- Test: unit test asserting the query's `refetchInterval` function returns a truthy interval when
  a build's status is `"building"` and `false` when all builds are terminal/awaiting-human (call
  the extracted `hasActiveBuild` function directly, not the query itself).

**Task 1.4 — finish/failure notification.**

- `apps/worker/src/worker.ts`: add `@moss/workshop` to `apps/worker/package.json` dependencies;
  import `WORKSHOP_MODULE_ID`.
- Inside `runModuleBuildStepForJob`, reuse the block's existing `scopedDb`/`access`:
  - Success path (`result.continuation` falsy, i.e. the 3-step sequence finished): after the
    existing `updateModuleBuildStatus(..., { status: "awaiting_change", ... })` call, call
    `moduleNotifications.create(scopedDb, { moduleId: WORKSHOP_MODULE_ID, title: "Your module is
ready for a look", href: "/workshop", eventKey: \`module-build:${build.id}:finished\` })`via
the same`postModuleNotification`-style helper (construct one `NotificationsRepository`instance at composition time near the existing`moduleNotifications`one, or reuse it directly
if it's already in scope at this call site — confirm at build time whether`runModuleBuildStepForJob` is defined before or after that instance in the file).
  - Failure path (the `catch` block): after `updateModuleBuildStatus(..., { status: "failed",
... })`, call `.create` with `title: "Your module build failed"`, same `href`, `eventKey:
\`module-build:${build.id}:failed\``.
  - `eventKey` matters for pg-boss retries: a retried job that fails again must update the same
    notification row, not create a duplicate.
- Test: worker-level unit test (find the existing test file covering
  `runModuleBuildStepForJob` — grep `tests/unit/*worker*module-build*` at build time) asserting
  "on the step that finishes the build, a notification is created for the build owner with href
  /workshop" and "on a thrown error, a notification is created with a different title, same
  owner/href".

**Phase 1 e2e test — extends `tests/live/workshop-1888-uat.spec.ts`.** After the existing test
clicks "Build it" (the `PlanApprovalCard`'s button, already reached by that test): assert the URL
becomes `/workshop`, assert the chat drawer is still visible, then poll the DOM (Playwright's own
retrying `expect`, no manual sleep loop) for the build's status text to change at least once
within the test's existing 300s budget, then assert a notification appears once the build finishes
or fails. Run:

```bash
LIVE_BASE_URL=http://127.0.0.1:5184 LIVE_API_URL=http://127.0.0.1:3033 \
  npx playwright test --config playwright.live.config.ts workshop-1888 > /tmp/live-1888.log 2>&1; echo "EXIT=$?"
```

Expected exit code 0.

**Kill gate after phase 1.** If the extended live test does not observe at least one real status
change on the Workshop page within budget, or the notification never appears, stop before planning
phase 2 in detail and re-examine whether polling/notification wiring is actually reaching the
worker process used by the dev instance (a stale worker process is a known trap in this repo's
memory — confirm the dev worker was restarted after this change). Call made by this build agent
(fleet daemon mode, no live coordinator) — if genuinely stuck, report `blocked` via `fleetctl`
rather than guessing.

## Phase 2 — the three buttons (spec items 3 and 4)

**Task 2.1 — cancel build (Stop button).**

- `packages/ai/src/module-build/start-build.ts`: add
  ```ts
  export interface CancelModuleBuildPlanDeps {
    readonly getModuleBuild: (
      buildId: string
    ) => Promise<{ readonly id: string; readonly ownerUserId: string } | null>;
    readonly updateModuleBuildStatus: (buildId: string, status: "cancelled") => Promise<void>;
  }
  export async function cancelModuleBuildPlan(
    deps: CancelModuleBuildPlanDeps,
    buildId: string,
    actorUserId: string
  ): Promise<void>;
  ```
  Same ownership check as `approveModuleBuildPlan` (`ModuleBuildNotFoundError` on missing or
  not-owned).
- `packages/ai/src/routes.ts`: add `readonly cancelModuleBuild?: (scopedDb: DataContextDb,
buildId: string, actorUserId: string) => Promise<void>;` to `AiRoutesDependencies`, same shape as
  `approveModuleBuild`.
- `packages/ai/src/module-build-routes.ts`: add `POST /api/ai/module-builds/:buildId/cancel`,
  identical structure to the `/approve` route (503 when the dependency is absent, otherwise call
  through `dataContext.withDataContext`, respond `{ buildId, status: "cancelled" }`). Add a
  `cancelModuleBuildResponseSchema` next to `approveModuleBuildResponseSchema` in
  `packages/shared/src/workshop-api.ts`.
- `packages/module-registry/src/index.ts`: wire `cancelModuleBuild` next to the existing
  `approveModuleBuild` wiring (no `sendBuildJob` needed — cancelling never enqueues).
- `apps/worker/src/worker.ts`, `runModuleBuildStepForJob`: right after `getModuleBuild` and before
  `selectChatModelForUser`, `if (build.status === "cancelled") return { deferred: false };`
- `apps/web/src/api/module-builds-client.ts`: add `cancelModuleBuild(buildId)`, same pattern as
  `approveModuleBuild`.
- `packages/workshop/src/web/workshop-groups.tsx`: `BuildingNowCard` takes `onStop: (buildId:
string) => void`, wires the existing "Stop" button's `onClick`.
- `packages/workshop/src/web/workshop-page.tsx`: owns the mutation (React Query `useMutation`
  calling `cancelModuleBuild`, invalidating `["workshop","module-builds","mine"]` on success),
  passes a bound callback down to `WorkshopGroups`.
- Tests: (a) unit test for `cancelModuleBuildPlan` — behaviour "throws
  `ModuleBuildNotFoundError` for another owner's build" and "sets status to cancelled for the
  caller's own build" (mirror `tests/unit/*start-build*` existing tests for `approveModuleBuildPlan`
  — confirm filename at build time). (b) route ownership test copying
  `tests/unit/ai-module-build-routes.test.ts:77-100`'s pattern for `/cancel`. (c) jsdom interaction
  test: clicking Stop on a `BuildingNowCard` calls `onStop` with that build's id.

**Task 2.2 — Ask for a change.**

- `packages/workshop/src/web/workshop-groups.tsx`: `LiveModuleRow` takes `onAskForChange:
(moduleId: string) => void`, wires the existing button.
- `packages/workshop/src/web/workshop-page.tsx`: constructs the callback as `(moduleId) => {
navigate("/m/" + moduleId); openChat(); }` using `useNavigate()` (react-router) and
  `useChatControls()` (`apps/web/src/shell/chat-controls-context`), threaded down through
  `WorkshopGroups`.
- Test: jsdom interaction test asserting clicking "Ask for a change" on a `LiveModuleRow` calls
  `onAskForChange` with that module's id (component-level, not asserting the page-level navigate
  wiring — that composition is exercised live).

**Task 2.3 — Turn on for everyone.**

- `packages/workshop/src/web/workshop-groups.tsx`: `LiveModuleRow` takes `onTurnOnForEveryone:
(moduleId: string) => void`, wires the existing gated button (unchanged gating:
  `mod.scope === "you"`).
- `packages/workshop/src/web/workshop-page.tsx`: `useMutation` calling the existing
  `shipExternalModule(moduleId)` client function (`apps/web/src/api/client.ts:451-460`, no changes
  needed there), invalidating `["workshop","modules","mine"]` on success.
- Test: jsdom interaction test asserting the button only renders when `scope === "you"` (already
  true, keep green) and that clicking it calls `onTurnOnForEveryone` with that module's id.

**Task 2.4 — ownership hardening pass.** Grep every route/query touched or added in phases 1-2
against `app.external_modules` for a missing `owner_user_id` filter (expected: none added by this
work touch that table for draft rows — cancel only touches `module_builds`, which has real RLS;
confirm and note the result rather than skip the check).

**Phase 2 e2e test — same live spec, continued.** In the same `tests/live/workshop-1888-uat.spec.ts`
test (not a new 300s build — reuse the one phase 1 already started, to avoid doubling live-AI
cost): after the phase-1 assertions, click Stop on a _second_ build started via a repeated chat ask
in the same test (Stop needs a build still in `building` status to be meaningful; cancelling the
already-finished first build would only prove the ownership check, not the worker's mid-sequence
stop check) — or, if a second full build is too slow for the budget, assert Stop against the first
build once it happens to still be `building` when the test reaches that point, accepting some
flakiness risk, and note this tradeoff in the PR description. Click "Ask for a change" and "Turn on
for everyone" on the resulting draft's `LiveModuleRow` once each finish/ready and assert their
effects (navigation to `/m/<id>` with drawer open; module's `scope` flips to `everyone` and its row
moves out of "you only").

```bash
LIVE_BASE_URL=http://127.0.0.1:5184 LIVE_API_URL=http://127.0.0.1:3033 \
  npx playwright test --config playwright.live.config.ts workshop-1888 > /tmp/live-1888-full.log 2>&1; echo "EXIT=$?"
```

Expected exit code 0.

## UAT trigger map

Add to `.claude/skills/coordinate/uat-trigger-map.tsv`:

```
blocking	packages/workshop/**	tests/live/workshop-1888-uat.spec.ts
blocking	apps/web/src/chat/module-build-plan-record.tsx	tests/live/workshop-1888-uat.spec.ts
blocking	packages/ai/src/module-build/**	tests/live/workshop-1888-uat.spec.ts
```

(Existing rows for `tests/uat/specs/*` are a different, already-established directory — this repo's
Workshop live tests live under `tests/live/*-uat.spec.ts`; point the map there rather than inventing
a duplicate spec under `tests/uat/specs/`.)

## Full verification (before PR)

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
```

Full gate (`pnpm verify:foundation`) only through the `verify-gate` skill, never bare — it hits the
live dev database unscoped.

## Design-system check

Run the design-system skill's audit before touching `workshop-groups.tsx` markup/CSS (spec item 5:
"the page was audited clean and must stay that way"). This plan adds no new CSS classes — new
buttons reuse the existing `jds-btn` variants already present on the same elements; only `onClick`
handlers are new.
