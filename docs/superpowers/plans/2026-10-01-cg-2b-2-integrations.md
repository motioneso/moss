# Build plan: classifier gate 2b.2 — connected-integration owner storage, opt-in and invalidation

Task issue: #2884. Parent spec: `docs/superpowers/specs/2026-10-01-classifier-gate-for-chat.md`.
Parent plan section: `docs/superpowers/plans/2026-10-01-classifier-gate-for-chat.md` → "2b.2 Owner
storage, opt-in and invalidation" (+ "Contracts and invariants", "Rulings"). Ben's rulings 5, 6, 7, 8.

Base branch: `cg-2b-2-integrations`, forked from `origin/main` at `fe6c51777`.

## Goal and boundary

Store the owner's per-connection classifier switch and per-tool reviewed preparation, compute
eligibility and staleness, expose it over the integrations API, and invalidate caches. This slice
is **backend storage only** — no model call (2b.3), no editor UI (2b.4), no runtime menu/dispatch
(2b.5). API responses are reachable only by an authenticated owner, so there is **no user-facing UI
surface and no live-path/UAT proof in this slice**; that proof belongs to 2b.4/2b.6.

Determinism boundary (stated because the slice persists reviewed text): every stored field renders
from the reviewed record; nothing in this slice is produced by a model. 2b.3 produces drafts; this
slice persists only what a person explicitly saves, so a cancelled review leaves nothing stored.

## Seams check (each cited from the current tree)

- Owner-only connection row with FORCE RLS: `packages/integrations/sql/0207_integration_connections.sql:24-36`.
- Repository row/map plumbing: `packages/integrations/src/repository.ts:8-84`, `230-253`.
- Detail projection: `packages/integrations/src/discovery.ts:25-65`.
- Routes + `PATCH` patch builder: `packages/integrations/src/routes.ts:168-186`, `307-344`.
- Resolver cache drop points: `packages/integrations/src/routes.ts:148,181,219,251`;
  cache contract `packages/integrations/src/resolver-cache.ts:11-19`.
- Classifier declaration contract to build against (2b.5 consumes): `packages/module-sdk/src/classifier.ts:16-23,32-72,196-209`.
- SDK barrel already a dependency: `packages/integrations/package.json:12-19`.
- Module migrations are auto-discovered from `packages/integrations/sql/`: `packages/integrations/src/manifest.ts:6-8`,
  `tests/integration/test-database.ts:157-162`.
- Migration catalog must list each file: `tests/integration/foundation-schema-catalog.test.ts:513-517`.
- Manifest routes reconcile with registered routes: `tests/unit/route-coverage.test.ts:99-105`.
- Admin is a distinct actor, not a bypass: `tests/integration/test-database.ts:34-51,220-229`; RLS
  policy is actor-only, so an instance admin is just another actor (Hard Invariant: no admin
  private-data bypass).
- App map rules: `docs/DEVELOPMENT_STANDARDS.md:53-69`; integrity test
  `tests/unit/app-map-integrity.test.ts`.
- Existing owner/web detail fixture to extend: `tests/unit/settings-integrations-pane.test.tsx:52-75`.

No gate/DB command will run except through `scripts/run-gate.sh` (verify-gate skill).

## Decisions

### D1 — New migration number: **0253** (next free on `origin/main`)

`packages/integrations/sql/0253_integration_classifier_settings.sql`. Tell the coordinator the
number taken. Add two columns to the existing owner-only `app.integration_connections`; RLS stays
owner-only and untouched, including for admins; deletion already cascades with the row.

```sql
ALTER TABLE app.integration_connections
  ADD COLUMN classifier_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN classifier_preparation jsonb NOT NULL DEFAULT '{"version": 1, "entries": {}}'::jsonb,
  ADD CONSTRAINT integration_connections_classifier_preparation_object
    CHECK (jsonb_typeof(classifier_preparation) = 'object');
```

Catalog: append `{ version: "0253", name: "0253_integration_classifier_settings.sql" }`.

### D2 — One JSONB map, versioned at the top and per entry

Shape (`packages/integrations/src/classifier-settings.ts`):

```ts
interface ClassifierPreparationMap {
  version: 1;
  entries: Record<string, ClassifierPreparationEntry>;
}
interface ClassifierPreparationEntry {
  optIn: boolean; // default false
  reviewedRisk: "read" | "write" | "outbound" | "destructive" | null; // null = unknown → ineligible
  description: string; // prepared, owner-reviewed, one line
  arguments: Record<
    string,
    { kind: "enum" | "candidates" | "extract"; values?: string[]; candidateSource?: string }
  >;
  replyTemplate: string;
  candidateSource?: string; // optional mapping
  definitionFingerprint: string; // sha256 over the discovered definition (D3)
  reviewedAt: string; // ISO
  preparationVersion: number; // increments on each explicit re-save
}
```

`state` ("current" | "stale") is **derived on read**, never stored: the stored fingerprint is the
source of truth, so staleness cannot drift from the definition it describes. This is the D2 answer
to the plan's "stores … current/stale state".

### D3 — Fingerprint is the discovery-generation token

`toolDefinitionFingerprint(tool)` = `sha256:` + sha256 hex of canonical (recursively key-sorted)
JSON over `{ name, description, group, inputSchema, readOnly, idempotent, destructive }` — the
tool's definitions and relevant annotations, never credentials or `invoke`. New module
`packages/integrations/src/classifier-fingerprint.ts` using `node:crypto` (mirrors
`packages/module-registry/src/external/hash.ts:9-28`, but local to avoid a module→platform import).
Saving a review carries `reviewedFingerprint`; the repository recomputes the current fingerprint
for that tool and **rejects with 409** when it differs or the tool is gone. So an old tab cannot
approve a superseded draft, and a changed definition makes the stored entry stale on the next read.

### D4 — Discovery failure fails closed

Eligibility additionally requires `lastError === null`. A failed refresh keeps the old
`discovered_tools` for ordinary chat but makes every classifier tool ineligible, satisfying "a
discovery failure must not preserve classifier eligibility".

### D5 — Pure eligibility helper (the invalidation core)

```ts
function effectiveClassifierTools(conn: {
  enabled: boolean;
  classifierEnabled: boolean;
  lastError: string | null;
  discoveredTools: readonly DiscoveredTool[];
  classifierPreparation: ClassifierPreparationMap;
}): readonly EligibleClassifierTool[]; // { tool, risk, description, replyTemplate, arguments }
```

A tool is eligible only when: connection enabled, `classifierEnabled`, no discovery error, the
discovered tool still exists, an entry exists with `optIn === true`, `reviewedRisk !== null`, and
the entry fingerprint equals the current fingerprint. Deleted tools drop out (no entry match); new
tools drop out (no entry, default off); unknown risk stays out (ruling 5). 2b.5 consumes this; it
does not authorize execution (ruling 7 is gateway policy, untouched).

### D6 — API surface

`packages/shared/src/integrations-api.ts`:

- `IntegrationDetail` gains `classifierEnabled: boolean` and
  `classifierPreparation: readonly IntegrationClassifierToolPreparation[]` (array, state included,
  for the 2b.4 editor).
- `UpdateIntegrationRequest` gains `classifierEnabled?: boolean` (reuses `PATCH /api/integrations/:id`).
- New `SaveIntegrationClassifierToolRequest` (the reviewed entry + `reviewedFingerprint`).
- Exported types: `IntegrationClassifierRisk`, `IntegrationClassifierArgument`,
  `IntegrationClassifierToolPreparation`, `IntegrationClassifierPreparationState`.

Routes (`packages/integrations/src/routes.ts`; add both to `manifest.ts` `routes[]`):

- `PUT /api/integrations/:id/classifier/tools/:toolName` → validate body, save, drop resolver
  cache, return `IntegrationDetail`; 409 on fingerprint conflict; 404 when not owned/absent.
- `DELETE /api/integrations/:id/classifier/tools/:toolName` → remove entry, drop cache, return detail.
- `PATCH` with `classifierEnabled` → persists + drops cache.

No draft endpoint: cancelled review persists nothing because only the reviewed save writes.

### D7 — Repository methods

`packages/integrations/src/repository.ts`: add `classifierEnabled` + `classifierPreparation` to
`ConnectionRow`, `SELECT_COLUMNS`, `mapRow`, and to `UpdateConnectionInput` (the boolean only).
New methods: `setClassifierEnabled`, `saveClassifierToolReview` (fingerprint compare-and-swap +
merge into the map), `removeClassifierToolReview`. Map writes are bounded (D8). The raw
preparation map is private data: never logged, never a job payload.

### D8 — Bounds

Reuse `CLASSIFIER_LIMITS` from `@moss/module-sdk` (`packages/module-sdk/src/classifier.ts:16-23`):
description ≤ 200, replyTemplate ≤ 200, enum/candidate values ≤ 50. Add module-local bounds:
`INTEGRATION_CLASSIFIER_MAX_ENTRIES = 200`, candidate id/label ≤ 80, per-entry serialized JSON cap.
Reject over-limit input with 400 rather than truncating.

### D9 — App map

- `packages/integrations/src/manifest.ts` `features`: add
  `integrations.connection_classifier_opt_in` (≤ 240 chars) describing per-tool opt-in and the
  owner-reviewed risk, with unknown risk staying out.
- `packages/shared/src/app-map-core.ts` `integrations` setting description: one added sentence
  naming the per-tool classifier opt-in. (No `settings[]` React surface and no `navigation` entry:
  the editor UI is 2b.4.)
- `dataLifecycle.deletion` already lists `app.integration_connections`; new columns inherit the
  cascade, so no lifecycle change is needed (confirmed by
  `tests/integration/module-data-lifecycle-cascade.test.ts:150-151`). Record this in the PR body
  instead of making a no-op edit.

## Tasks (each commits green; explicit `git add` paths)

1. **Migration + catalog.** Add `0253_integration_classifier_settings.sql`; append to
   `foundation-schema-catalog.test.ts`. Verify: `scripts/run-gate.sh` integration later.
2. **Pure module.** `classifier-fingerprint.ts`, `classifier-settings.ts` (map parse/validate,
   bounds, `effectiveClassifierTools`), export from `index.ts`. Unit tests
   `tests/unit/integrations-classifier-settings.test.ts`.
3. **Shared contracts.** `packages/shared/src/integrations-api.ts` additions; fix
   `settings-integrations-pane.test.tsx` `baseDetail` fixtures.
4. **Repository.** Columns, methods, save-conflict result. Integration tests.
5. **Routes + manifest + app map.** Endpoints, validation, cache drops, `manifest.routes`,
   `features`, core setting sentence.
6. **Integration test.** `tests/integration/integrations-classifier-settings.test.ts` (below).

## Test cases (behaviour + the failure each catches)

Unit (`tests/unit/integrations-classifier-settings.test.ts`, expected exit 0):

- Fingerprint stable across key reordering; changes on description / inputSchema / readOnly /
  idempotent / destructive / group change; ignores `invoke`. (Catches a non-canonical hash that
  would silently stale every entry, or one that misses an annotation change.)
- Eligibility: switch off → none; entry `optIn:false` → excluded; `reviewedRisk:null` → excluded;
  stale fingerprint → excluded; `lastError` set → none even with a current entry; removed tool →
  excluded; new tool with no entry → excluded. (Each is one broken-guard case; the unknown-risk
  case is the ruling-5 negative control and must be observed failing with the guard removed.)
- Map/body validation: over-length description/template, > 50 candidates, > 200 entries, bad risk
  string, non-object JSON all rejected.

Integration (`tests/integration/integrations-classifier-settings.test.ts`, via
`scripts/test-integration.ts` under verify-gate isolation, expected exit 0):

- Two owners: each sees only its own switch/preparation; `adminUser` (a third actor) sees neither.
  (Catches an admin/RLS bypass or a missing owner predicate.)
- Forged/other-owner connection id on save/delete → 404, no row written.
- Default off: a fresh connection has `classifierEnabled:false` and no entries.
- Save → read round trip persists every field and `state:"current"`; `preparationVersion`
  increments on re-save.
- Stale save: change `discovered_tools` then save with the old fingerprint → 409 and the stored
  entry is unchanged. (Catches a save that trusts the client's fingerprint.)
- Schema drift: change description/annotations → stored entry reads `state:"stale"` and
  `effectiveClassifierTools` excludes it.
- Discovery failure: `saveDiscovery(..., error)` → `effectiveClassifierTools` returns none while
  ordinary chat still lists the old tools.
- Delete connection → row gone (cascade) with its preparation.
- Route-level: `PUT`/`DELETE`/`PATCH classifierEnabled` against the Fastify harness return the
  updated detail, and `resolverCache.get(actor)` is dropped after each mutation. (Catches a
  mutation that skips cache invalidation.)

## Verification (unpiped; expected exit code beside each)

```bash
pnpm exec vitest run tests/unit/integrations-classifier-settings.test.ts > /tmp/cg2b2-unit.log 2>&1; echo "EXIT=$?"   # 0
scripts/run-gate.sh start   # then: scripts/run-gate.sh wait --follow  (background; exit 0 = green)
scripts/run-gate.sh start --gate typecheck    # exit 0
git diff --check                              # 0
```

The plan's `tests/integration/integrations-classifier-settings.test.ts` and unit file match the
parent plan's "Verification procedure for implementers" row for slice 2b. No piped gate commands.

## Kill gate

If `effectiveClassifierTools` cannot express staleness without a stored per-entry timestamp that
the repository must refresh on every discovery (i.e. lazy derivation proves unworkable against the
real row shape), stop and report to the coordinator before adding a write-on-discovery path. Owner
of that call: the coordinator (it re-slices).

## Out of scope / deferred

- Model draft generation (2b.3), review editor (2b.4), runtime menus/dispatch/candidate hooks
  (2b.5), integrations-screen UAT proof (2b.6) — each has its own task.
- No new approval flow, no change to synthetic `risk: outbound` / `executionPolicy: auto`
  (`packages/integrations/src/tool-manifests.ts:272-275`) — ruling 7 stays a gateway concern.

## Release note (for the PR)

Category: N/A (internal storage; no user-visible surface in this slice).
