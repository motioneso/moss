# Lane plan: model activity log (classifier gate 3.6a)

- Issue: #2889 (Build plan 3.6a; 3.6b is #2890, not this lane)
- Tier: security
- Branch: `cg-3-6a-activity-log`
- Migration taken: **0254** (verified free on `origin/main` max 0251; open PRs 2886 → chat
  `0252`, 2888 → integrations `0253`)
- Depends on: nothing that is not merged. 3.4 shadow records (`packages/chat/sql/0251_*`) are merged
  but this lane does not read or change them.

## Scope (this lane only)

One flat, append-only table; an admin-gated read endpoint with time paging and
kind/model/result/time filters; the admin-only screen from
`docs/superpowers/mockups/classifier-gate/audit-log.html` (no retention notice); recording at the
provider-adapter boundary only. Ruling 12 (chat answers + background tasks), ruling 14 (kept
indefinitely, no purge), ruling 15 (every model call appears).

Out of scope (3.6b): `generate-choices.ts` system-one fetch, per-turn chat/module-build session
rows, embeddings, provider probes, and the source guard test.

## Seams check (verified on this branch, `file:line`)

- AI module owns model tables and has its own SQL folder: `packages/ai/src/manifest.ts:54`
  (`aiModuleSqlMigrationDirectory`), `:69` (`database.migrations`), `:106` (`ownedTables`).
- Admin-gated route helpers exist: `packages/ai/src/routes.ts:1413` `assertInstanceAdmin`
  throws `HttpError(403)`; precedent `packages/ai/src/provider-visibility-routes.ts:61`.
- Read precedent to mirror: `listActionAuditLog` `packages/ai/src/repository.ts:2308`; route
  `packages/ai/src/routes.ts:784`; schema `packages/shared/src/ai-audit-api.ts:90`; manifest route
  `packages/ai/src/manifest.ts:534`.
- Admin SELECT gate pattern: `infra/postgres/migrations/0059_admin_tables_rls.sql:55-62`
  (`FOR SELECT ... USING (app.current_actor_is_admin())`, permissive INSERT, no UPDATE/DELETE).
- Adapter boundary targets:
  - `packages/ai/src/adapters/http-api.ts:40` `generateChat`, `:63` `generateStructured`,
    `:94` `transcribeAudio`.
  - `packages/chat/src/live/cli-structured-adapter.ts:93` `CliStructuredAdapter`, `:103`
    `generateStructured`, factory `:491`.
- Global sink is a house pattern here (module-level `let` + setter), e.g.
  `packages/ai/src/cli-tools-status.ts:78-81`. Note the opposing caution in
  `packages/module-registry/src/index.ts:3302-3307` about cross-server state in tests — addressed by
  keeping recording injectable per adapter and testing the global only through explicit injection.
- Frontend: settings sections are `ADMIN_GROUPS` in
  `apps/web/src/settings/settings-page.tsx:272-338`, described by `CORE_APP_SETTINGS`
  (`packages/shared/src/app-map-core.ts:94`); admin gate is `me.user.isInstanceAdmin`
  (`settings-page.tsx:389`). Closest UI precedent: `settings-activity-pane.tsx` (feed, filters,
  `.aud__empty` states). `app-map-integrity.test.ts:57` requires every settings-section id to exist
  in `CORE_APP_SETTINGS`.
- Live path: `tests/uat/run-uat.ts` + provisioner support `chatScript`
  (`tests/uat/run-uat.ts:70,124`), which seeds a scripted `openai-compatible` provider
  (`tests/uat/seed/chunks/chat-script.ts`) so a real HTTP model call runs with no external cost.

## Decisions

1. **Table owner = AI module.** Migration `packages/ai/sql/0254_moss_model_activity_log.sql`, table
   `app.moss_model_activity_log`, registered in `packages/ai/src/manifest.ts` `migrations` +
   `ownedTables`. Rationale: it is the module that owns model-call plumbing and the two existing
   log tables (`moss_action_audit_log`, `moss_error_log`).
2. **Instance-global rows, no owner column.** The log is an instance audit trail; rows carry no
   `owner_user_id`. Row security: SELECT only for `jarvis_app_runtime` when
   `app.current_actor_is_admin()`; INSERT permissive for `jarvis_app_runtime` and
   `jarvis_worker_runtime`; no UPDATE/DELETE grant or policy (append-only, kept forever).
3. **Recording is non-blocking and non-failing.** The recorder is invoked _after_ the model call
   settles, returns `void`, and every recorder error is swallowed and logged. The model call is
   never wrapped in a transaction with the write and never awaits it.
4. **Recording lives in the adapter, sink is injectable.** `HttpApiAdapter` takes an optional
   `onModelCall` in its options; the CLI structured adapter takes one via its factory. When absent,
   they fall back to a process-wide recorder installed once at each composition root
   (`registerBuiltInApiRoutes` / `registerBuiltInModuleWorkers`, both of which receive `rootDb`).
   This covers the three central functions and the direct adapter callers without editing each.
5. **What is recorded.** `kind` = call category (`chat` | `structured` | `transcription`); `action`
   = the structured call's `service` when present, else the category; `outcome` =
   `ok` | `error` | `aborted`; `model_name` = `input.model.provider_model_id` (never a hardcoded
   provider/model); `result` = a fixed, allow-listed short line. Raw error messages, prompts,
   messages, tool arguments and credentials are never recorded.
6. **Endpoint.** `GET /api/ai/model-activity` resolves the actor, calls `assertInstanceAdmin`
   (403), then reads through `withDataContext` (RLS is the second lock). Query: `kind`, `model`,
   `result`, `since`, `before`, `limit`. Response carries `entries` plus a `nextBefore` time cursor.
7. **Screen.** A new admin Settings section `modelactivity` ("Model activity"), declared in
   `CORE_APP_SETTINGS` (`scope: "admin"`) and registered in `ADMIN_GROUPS`, rendered from the
   record only, with the mockup's empty and no-match states and no retention notice. Filter options
   for kind/model/result are derived from loaded rows, so no model or provider name is hardcoded.
8. **App map.** Core setting entry for the screen; one `features` entry in the AI manifest for the
   recording behavior. No `navigation` entry (it is a Settings section, not a top-level route).

## Determinism boundary

Every pixel of the screen renders from the stored record. No model output, prompt or message text
feeds the screen, the endpoint, or the table. The recorder is a pure projection of transport facts.

## Tasks

### Task 1 — migration + repository (commit 1)

- New `packages/ai/sql/0254_moss_model_activity_log.sql`: table exactly
  `(id uuid pk, occurred_at timestamptz default now(), kind text, action text, outcome text,
model_name text, result text)`, length CHECKs, `(occurred_at DESC, id DESC)` index plus
  single-column `(kind, occurred_at DESC)`, `(model_name, occurred_at DESC)`,
  `(outcome, occurred_at DESC)` indexes, grants and RLS policies per Decision 2.
- `packages/ai/src/repository.ts`: `insertModelActivity(appDb: Kysely<MossDatabase>, input)` and
  `listModelActivity(appDb, { kind?, model?, result?, since?, before?, limit })`. Read uses a root
  handle because the endpoint still passes actor-scoped `scopedDb` for RLS; write uses the root
  handle from the recorder. (Both accept whichever handle the caller has; the table's RLS decides.)
- Register migration + `app.moss_model_activity_log` in `packages/ai/src/manifest.ts`.
- Test: schema-shape integration assertion that the columns are exactly the seven above (guards
  "a row never carries message text").

### Task 2 — recorder + adapter/CLI recording (commit 2)

- New `packages/ai/src/model-activity.ts`:
  - `type ModelActivityEntry = { kind; action; outcome: "ok"|"error"|"aborted"; modelName; result }`
  - `type ModelActivityRecorder = (entry: ModelActivityEntry) => void`
  - `installModelActivityRecorder(recorder | null)`, `recordModelActivity(entry)` (no-op when
    unset; try/catch; fire-and-forget), `createDbModelActivityRecorder(db, logger?)`, and
    `withModelActivityRecording(recorder, { kind, action, modelName }, run)`.
- `packages/ai/src/adapters/http-api.ts`: add `onModelCall?` to `HttpApiAdapterOpts`; wrap the
  three methods with `withModelActivityRecording`.
- `packages/chat/src/live/cli-structured-adapter.ts`: add `onModelCall?` to the factory/ctor and
  wrap `generateStructured`.
- `packages/module-registry/src/index.ts`: install the DB recorder from `rootDb` in
  `registerBuiltInApiRoutes` (using `server.log`) and `registerBuiltInModuleWorkers` (using
  `deps.logger`).
- Tests (unit): each of the four methods records one entry; a recorder that throws does not change
  the returned value or reject the call; the recorded entry does not contain a sentinel message
  body passed to the adapter.

### Task 3 — endpoint + shared contract (commit 3)

- New `packages/shared/src/ai-model-activity-api.ts`, exported from `packages/shared/src/index.ts`:
  entry DTO, `listModelActivityResponseSchema`, `listModelActivityRouteSchema`.
- `packages/ai/src/routes.ts`: `GET /api/ai/model-activity` guarded by `assertInstanceAdmin`,
  reading through `withDataContext`; clamp `limit` to 1..200 (default 100); no retention floor;
  compute `nextBefore`.
- `packages/ai/src/manifest.ts`: route entry with `permissionId: "ai.manage"`.
- Tests (integration): non-admin → 403; admin → rows; kind/model/result/`since` filters; `before`
  paging; a row dated 400 days ago is still returned.

### Task 4 — screen + app map (commit 4)

- `packages/shared/src/app-map-core.ts`: `CORE_APP_SETTINGS` entry `modelactivity` (scope admin,
  path `/settings?section=modelactivity`).
- `apps/web/src/settings/settings-page.tsx`: new `ADMIN_GROUPS` section (`id: "modelactivity"`,
  label "Model activity", `Pane: ModelActivityPane`) plus a `SECTION_KEYWORDS` entry.
- New `apps/web/src/settings/settings-model-activity-pane.tsx`: day-grouped feed, filters
  (kind/model/result/time), "Load older" via `before`, empty ("No activity yet") and no-match
  ("No lines match these filters" + Clear filters) states, no retention notice. Uses `@moss/ui`
  components and existing `.aud*` layout classes.
- `apps/web/src/api/client.ts` + `query-keys.ts`: `listModelActivity` and `ai.modelActivity`.
- `packages/ai/src/manifest.ts`: one `features` entry describing the log.
- Component test: empty vs populated vs no-match rendering and query-key stability, mirroring
  `tests/unit/settings-activity-pane.test.tsx`.
- UAT spec `tests/uat/specs/2889-model-activity-log.uat.spec.ts` with
  `level: "admin+data", chatScript: "<existing script>"`, and a row in
  `.claude/skills/coordinate/uat-trigger-map.tsv` mapping the pane/adapter paths to it.

### Task 5 — security observation + wrap-up (commit 5)

- Observe each security test failing with its protection removed (record commands + output):
  - non-admin DB read: drop/replace the SELECT policy with `USING (true)` → RLS test sees rows.
  - non-admin endpoint: bypass `assertInstanceAdmin` → test gets 200 instead of 403.
  - row text: make the recorder include `input.messages` → sentinel test finds the message text.
  - failed write: remove the try/catch → the model call rejects.
- Full gate on an isolated gate DB, PR with the live-path proof, report to coordinator.

## Verification commands (unpiped, expected exit codes)

```bash
pnpm typecheck; echo "EXIT=$?"                 # 0
pnpm lint; echo "EXIT=$?"                      # 0
pnpm format:check; echo "EXIT=$?"              # 0
scripts/run-gate.sh start; scripts/run-gate.sh wait --follow   # backgrounded; 0 = green
```

## Kill gate (phase 1 = Tasks 1-2)

If recording at the adapter boundary cannot be made non-blocking without touching every direct
caller, stop and escalate to the coordinator before Task 3. Owner of the kill call: the coordinator.
Rationale: the whole lane's value is decoupling recording from call sites.

## Live-path proof

Stand up an isolated UAT instance via `pnpm test:uat -- tests/uat/specs/2889-model-activity-log.uat.spec.ts`
(never port 1533, never the shared dev database): the harness provisions its own compose stack and
seeds the scripted provider. The spec signs in as admin, sends a chat message (real HTTP call
through `HttpApiAdapter.generateChat`), opens Settings → Model activity, asserts the new row with
its model name and result, and asserts the non-admin path sees no pane. Post the run, exit code and
assertions as a PR comment.

If no working provider path is reachable on an isolated instance, report **code-complete,
unverified** with the exact blocker and do not claim done.
