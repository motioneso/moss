# Plan — issue #1975: make the three Workshop buttons work

Spec: `docs/specs/1975.md`. Risk tier: sensitive (adversarial QA + Ben merge sign-off).

## Seams check (confirmed on this branch, file:line)

- Three buttons with no click handler at all: "Stop" (`packages/workshop/src/web/workshop-groups.tsx:94-96`,
  inside `BuildingNowCard`), "Ask for a change" (`:113-115`) and "Turn on for everyone"
  (`:116-120`, only when `mod.scope === "you"`), both inside `LiveModuleRow`.
- `ModuleBuildStatus` already has `'cancelled'` in the TypeScript union
  (`packages/settings/src/module-builds-repository.ts:11`) and in the DB check constraint
  (`packages/settings/sql/0189_module_builds.sql:7`). No migration needed.
- Owner-scoped update-only pattern to copy exactly: `shipExternalModule`
  (`packages/settings/src/repository-external-modules.ts:492-514`) — one `UPDATE ... WHERE id = ?
AND status = ? AND owner_user_id = ?`, `numUpdatedRows === 0` means "not found or not yours",
  route maps that to 404. Same non-leak discipline as the rest of that file.
- 404-on-not-updated route pattern to copy: `packages/settings/src/routes-modules.ts:328`
  (`if (!shipped) throw new HttpError(404, "External module not found")`). Do **not** copy the
  existing `/approve` route's shape for the not-found case — `packages/ai/src/module-build-routes.ts:59-78`
  calls an injected function and never checks a not-found case at all; the new `/cancel` route needs
  its own explicit 404 check, not that file's pattern for this part.
- Ship endpoint already exists and needs no backend change: `POST /api/admin/modules/:id/ship`
  (`packages/settings/src/routes-modules.ts:304-330`).
- Worker step: `runModuleBuildStepForJob` (`apps/worker/src/worker.ts:212-266`) fetches the build
  (`:218`), runs the step (`:233-242`), then writes status in the success path (`:243-246`) and in
  the `catch` (`:255-258`). Neither path currently checks for a cancellation that happened while
  the step was running.
- **Correction to the handoff doc's assumption — packages/workshop cannot import
  `apps/web/src/shell/chat-controls-context.tsx` or `apps/web/src/api/client.ts`.** Those are
  `apps/web`-internal files, not published package exports; `packages/workshop/package.json` does
  not depend on `apps/web` and doing so would be a real module-isolation violation, not just a
  style choice. Confirmed the actual pattern in use: `workshop-page.tsx:5` already calls the
  generic `requestJson` from `@moss/module-web-sdk` directly for its own API calls — the new
  cancel and ship calls in `packages/workshop` follow that same self-contained pattern, not
  `apps/web/src/api/client.ts`.
- **Second correction — there is no existing seam for a built-in module page to open the host
  chat drawer**, and none of `packages/*/src/web/*.tsx` import `react-router` or the chat-controls
  context today (checked). `packages/workshop` can add a direct dependency on `react-router-dom`
  for `useNavigate()` — that's a third-party library the host already uses, the same kind of
  direct dependency `packages/workshop/package.json` already takes on `@tanstack/react-query`, not
  a reach into another package's internals. Opening chat is different: it can only happen where
  `openChat` already lives, which is `ExternalModuleMount` in `apps/web/src/app.tsx:384-461` — it
  already holds `openChat` (`:392`) and already wires it to `DraftBanner`'s "Ask for a change"
  button (`:456`). Design: Workshop navigates to the module's own page with a flag in router state;
  `ExternalModuleMount` reads that flag once on mount and opens chat there. This keeps
  `packages/workshop` free of any host-internal import.
- Route path for a running draft's own page: `/m/${moduleId}/*` (`apps/web/src/app.tsx:124`).
- Query keys the Workshop page already reads and must invalidate on success:
  `["workshop", "module-builds", "mine"]` (`packages/workshop/src/web/workshop-page.tsx:33`) and
  `["workshop", "modules", "mine"]` (`:42`).
- Test conventions confirmed present: SSR (`renderToString`) tests in
  `tests/unit/workshop-groups.test.tsx` cannot simulate clicks; `tests/unit/draft-banner.test.tsx`
  is the `react-test-renderer` + `// @vitest-environment jsdom` pattern for click-wiring tests —
  copy its shape into a new file, don't retrofit the SSR one.
- Backend precedent test shapes to copy: `tests/unit/ai-module-build-routes.test.ts` (route test)
  and `tests/unit/settings-module-builds-repository.test.ts` (repository test).

## Determinism boundary

N/A for model output — nothing here touches chat/model turns. The one thing to state plainly in
the spec and PR: "Stop" cannot kill an in-flight build step instantly; it prevents the build from
continuing past the step that is currently running. This is a stated limitation, not a bug.

## Task 1 — repository: `cancelModuleBuild`

File: `packages/settings/src/module-builds-repository.ts` (add after `listModuleBuildsForUser`).

```ts
export async function cancelModuleBuild(
  scopedDb: DataContextDb,
  buildId: string,
  ownerUserId: string
): Promise<boolean>;
```

- Single `UPDATE app.module_builds SET status = 'cancelled', updated_at = now() WHERE id = $1 AND
owner_user_id = $2 AND status IN ('planning', 'building')`, return whether a row was updated.
- Export `ModuleBuildStatus` already includes `'cancelled'` — no type change needed.

Test cases (`tests/unit/settings-module-builds-repository.test.ts`, new `describe("cancelModuleBuild")`):

- cancels a build the caller owns that is `"building"` — returns `true`, row's status becomes
  `"cancelled"`. Fails against a broken implementation that forgets the status filter (would also
  cancel a `"ready"` build).
- returns `false` for a build owned by a different user — proves the ownership guard is real, not
  just documented.
- returns `false` for a build already `"ready"`/`"failed"`/`"cancelled"` — proves the status guard.

## Task 2 — route: `POST /api/ai/module-builds/:buildId/cancel`

File: `packages/ai/src/module-build-routes.ts`, added to `registerModuleBuildRoutes`.

- Owner-scoped via `accessContext.actorUserId`, calls `cancelModuleBuild` directly through
  `dependencies.dataContext` (no job-queue injection needed — cancelling never sends a job).
- `if (!cancelled) throw new HttpError(404, "Module build not found")`.
- Success response: `{ buildId, status: "cancelled" }`.

Test cases (`tests/unit/ai-module-build-routes.test.ts`, new `describe("POST
/api/ai/module-builds/:buildId/cancel")`):

- cancelling the caller's own in-progress build returns 200 with `status: "cancelled"`.
- cancelling a build that does not exist, or belongs to another user, returns 404 — same response
  shape for both (no leak of which case it was).

## Task 3 — worker guard against a cancel racing an in-flight step

File: `apps/worker/src/worker.ts`, inside `runModuleBuildStepForJob`.

- After `getModuleBuild` (`:218`) and the existing not-found check: if `build.status ===
"cancelled"`, return without calling `runModuleBuildStep` and without re-enqueuing.
- Before the success-path `updateModuleBuildStatus` call (`:243`): re-fetch the build; if its
  status is now `"cancelled"`, skip the status write and skip the "finished" notification.
- Before the `catch` block's `updateModuleBuildStatus` call (`:255`): same re-fetch-and-skip, for
  the "failed" notification too.

Test cases (new or extended worker test file covering `runModuleBuildStepForJob`):

- a build already `"cancelled"` when the job runs never calls `runModuleBuildStep` and never
  writes a status.
- a build cancelled by another request while `runModuleBuildStep` is in flight does not get its
  status overwritten back to `"building"`/`"awaiting_change"` when the step resolves — this is the
  regression the re-fetch exists to prevent; a test that mocks `runModuleBuildStep` to resolve
  after the cancel has already landed is what proves it.
- the ordinary (no cancel) success and failure paths still write status and notification exactly
  as before — regression coverage for the existing behavior.

## Task 4 — frontend: Stop and Turn on for everyone

Files: `packages/workshop/src/web/workshop-groups.tsx`, `packages/workshop/src/web/workshop-page.tsx`.

- `WorkshopGroupsProps` gains two optional callbacks:
  ```ts
  readonly onStop?: (buildId: string) => void;
  readonly onTurnOnForEveryone?: (moduleId: string) => void;
  ```
- `BuildingNowCard` and `LiveModuleRow` take the relevant callback as a prop and wire it to the
  existing button's `onClick`. Thread `build.id` / `mod.id` through from the map callsites in
  `WorkshopGroups`.
- `WorkshopPage` gets two `useMutation`s calling `requestJson` directly (same pattern
  `workshop-page.tsx:5,34` already uses), each invalidating `["workshop", "module-builds",
"mine"]` and `["workshop", "modules", "mine"]` on success:
  - `onStop`: `POST /api/ai/module-builds/${buildId}/cancel`.
  - `onTurnOnForEveryone`: `POST /api/admin/modules/${moduleId}/ship`.
- No new "restart required" UI copy — the spec only requires the state to be reflected; reuse
  `hasActiveBuild`-style query invalidation so the button disappears once shipped (module no
  longer has `scope: "you"` after refetch).

Test cases (new file `tests/unit/workshop-groups-actions.test.tsx`, `react-test-renderer` +
`// @vitest-environment jsdom`, copying `tests/unit/draft-banner.test.tsx`'s shape):

- clicking "Stop" on a building card calls `onStop` with that build's id.
- clicking "Turn on for everyone" on a `scope: "you"` module calls `onTurnOnForEveryone` with that
  module's id.
- the button is absent for a `scope: "everyone"` module (existing behavior, regression check).

## Task 5 — frontend: Ask for a change

Files: `packages/workshop/package.json` (add `react-router-dom` dependency, version matching
`apps/web/package.json`'s), `packages/workshop/src/web/workshop-groups.tsx`,
`packages/workshop/src/web/workshop-page.tsx`, `apps/web/src/app.tsx`.

- `WorkshopGroupsProps` gains `readonly onAskForChange?: (moduleId: string) => void;`, wired to
  the existing button in `LiveModuleRow` for every module (not scope-gated).
- `WorkshopPage` implements it with `useNavigate()`:
  `navigate(`/m/${moduleId}`, { state: { openChat: true } })`.
- `ExternalModuleMount` (`apps/web/src/app.tsx:384`): add `useLocation()`, and a `useEffect` that
  runs once on mount — if `location.state?.openChat` is true and `props.isDraft`, call `openChat()`
  then `navigate(location.pathname, { replace: true, state: null })` to clear the flag so it does
  not refire on a later re-render or back-navigation.

Test cases:

- `workshop-groups-actions.test.tsx`: clicking "Ask for a change" calls `onAskForChange` with that
  module's id (every scope, not just `"you"`).
- New or extended `apps/web` test for `ExternalModuleMount` (or the closest existing test file that
  already covers it, e.g. wherever `DraftBanner`'s `onAskForChange={openChat}` wiring is already
  tested): navigating in with `state: { openChat: true }` opens chat; navigating in with no state
  does not.

## Live-path proof (this PR's UAT, exit criteria item)

Manual live-path proof on the dev instance (no automated UAT spec needed — this is three small,
independently-testable click handlers on an existing page, not a new user flow): start a build
from chat, click Stop, confirm it stops; click "Ask for a change" on a live module, confirm it
lands on that module's page with chat open; turn a draft module on for everyone, confirm the
turn-on-for-everyone button disappears after refetch. Recorded as the `LIVE-PATH PROOF` PR comment
per the brief.

## Verification

```bash
pnpm --filter @moss/settings --filter @moss/ai --filter @moss/workshop --filter web --filter worker typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Full gate before wrap-up: via the `verify-gate` skill only, never run directly. Expected: green.

Pre-push trio per `coordinated-build`: `pnpm format:check && pnpm lint && pnpm typecheck`, each
checked for its own exit code, never piped.

## Kill gate

None needed — this is a single-phase, small, additive change (no new database fields, no new
authorization surface, three independent button wirings). If Task 5's router-state approach turns
out not to reliably open chat on the live instance (confirm by testing it live, per the handoff's
own caution), the fallback is calling `openChat()` synchronously right after `navigate(...)` in the
same click handler instead of the state-flag/`useEffect` approach — decide by observation during
Task 5's own live check, not by planning both in advance.
