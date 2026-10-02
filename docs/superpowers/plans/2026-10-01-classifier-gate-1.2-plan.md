# Build plan — 1.2 Classifier gate setting contract and storage (#2881)

Slice 1.2 of `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md`. Ben's ruling 1
(admin-wide, one instance-wide switch beside the Classifier binding, through the existing admin
configuration boundary; off is the default; reject turning on without an approved tool release
record). This task is contract, storage, API and checks only. No chat execution changes. No UI.

## Seams confirmed on this branch (file:line)

- Instance admin config surface is the runtime-config boundary —
  `packages/settings/src/runtime-config-keys.ts:23` (`RUNTIME_CONFIG_REGISTRY`, typed entries with
  `enumValues`/`defaultValue`/`envVar`/`moduleOwner`), resolver
  `packages/settings/src/runtime-config-resolver.ts:43` (`resolveEnum`), routes
  `packages/settings/src/runtime-config-routes.ts:98` + `:118` (admin-guarded GET/PUT by key).
- Instance setting keys registry: `packages/settings/src/instance-settings-keys.ts:14`.
- Admin guard used by the boundary: `packages/settings/src/routes.ts` `assertAdminUser`, already
  re-used by `runtime-config-routes.ts:107,132`.
- Classifier binding storage: `SORTING_SERVICE_KEY = "sorting"` (`packages/shared/src/ai-types.ts:142`),
  written via `repository.setServiceBinding` (`packages/ai/src/repository.ts:292` region) and served
  by `packages/ai/src/capability-route-routes.ts:102`. The switch's _storage_ sits in the settings
  boundary; its _association_ with the binding is naming + help text, not a new coupling.
- Release-eligibility concept is defined but unbuilt: plan 4.2 (`…classifier-gate-for-chat.md:670`)
  persists "reviewed tool/configuration versions as release eligibility, empty by default; enforce it
  server-side alongside the state." No table or type exists yet.
- Owner-module SQL + migration manifest pattern: `packages/chat/sql/0251_chat_classifier_shadow_records.sql`
  and `packages/chat/src/manifest.ts:38`.
- Shared chat contract file: `packages/shared/src/chat-api.ts` (types + JSON schemas).
- App map: `packages/shared/src/app-map-core.ts` (screens `:199`, errors/remediations `:325`),
  `packages/ai/src/manifest.ts:108` (settings) and `:121` (features).

## Design fork — where the switch and the release record live

**Option A (chosen): enum key in the runtime-config registry, release record as a new chat-owned
table read through the settings/chat boundary.**

- Switch: new enum entry `chat.classifier_gate_mode` in `RUNTIME_CONFIG_REGISTRY`, values
  `off`/`shadow`/`on`, `defaultValue: "off"`. Reuses the admin config boundary verbatim.
- Release record: new table `app.chat_classifier_release_eligibility`, owned by the chat module,
  empty by default. A chat-owned repository function reads it. The activation check lives server-side
  in the settings runtime-config PUT path (branch on key).

**Option B (rejected): store both as one JSON blob under `chat.classifier_gate`.**
Rejected because an enum key gets write-validation, an env fallback and a description for free, and a
blob would need a bespoke validator plus would blur the "state" and "eligibility" lifetimes (state
rolls back to off freely; eligibility is set only by the 4.2 release process and must outlive
rollbacks). Steelman of B: one row is simpler to read atomically. Counter: the record is only _read_
during a PUT, never in the chat hot path, so atomicity buys nothing and the enum registry already
exists for exactly this.

The settings boundary may not import chat module internals (module isolation). The activation check
is therefore passed in as an injected port on the routes' dependencies, wired at the composition root
the same way `dependencies.env` and `dependencies.onConfigChanged` already are
(`runtime-config-routes.ts:22`). The port's concrete implementation lives in the chat module and reads
its own table.

## Determinism boundary

- Every value returned to a caller comes from the stored record (`RuntimeConfigResolver.getStatus` /
  the release-eligibility row), never from a model. This task adds no model call at all.
- No guidance text and no prompt in this task; the help text for the setting is authored copy for the
  app map, not model output.

## Contract

Add to `packages/shared/src/chat-api.ts`:

```ts
export type ClassifierGateMode = "off" | "shadow" | "on";
export const CLASSIFIER_GATE_MODES: readonly ClassifierGateMode[] = ["off", "shadow", "on"];
export const CLASSIFIER_GATE_MODE_DEFAULT: ClassifierGateMode = "off";
```

One approved tool release record, as the shape the 4.2 task will fill:

```ts
export interface ClassifierToolReleaseRecord {
  readonly moduleId: string;
  readonly toolName: string;
  /** Reviewed classifier/configuration version this approval was granted for. */
  readonly classifierConfigVersion: string;
  readonly approvedAt: string; // ISO-8601
  readonly approvedByUserId: string;
}
```

Accepted-activation rule (stated as a decision; the implementation is small):

```
activationAllowed(mode, eligibleRecords):
  mode !== "on"                                  -> true        (off/shadow always allowed)
  mode === "on"  and at least one eligible record -> true
  mode === "on"  and no eligible record           -> false (reject 409/400)
```

## Task 1 — shared contract (no behavior)

Files: `packages/shared/src/chat-api.ts`.

- Add the `ClassifierGateMode` type, `CLASSIFIER_GATE_MODES`, `CLASSIFIER_GATE_MODE_DEFAULT`, and
  `ClassifierToolReleaseRecord` above. Export them from the package index if that index lists
  chat-api symbols explicitly.
- No route schema in `chat-api.ts`: the switch rides the existing `/api/admin/runtime-config/:key`
  routes, whose schema is `getRuntimeConfigRouteSchema` / `putRuntimeConfigRouteSchema`
  (`packages/shared/src/runtime-config-api.ts` or wherever those resolve — confirm at build time).

**Test (behaviour):** a unit assertion that `CLASSIFIER_GATE_MODES` is exactly `["off","shadow","on"]`
and the default is `"off"`. Fails against a renamed/missing default.

## Task 2 — storage: enum key in the registry

Files: `packages/settings/src/runtime-config-keys.ts`, `packages/settings/src/instance-settings-keys.ts`.

- Add `export const CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY = "chat.classifier_gate_mode";` and a registry
  entry: `type: "enum"`, `defaultValue: "off"`, `enumValues: ["off","shadow","on"]`,
  `envVar: "MOSS_CHAT_CLASSIFIER_GATE_MODE"`, `moduleOwner: "chat"`, label
  `"Classifier gate"`, description naming that every user's eligible messages reach the classifier
  provider when on and that on requires an approved tool release.
- `instance-settings-keys.ts` already spreads `RUNTIME_CONFIG_REGISTRY`, so no second edit is needed;
  confirm the new key appears there via the spread (`:25`).

**Tests (behaviour):** registry test (mirror `tests/unit/runtime-config-registry.test.ts`) asserting
the entry exists, is an enum, default is `"off"`, and enum values are exact. Resolver test
(mirror `tests/unit/runtime-config-resolver.test.ts`) asserting a missing row resolves to `"off"`,
a stored `"shadow"`/`"on"` resolves, and an invalid stored value throws.

## Task 3 — storage: release eligibility table (chat, empty by default)

Files: `packages/chat/sql/<next>_chat_classifier_release_eligibility.sql`,
`packages/chat/src/manifest.ts` (migration list + ownedTables), a reader in
`packages/chat/src/classifier-release-repository.ts`.

DDL (decision — hash-checked once applied):

```sql
CREATE TABLE IF NOT EXISTS app.chat_classifier_release_eligibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id text NOT NULL CHECK (length(btrim(module_id)) > 0),
  tool_name text NOT NULL CHECK (length(btrim(tool_name)) > 0),
  classifier_config_version text NOT NULL CHECK (length(btrim(classifier_config_version)) > 0),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  CONSTRAINT chat_classifier_release_eligibility_unique
    UNIQUE (module_id, tool_name, classifier_config_version)
);
```

- RLS: instance-global, admin-readable and admin-writable, mirroring `app.instance_settings`
  (`infra/postgres/migrations/0059_admin_tables_rls.sql:27-46`): SELECT to `jarvis_app_runtime` +
  `jarvis_worker_runtime` `USING (true)` (workers may need to read eligibility at dispatch time in
  later slices); INSERT/UPDATE/DELETE to `jarvis_app_runtime` gated by `app.current_actor_is_admin()`.
  Empty by default — no seed rows.
- Reader signature:

```ts
export interface ClassifierReleaseEligibilityRepository {
  hasEligibleRelease(scopedDb: DataContextDb): Promise<boolean>;
  listEligibleReleases(scopedDb: DataContextDb): Promise<ClassifierToolReleaseRecord[]>;
}
```

**Migration number is assigned by the coordinator** — do not assume it. Placeholder `<next>`; use the
number the coordinator gives at landing order.

**Tests (behaviour):** an integration test that the table starts empty and `hasEligibleRelease`
returns false; inserting a row makes it true; a non-admin actor cannot insert (RLS). Fails if the RLS
policies are dropped or the default becomes non-empty.

## Task 4 — activation check wired into the settings boundary

Files: `packages/settings/src/runtime-config-routes.ts`, the composition root that constructs
`RuntimeConfigRoutesDependencies` (grep for where `registerRuntimeConfigRoutes` is called).

- Extend `RuntimeConfigRoutesDependencies` with an optional port:

```ts
readonly classifierActivation?: {
  readonly hasEligibleRelease: (scopedDb: DataContextDb) => Promise<boolean>;
};
```

- In the PUT handler, after `validateRuntimeValue` and **inside** the admin-scoped `withDataContext`
  (so the release read shares the actor's RLS context), add: when `key === CHAT_CLASSIFIER_GATE_MODE_CONFIG_KEY`
  and the trimmed value is `"on"`, call `classifierActivation.hasEligibleRelease(scopedDb)`; if it
  returns false, throw `HttpError(409, "<message>")` before any write. No write, no audit row.
- Wire the port at the composition root to the chat reader. If the port is absent (older wiring,
  tests), `on` is rejected — fail closed, never fail open.
- `onConfigChanged` is unchanged; it still fires only after a successful write.

**Tests (behaviour):** unit route test (extend `tests/unit/runtime-config-routes.test.ts`) covering:
off and shadow always accepted; `on` rejected with 409 when no eligible release; `on` accepted when
the port reports an eligible release; a forged direct PUT with `on` and no release is rejected;
non-admin PUT is rejected by the existing admin guard (unchanged). Fails against a check placed
outside the transaction, a fail-open default, or a bypass on a second code path.

## Task 5 — app map truthfulness (same PR)

Files: `packages/shared/src/app-map-core.ts`, `packages/ai/src/manifest.ts`,
`packages/chat/src/manifest.ts`.

- Core screen `aiproviders` (`app-map-core.ts:199`): add one sentence describing the Classifier gate
  switch beside the Sorting model row — off by default, off/shadow/on, on requires an approved tool
  release, and when on every user's eligible messages reach the classifier provider.
- `packages/ai/src/manifest.ts` features (`:121`): add a feature entry `ai.classifier_gate_setting`
  describing the switch, its scope, permissions, locked activation, and remediation.
- Add an error + remediation pair: code `ai.classifier_gate.not_released` (class `prerequisite`),
  remediation telling an admin that turning the gate on needs an approved tool release from the
  review step; path `/settings?section=aiproviders`.
- `packages/chat/src/manifest.ts` features: extend/add `chat.classifier_gate` describing the
  instance-wide setting and that release eligibility gates `on`.

**Test (behaviour):** the app-map test suite (grep for the existing app-map test) asserts the new
feature/error/remediation ids resolve and every referenced `remediationRef` exists. Fails if an
error points at a missing remediation.

## Verification

Gate runs only through the `verify-gate` skill, never piped:

```bash
# scoped unit/integration checks for the touched packages
pnpm --filter @moss/settings test > /tmp/cg12-settings.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm --filter @moss/chat test     > /tmp/cg12-chat.log     2>&1; echo "EXIT=$?"   # expect 0
# full local gate via the skill (fresh isolated DB, detached, sentinel wait)
scripts/run-gate.sh verify:foundation                                            # expect 0
```

`tests/uat/specs/classifier-settings.uat.spec.ts` is task 1.3 and is out of scope here.

## Kill gate

No live behavior ships in this task, so the kill gate is the coordinator's review of the acceptance
tests in Tasks 2 and 4: if the activation check cannot be made to reject a forged `on` while still
accepting `off`/`shadow`, the setting contract is wrong and task 1.3 stops. Owner: coordinator.

## Out of scope

- The settings screen row and rename (task 1.3).
- Writing release-eligibility rows (task 4.2).
- Any chat execution, classifier call, or shadow record change.
