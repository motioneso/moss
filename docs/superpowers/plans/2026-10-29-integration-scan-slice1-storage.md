# Integration scan slice 1 - storage and contracts

- Issue #3844, slice 1 of 6 in `docs/superpowers/specs/2026-10-29-integration-scan-and-action-asking.md`.
- Scope is storage and contracts only. No behaviour change. Every connection asks exactly as today.
- No user-visible surface, so no app-map change and no live-path proof. The spec section 4 changes land with the slices that ship those surfaces.

## Seams check

Every fact below was read in this worktree on 2026-10-29.

- The connection row already holds two versioned JSON maps. The preparation map came from `packages/integrations/sql/0253_integration_classifier_settings.sql:9-15` and the sort map from `packages/integrations/sql/0268_integration_classifier_sort.sql:9-15`. Both default to an empty versioned map and carry an object check. The new column follows that shape.
- Row-level security does not change. The spec states the row is already owner-only with no admin bypass (spec section 2.4), and both earlier migrations note the new columns inherit that policy.
- The highest migration number on main is 0345 (`packages/chat/sql/0345_chat_heartbeat_worker_publish.sql`). An open pull request already claims 0346 and another claims up to 0352, so the file uses 0353. It lives in the owning module at `packages/integrations/sql/0353_integration_classifier_scan.sql`, per the rule in CLAUDE.md that module SQL lives in the owning module.
- The old maps are read and written defensively in one place. `packages/integrations/src/classifier-settings.ts` holds the preparation map (line 46 onward), the sort map (line 566 onward), `parsePreparationMap`, `parseSortMap`, `toolSortState`, `withSortResult` and `toolRunsWithoutAsking`. That file is 929 lines, so the scan shapes go in a new file instead of pushing it past 1000.
- The send choice lives on the sort entry as `sendWithoutAsking` (`classifier-settings.ts:581`), and it counts only while the raised risk is outbound (`classifier-settings.ts:732-733`, `classifier-settings.ts:775`). That is the rule the conversion must match.
- Two fingerprints exist. The preparation entry keys on the tool definition fingerprint from `packages/integrations/src/classifier-fingerprint.ts:29`. The sort entry keys on the risk-input fingerprint from `packages/integrations/src/classifier-risk-inputs.ts:37`. Spec section 2.4 keys a scan action on the fingerprint of the tool definition, so the scan map uses the definition fingerprint.
- Persistence goes through `packages/integrations/src/repository.ts`. It selects both maps (`repository.ts:147-148`), parses them in `mapRow` (`repository.ts:555-557`), and writes the sort map under a row lock in `writeSort`. The scan column joins the same select and parse path. No new write path is needed in this slice because nothing writes the map yet.
- The old-column conversion precedent is `packages/integrations/sql/0269_integration_classifier_sort_convert.sql`. Spec section 5.1 says conversions happen in code, not in the migration, and read the old maps where they are read today. So the conversion is a pure function over the two parsed maps. No SQL backfill.
- Existing tests to extend sit in `tests/unit/integrations-classifier-settings.test.ts` and `tests/unit/integrations-classifier-sort.test.ts`. The new tests go in `tests/unit/integrations-classifier-scan.test.ts`.

## Decisions

### DDL

```sql
ALTER TABLE app.integration_connections
  ADD COLUMN classifier_scan jsonb NOT NULL DEFAULT '{"version": 1, "actions": {}, "targets": {}}'::jsonb;

ALTER TABLE app.integration_connections
  ADD CONSTRAINT integration_connections_classifier_scan_object
  CHECK (jsonb_typeof(classifier_scan) = 'object');
```

No existing column changes. No applied migration is edited. Deleting a connection deletes the map with the row.

### Scan map shapes

New file `packages/integrations/src/classifier-scan.ts`, exported from `packages/integrations/src/index.ts`. It imports the parsed old-map types from `classifier-settings.ts` and never the reverse, so there is no cycle.

Types, names only:

- `ClassifierActionKind` - `"read" | "write" | "guarded" | "outbound" | "destructive" | "unknown"`. The first four reuse today's risk words so a converted sort maps one to one and the later gate keeps its confidence bars. `guarded` and `unknown` are new. Spec section 1.2 is the meaning of each word.
- `ClassifierActionMark` - `"ask_first" | "run_without_asking"`.
- `ClassifierScanAction` - one action. Fields: `key`, `kind`, `readableName`, `description`, `replyTemplate`, `arguments`, `decidingValues`, `definitionFingerprint`, `scannedAt`, `mark`. The mark is `{ choice, fingerprint } | null`, where the fingerprint is the action's definition fingerprint. A changed action therefore carries a mark that no longer matches, which is how slice 4 will drop it (spec sections 2.5 and 3.1).
- `ClassifierScanTargetList` - one listing source. Fields: `sourceTool`, `definitionFingerprint`, `readAt`, `entries`. Each entry is `{ id, label }` only. No raw listing reply, no credential, no address (spec section 2.4).
- `ClassifierScanMap` - `{ version: 1, actions, targets }`. Actions nest by tool name then action key. Targets key by listing source. Both records are null-prototype, matching the existing guard against tool names such as `toString` and `__proto__` in `classifier-settings.ts:100-113`.

Functions, signatures only:

- `emptyScanMap(): ClassifierScanMap`
- `parseScanMap(raw: unknown): ClassifierScanMap` - a map of the wrong shape reads as empty, and a malformed action or target list is dropped. That matches `parseSortMap` and `parsePreparationMap`. Failing closed keeps a damaged column from becoming eligibility.
- `scanAction(map, toolName, actionKey)` and `scanTargetList(map, source)` - own-key lookups only.
- `scanMapFromLegacy(sort: ClassifierSortMap, preparation: ClassifierPreparationMap, tools: readonly IntegrationToolDescriptor[]): ClassifierScanMap` - the conversion. Pure. No database, no model.
- `withScanAction(map, toolName, action)` and `withScanTargetList(map, source, list)` - bounded writers for later slices, so the write shape is settled now and tested now. They refuse a new tool past the bound and return the map unchanged, matching `withPreparationEntry`.

Bounds reuse the existing constants. Actions per connection use `INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES`. One entry's JSON uses `INTEGRATION_CLASSIFIER_MAX_ENTRY_JSON_CHARS`. Target entries per list use `INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES`. Slice 3 owns the warn-not-block change in spec section 2.6, so this slice keeps the storage bound and changes no user wording.

### Conversion rules

One action per tool, keyed `"tool"`, and only where the tool has no deciding argument. This slice has no action splitting, so deciding arguments are read from the tool's input schema. A top-level property whose schema carries a non-empty `enum` is a deciding argument. A tool with one is left out of the conversion and asks as it does today until slice 2 scans it (spec section 5.1).

For a converted tool, all of these must hold:

- The sort state is current against the tool's risk inputs, using `toolSortState`. Stale, failed and never-tried sorts convert to nothing.
- The kind is the sort's raised risk, mapped one to one: read, write, outbound and destructive keep their word. Guarded never comes out of a legacy sort because the old sort has no such group.
- The preparation entry exists and its definition fingerprint matches the tool's current fingerprint. Its `description`, `arguments` and `replyTemplate` seed the action, and its `candidateSource` is dropped. A candidates argument keeps its own source name inside `arguments`, which is where slice 3 reads the wiring.
- `readableName` comes from the current sort. `decidingValues` is empty. `scannedAt` is the preparation's `reviewedAt`. `definitionFingerprint` is the preparation's fingerprint.
- The mark is set only when the sort entry's raised risk is outbound and `sendWithoutAsking` is true (spec sections 3.1 and 5.1). The mark is `run_without_asking` with the action fingerprint. Every other converted action has no mark.
- A tool with none of the above converts to nothing. Its scan map stays empty and it asks everywhere it asked before.

Nothing reads the new map for asking in this slice. `toolRunsWithoutAsking`, the gateway and the gate are untouched.

### Repository wiring

- `ConnectionRow` gains `classifierScan: ClassifierScanMap`.
- `ConnectionSqlRow` gains `classifier_scan: unknown`, `SELECT_COLUMNS` gains the column, and `mapRow` parses it with `parseScanMap`.
- No route, manifest, or shared API shape changes. The column never reaches a frontend response in this slice.

## Tasks

1. Migration 0353 plus a repository read of the new column.
2. `classifier-scan.ts` with the read and write shapes, exported from the module index.
3. `scanMapFromLegacy` with the conversion rules above.
4. Unit tests in `tests/unit/integrations-classifier-scan.test.ts`.
5. Gate, PR, report. No slice 2 work.

## Test cases

Each case names the break it catches:

- A stored sort, a stored send choice and a stored preparation read across into one action with the right kind, text, arguments, reply wording and a `run_without_asking` mark. Catches a dropped field or a mark set on the wrong kind.
- A send choice on a tool sorted as anything but Sends something out converts to no mark. Catches the generalised setting leaking onto tools that never asked.
- A stale sort, a failed sort, a never-tried sort and a preparation whose fingerprint has moved on each convert to nothing. Catches a converted action outliving the definition it was made against.
- A tool with an enum-typed argument converts to nothing. Catches slice 1 inventing actions for a tool that needs real splitting.
- A connection with no sort, no send choice and no preparation converts to an empty map. Catches a crash or a phantom action on the common empty row.
- Malformed stored scan data reads as empty, and one malformed action does not take down a well-formed sibling. Catches trusting a damaged column.
- A tool named `__proto__` or `toString` round-trips through parse and lookup as an own key. Catches prototype pollution from a server-chosen name.
- A mark whose fingerprint does not match the action is stored as data and reported as not matching by a small helper the conversion tests use. Slice 4 owns acting on it, so this slice only proves the fingerprint is carried.

## Determinism boundary

No model call, no prompt and no UI in this slice. All feedback renders from the record, which is unchanged. The model gets no new job.

## Verification

Unpiped, expected exit code 0 unless stated:

```bash
pnpm install
npx vitest run tests/unit/integrations-classifier-scan.test.ts > /tmp/scan-unit.log 2>&1; echo "EXIT=$?"
npx tsc --noEmit > /tmp/scan-tsc.log 2>&1; echo "EXIT=$?"
npx eslint packages/integrations/src/classifier-scan.ts packages/integrations/src/repository.ts tests/unit/integrations-classifier-scan.test.ts --max-warnings=0 > /tmp/scan-lint.log 2>&1; echo "EXIT=$?"
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
```

The gate runs as one background call per the verify-gate skill. Its exit code is the verdict. A green local gate excludes CI's e2e step, and this slice has no browser surface.

## Kill gate

Stop and go back to the coordinator before merging if any test shows a converted connection asking differently from today, or if a converted mark lands on an action that is not Sends something out. The owner of the call is the coordinator. Slice 1 ships alone and slices 2 to 6 are not planned in detail here.
