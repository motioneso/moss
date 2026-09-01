# Plan: fix issue 2166 standings picker test race

**Scope:** test-only. No production code changes. Locked decision from Fable verdict
comment 5489854528 on issue #2166.

## Root cause (verified against this branch)

`tests/unit/sports-standings-picker.test.tsx` builds three `QueryClient` instances (lines 217,
265, 311) with `defaultOptions: { queries: { retry: false } }` only. Default `staleTime` is 0, so
seeded cache data is stale the instant each component mounts, and the mount-time `useQuery` GET
races the component's own fetch stub. Confirmed: all three constructors currently lack
`staleTime`.

## Change

One-line edit per constructor (3 total), test file only:

```ts
new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
```

Applies to the tests at (current) lines 217, 265, 311.

## Regression check

In "curates standings with available and selected multi-select lists" (line 264), after the
existing `await vi.waitFor(...)` assertion, add:

```ts
expect(fetch).toHaveBeenCalledTimes(1);
```

This turns the previously-silent mount-time GET race into a deterministic failure if it recurs.

## Verification

```bash
npx vitest run tests/unit/sports-standings-picker.test.tsx > /tmp/standings-test.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all 6 tests pass.

Then the pre-push trio and one full safe gate via `verify-gate` per `coordinated-wrap-up`.

## Kill gate

If `staleTime: Infinity` + the call-count assertion does not make the test deterministic (e.g.
still flakes under repeated `--repeat-each` runs), stop and escalate to the coordinator rather than
widening scope into production code — that would break the "test race, not production regression"
finding from the verdict.

## Out of scope

No changes to `packages/sports/src/settings/standings-leagues.tsx` or any other production file.
