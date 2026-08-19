# Plan: #903 — deterministic primary Sports follow on equal `created_at`

- Issue: #903 (Part of #903)
- Spec: `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` (#903 row + resolved decisions +
  exit criteria)
- Tier: routine
- Coordinator: `Coordinator` (session `019fe31f-18ba-7342-b5dd-83db98923b31`)

## Problem

`selectPrimaryFollow` (packages/sports/src/followed-groups.ts:32-36) sorts candidates by
`createdAt` descending only (`b.createdAt.localeCompare(a.createdAt)`). When two follows share the
same `createdAt`, `Array.prototype.sort` is spec-stable, so the winner is whichever element came
first in the **input array** — not a value-derived tie-break. `groupFollowedTeams`
(followed-groups.ts:41-58) builds that input array in `Map` insertion order over whatever order the
caller passed in, which for the live surface is `SportsFollowsRepository.list()`
(packages/sports/src/repository.ts:24-32), itself ordered only by `created_at desc`
(repository.ts:29). Postgres does not guarantee tie order among equal `created_at` rows absent a
secondary key, so which follow is "primary" for a real tie can vary run to run — the bug in #903.

## Seams check (file:line)

- Comparator to fix: `packages/sports/src/followed-groups.ts:32-36` (`selectPrimaryFollow`).
- Repository order to fix: `packages/sports/src/repository.ts:24-32` (`list()`), single
  `.orderBy("created_at", "desc")` at line 29.
- `id` is a `uuid` string, not a sequence — confirmed `packages/sports/sql/0133_sports_follows.sql:6`
  (`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`) and DTO shape
  `packages/shared/src/sports-api.ts:88-93`. String tie-break must use `localeCompare`, matching
  the existing `createdAt` comparator style (followed-groups.ts:35), not numeric comparison.
- Established two-column Kysely tie-break pattern already in this codebase (the "existing Kysely
  ordering" the spec's resolved decisions point at): `packages/briefings/src/repository.ts:189`
  — `query.orderBy("created_at", "desc").orderBy("id")`. Reuse verbatim (desc created_at, then
  ascending `id` as the default/unmarked direction).
- Existing focused unit test file to extend: `tests/unit/sports-followed-groups.test.ts:62-115`
  (`describe("selectPrimaryFollow", ...)`).
- Repository unit tests are DB-free row→DTO mapping only
  (`tests/unit/sports-repository.test.ts:1-8`, comment at lines 4-7 explains the real round-trip
  is deferred to the DB integration test); the DB-touching RLS round-trip lives in
  `tests/integration/sports-follows-repository.test.ts` and is out of scope per spec non-goals (no
  new migrations/DB test infra) — the repository order change is mechanical and mirrors the
  briefings precedent 1:1, so it ships without a new integration test.
- Collision note (handoff): no sibling owns `followed-groups.ts` / `repository.ts` in this wave —
  exclusive ownership confirmed.

## Determinism boundary

Pure deterministic sort over two persisted scalar fields (`created_at`, `id`). No model call, no
non-deterministic input, no chat turn involved. User-visible effect: which follow renders as
"primary" on the Sports surface becomes stable across reloads instead of occasionally flipping.

## Task 1 — in-memory comparator tie-break

File: `packages/sports/src/followed-groups.ts`

Change `selectPrimaryFollow` to add `id` ascending as the secondary sort key, applied consistently
whether the pool is leagues or the full fallback pool (same function body, same two-key sort):

```ts
export function selectPrimaryFollow(follows: readonly ResolvedFollow[]): ResolvedFollow {
  const leagues = follows.filter((f) => catalogEntry(f.competitionKey)?.kind === "league");
  const pool = leagues.length > 0 ? leagues : follows;
  return [...pool].sort((a, b) => {
    const byCreatedAt = b.createdAt.localeCompare(a.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
  })[0]!;
}
```

Update the comment above the function (followed-groups.ts:29-31) to state the tie-break explicitly
(ascending `id`, matching the repository's secondary `ORDER BY`).

**Signature unchanged** — same params, same return type.

## Task 2 — repository secondary order

File: `packages/sports/src/repository.ts`

`list()` (repository.ts:24-32): add the same two-column order as the briefings precedent:

```ts
.orderBy("created_at", "desc")
.orderBy("id")
```

(replacing the single `.orderBy("created_at", "desc")` at line 29). No other change to `list()`.

## Task 3 — regression test

File: `tests/unit/sports-followed-groups.test.ts`, inside the existing
`describe("selectPrimaryFollow", ...)` block.

New case: two follows with **identical `createdAt`** and different `id`s, asserted in **both**
input orders:

```ts
it("tie-breaks by ascending id when createdAt ties (order-independent)", () => {
  const a = follow({
    id: "b-id",
    teamKey: "a",
    competitionKey: "eng.1",
    createdAt: "2026-06-01T00:00:00.000Z"
  });
  const b = follow({
    id: "a-id",
    teamKey: "b",
    competitionKey: "usa.1",
    createdAt: "2026-06-01T00:00:00.000Z"
  });
  expect(selectPrimaryFollow([a, b])).toBe(b);
  expect(selectPrimaryFollow([b, a])).toBe(b);
});
```

**Why this fails before the fix:** with only a `createdAt` comparator, both elements compare equal
(`0`), so the spec-stable `Array.prototype.sort` preserves input order — `selectPrimaryFollow([a, b])`
returns `a` while `selectPrimaryFollow([b, a])` returns `b`. The two assertions contradict each
other pre-fix (the second fails), proving the result is input-order-dependent, not value-derived.
After the fix both calls return `b` (smaller `id` by `localeCompare`).

## Verification

```bash
pnpm --filter=@moss/sports typecheck > /tmp/903-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

```bash
pnpm vitest run tests/unit/sports-followed-groups.test.ts > /tmp/903-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all cases in `describe("selectPrimaryFollow", ...)` passing including the new one.

```bash
pnpm format:check > /tmp/903-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/903-lint.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` for both (pre-push trio; full gate deferred to wrap-up per `verify-gate`).

## Kill gate

Single phase, no phase 2 planned. If Task 3's regression test does not reproduce the pre-fix
failure (i.e. it passes even without Task 1's change), stop and re-derive the bug before touching
`repository.ts` — owner: this build agent, escalate to `Coordinator` if the repro doesn't hold.

## Live-path proof (required — spec exit criteria)

#903 changes user-visible selection behavior on the real Sports surface. At wrap-up: follow two
competitions via the live dev UI in a way that produces (or is verified against) equal-timestamp
follows, reload, and confirm the same competition renders as primary across repeated loads. Record
via UAT run output + live DOM assertions per `coordinated-build` step 4 / `docs/DEVELOPMENT_STANDARDS.md` →
Live-Path Gate. If no live instance is reachable, report _code-complete, unverified_ explicitly
rather than claiming done.

## Release note

"Fixed: the primary competition shown for a followed club could occasionally change between
reloads when two follows were created at the same instant; selection is now stable."
