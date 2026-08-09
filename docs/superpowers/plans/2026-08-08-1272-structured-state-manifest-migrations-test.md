# Plan — #1272: pin structured-state manifest migrations to sql/ on disk

Part of #1272. Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` (#1272 row only).

## Seams check

- `packages/structured-state/src/manifest.ts:26-33` — `structuredStateModuleManifest.database.migrations`
  is a hardcoded array of 6 entries (`sql/0031_structured_state.sql` ... `sql/0175_preferences_revision.sql`).
- `packages/structured-state/sql/` currently contains exactly those 6 files (verified via `ls`,
  sorted): `0031_structured_state.sql`, `0070_commitments_worker_grant.sql`,
  `0093_preferences_worker_runtime_grants.sql`, `0111_preferences_worker_write.sql`,
  `0167_worker_entities_grant.sql`, `0175_preferences_revision.sql`. Array and disk already match —
  no production drift to fix; this is pure regression coverage per the issue's "Test-only; no
  production change expected."
- `packages/structured-state/src/index.ts:16-20` re-exports `structuredStateModuleManifest` from
  `./manifest.js`. `packages/structured-state/package.json` exports `"." -> "./src/index.ts"`, and
  `vitest.config.ts:277-282` aliases `@moss/structured-state` to
  `./packages/structured-state/src/index.ts` — so `import { structuredStateModuleManifest } from "@moss/structured-state"` resolves under vitest the same way chat's does.
- Precedent test — `tests/unit/chat-manifest.test.ts:1-16` — reads `packages/chat/sql` via
  `node:fs/promises` `readdir`, filters to `.sql`, sorts, prefixes `sql/`, and asserts
  `toEqual` against `chatModuleManifest.database.migrations`. This is the "simplest existing module
  migration parity test" the spec (line 37) names as the pattern to reuse; `sports-manifest.test.ts`
  by contrast hardcodes a single-file array with no `readdir`, so it is not a parity test and is not
  the pattern to mirror.
- `packages/structured-state/src/manifest.ts:12` types the const as `: MossModuleManifest` (not
  `satisfies`, unlike chat's `manifest.ts:240`), which widens `database` to the interface's optional
  `database?: ModuleDatabaseManifest` (`packages/module-sdk/src/index.ts:580`) and makes a bare
  `.database.migrations` access a `tsc` error (`possibly 'undefined'`). Existing structured-state
  tests already handle this the same way (`tests/integration/structured-state.test.ts:75,207,250`
  use `?.`/`?? []`); the new test follows that precedent (`database?.migrations`) rather than
  changing the manifest's type annotation, which would be a production change outside scope.
- No existing test file under `packages/structured-state/` (`find packages/structured-state
-iname "*.test.ts"` returns empty) — new file only, no edits to an existing suite.
- `package.json:54` — `test:unit` runs `tsx scripts/test-unit.ts`, which executes `tests/unit/*.test.ts`
  under vitest with no database — matches this test's needs (no DB, no integration harness).

## Non-goals (per spec)

No production change to `manifest.ts` or `sql/`. No generic cross-module manifest-test framework.
No touch to any other module's manifest or test.

## Task 1 — add the parity test

**File:** `tests/unit/structured-state-manifest.test.ts` (new)

Mirrors `tests/unit/chat-manifest.test.ts` exactly, substituting the structured-state package:

```ts
import { readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { structuredStateModuleManifest } from "@moss/structured-state";

describe("structuredStateModuleManifest", () => {
  it("lists every structured-state SQL migration file in order", async () => {
    const sqlFiles = (await readdir("packages/structured-state/sql"))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => `sql/${file}`);

    expect(structuredStateModuleManifest.database?.migrations).toEqual(sqlFiles);
  });
});
```

**Test case behavior:** with the current manifest and sql/ directory, this passes today (array
already matches disk). To prove it actually catches drift (fails-before-fix requirement), the plan
verifies it red/green by temporarily deleting one entry from the manifest's `migrations` array
in a throwaway local check (not committed) and confirming the test fails, then reverting — this
substitutes for "written against a real bug" since there is no live bug to fix here; the
regression-catching behavior is demonstrated instead of exercised against a real prior defect.

**Verification:**

```bash
pnpm exec vitest run tests/unit/structured-state-manifest.test.ts > /tmp/1272-test.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, one passing test.

## Kill gate

None needed — single task, test-only, no phase 2. If the temporary manifest-mutation check (above)
does not fail red as expected, stop and re-derive the test before committing; owner: build agent.

## Verification commands (full)

```bash
pnpm format:check > /tmp/1272-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1272-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1272-typecheck.log 2>&1; echo "EXIT=$?"
pnpm exec vitest run tests/unit/structured-state-manifest.test.ts > /tmp/1272-test.log 2>&1; echo "EXIT=$?"
```

All expected `EXIT=0`.

## Determinism boundary

N/A — no UI, no model-authored content, no user-facing surface. Internal test hardening only, per
issue body ("Not user-visible").

## Exit criteria (from spec)

- One focused regression demonstrated to catch drift (via the temporary red-check above), green
  after.
- No dependency added, no other module touched.
- Release note: not user-visible — internal test hardening (structured-state migration list is now
  pinned to the files on disk, matching the existing chat/sports/connectors/briefings pattern).
