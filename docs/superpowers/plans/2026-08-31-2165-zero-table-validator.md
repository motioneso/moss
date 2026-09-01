# Plan — issue #2165: zero-table validator rejects database-less modules

**Locked scope:** Fable verdict comment 5489845245 on issue #2165. One-line validator fix, one
test flip, one new acceptance test. No broader change.

## Seams (file:line, verified current on branch)

- `packages/module-registry/src/external/validate.ts:757-758` — the rejection condition and
  message.
- `tests/unit/external-module-database-declaration.test.ts:71-84` — the `"rejects empty,
oversized, duplicate, and unknown-key database blocks"` case, which includes `{ ownedTables: [] }`
  at line 74.

## Changes

### 1. `packages/module-registry/src/external/validate.ts`

Line 757-758, change:

```ts
if (!Array.isArray(ownedTables) || ownedTables.length === 0 || ownedTables.length > 32) {
  errors.push("database.ownedTables must be a non-empty array of at most 32 table names");
}
```

to:

```ts
if (!Array.isArray(ownedTables) || ownedTables.length > 32) {
  errors.push("database.ownedTables must be an array of at most 32 table names");
}
```

No other lines change. Empty array falls through to the `else` branch, zero-iteration loop,
producing `database = { ownedTables: [] }` — already handled correctly by every downstream
consumer (worker-rpc-host fail-closed on empty, RLS emitter skips grants, table-registry no-ops).

### 2. `tests/unit/external-module-database-declaration.test.ts`

- Remove `{ ownedTables: [] }` from the rejection array at line 74 (it no longer rejects).
- Add one new acceptance test case (new `it(...)` block, placed after the existing "accepts a
  well-formed database declaration" case) asserting:
  - `validateExternalModuleManifest({ ...baseManifest, database: { ownedTables: [] } }, "demo-module")`
  - `result.ok === true`
  - `result.manifest.database?.ownedTables` equals `[]`

No other test cases change. The remaining cases in the "rejects empty, oversized, duplicate, and
unknown-key" block (oversized, duplicate, unknown-key, non-array, bare `[]` for the whole
`database` field) keep failing closed — rename the `it()` description to drop "empty" since it no
longer covers that case.

## Verification

- `pnpm vitest run tests/unit/external-module-database-declaration.test.ts` — focused check,
  observed green before wrap-up.
- Full gate via `verify-gate` skill at wrap-up (isolated gate DB), per handoff exit criteria.

## Out of scope

Normalizing empty arrays to `undefined`, generator changes, any other validator behavior. Per the
verdict: buys nothing, larger diff, not requested.
