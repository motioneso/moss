# Plan: harden classifier review storage (#2893)

Three non-blocking QA findings from PR 2888. Routine tier: no migration, no policy change.
Not user-facing, so no live-path proof; the PR says so.

## Seams

- Save path: `packages/integrations/src/repository.ts:266` (`saveClassifierToolReview`) reads the
  row with `getConnection` (`:148`, no lock), checks the cap and version in TypeScript, then
  writes one key with `writePreparationEntry` (`:330`).
- Every repository call already runs inside the request transaction opened by
  `withDataContext` (`packages/db/src/data-context.ts:63`), so a `FOR UPDATE` lock lasts until
  that transaction commits. Precedent: `packages/workflows/src/repository.ts:7`.
- Stored-map reader: `parsePreparationMap` (`classifier-settings.ts:317`) treats the map as empty
  unless it is an object with `version = 1` and an object `entries`.
- Argument parser: `parseArguments` (`classifier-settings.ts:175`) builds a plain `{}`, so
  `out["__proto__"] = ...` hits the prototype setter and the key vanishes.

## Tasks (each test-first; the test is seen failing before the fix)

### 1. A damaged stored map starts a clean list

- Defect: the fresh-start `CASE` in `writePreparationEntry` falls back to a clean object, but the
  inner `COALESCE(classifier_preparation->'entries', ...)` still copies the damaged `entries`
  (an array or a string) back in, and the outer `jsonb_set` then raises a database error.
  A wrong `version` also keeps the old object, so the saved entry stays unreadable.
- Fix: compute the base map once. Reuse it only when it is an object, `version` is 1 and
  `entries` is an object, mirroring `parsePreparationMap`. Otherwise start from
  `{"version": 1, "entries": {}}`. Same rule in `removeClassifierToolReview` (it already no-ops
  on damage, so only the version check is added there if it fits cleanly).
- Test (integration, `tests/integration/integrations-classifier-settings.test.ts`): seed
  `classifier_preparation` through the bootstrap client with each of
  `{"version":1,"entries":[]}`, `{"version":1,"entries":"x"}`, `[]`, `"x"`,
  `{"version":99,"entries":{"turn_on":{}}}`; a save returns `saved` and the row reads back with
  exactly the one new entry.

### 2. The cap and the version are checked under a row lock

- Fix: add a private `lockConnection(scopedDb, id)` that runs
  `SELECT ... WHERE id = $1 FOR UPDATE` and maps the row. `saveClassifierToolReview` uses it in
  place of `getConnection`, so the fingerprint, cap and version checks and the write all happen
  while this transaction holds the row. A second save waits, then reads the first save's result.
- Tests (integration, using the existing bootstrap "locker" pattern at line 271 so both saves
  queue on the row before either reads):
  - Same tool saved twice at once ends at `preparationVersion` 2, and the two results carry
    versions 1 and 2. Fails today with both at 1.
  - Map seeded with 199 valid entries (cap is 200), two different new tools saved at once: one
    `saved`, one `too_many`, and the row holds 200 entries. Fails today with 201.
- The existing "keeps both reviews" test must stay green.

### 3. An argument named `__proto__` is kept, safely

- Fix: `parseArguments` builds its output with `Object.create(null)`, the same approach as
  `entriesRecord` for tool names. The key becomes an own property, survives `JSON.stringify`,
  and cannot touch any prototype.
- Test (unit, `tests/unit/integrations-classifier-settings.test.ts`): parse a body whose
  `arguments` come from `JSON.parse('{"__proto__": {"kind": "extract"}}')`; the result holds an
  own `__proto__` key, `Object.getPrototypeOf({})` is unchanged, and a stored map with that
  argument round-trips through `parsePreparationMap`.

## Verification

- Unit: `pnpm vitest run tests/unit/integrations-classifier-settings.test.ts`.
- Integration and full gate only through the `verify-gate` skill on an isolated gate database.
- Pre-push: `pnpm format:check && pnpm lint && pnpm typecheck`.
