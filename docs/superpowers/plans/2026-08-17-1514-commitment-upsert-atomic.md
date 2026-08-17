# Plan — #1514 Make commitment candidate upsert atomic

Spec: `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` §C1 (lines 143-157).
Issue: #1514 (`Part of #1137`). Risk tier: routine. Live-path: not applicable (internal worker
repository method, no UI surface) — stated explicitly in wrap-up per handoff.

## Seams check (file:line citations, current tree)

- Current SELECT-then-UPDATE/INSERT: `packages/commitments/src/repository.ts:23-62`
  (`CommitmentsRepository.upsertCandidate`). Confirmed still present — spec premise holds.
- Unique constraint the upsert must conflict on: `packages/commitments/sql/0125_commitment_candidates.sql:45`
  — `CONSTRAINT uq_candidate_owner_sig UNIQUE (owner_user_id, candidate_signature)`.
- `assertDataContextDb` narrowing pattern already used by every method in this file:
  `packages/commitments/src/repository.ts:20` (import line 1).
- Existing `INSERT ... ON CONFLICT ... DO UPDATE SET <col> = sql<T>\`table.col + 1\``precedent
in this codebase (same increment-on-conflict shape this task needs):`packages/connectors/src/action-suppression-repository.ts:137-142`
(`dismissal_count: sql<number>\`email_action_suppression.dismissal_count + 1\``).
- `rowToCandidate` mapper to reuse unchanged: `packages/commitments/src/repository.ts:238-260`.
- Existing tests to extend, not replace: `tests/integration/commitments.test.ts:32-83`
  (`describe("upsertCandidate", ...)`, includes the sequential re-upsert case at line 61 that
  must keep passing).
- Test harness gives two live connections for concurrency: `tests/integration/commitments.test.ts:22`
  (`createDatabase({ ..., maxConnections: 2 })`), and `DataContextRunner.withDataContext` per-call
  scoping is the existing pattern used by every test in this file (e.g. line 35).
- No migration needed — constraint already exists (cited above), spec confirms "no new migration."

No open questions; every capability the plan needs is already present and cited.

## Task 1 — Atomic upsert in `packages/commitments/src/repository.ts`

Replace `upsertCandidate` (lines 16-63) with a single `insertInto(...).onConflict(...)` statement.
Delete the SELECT-then-branch entirely — no follow-up SELECT, no `23505` catch.

Signature is unchanged:

```ts
async upsertCandidate(
  scopedDb: unknown,
  input: UpsertCandidateInput
): Promise<CommitmentCandidate>
```

Behavior contract:

- `values(...)`: same fields as today's insert branch (`packages/commitments/src/repository.ts:46-58`),
  `source_count: 1`, `first_seen_at: now`, `last_seen_at: now`.
- `.onConflict((oc) => oc.columns(["owner_user_id", "candidate_signature"]).doUpdateSet({...}))`:
  - `source_count: sql<number>\`app.commitment_candidates.source_count + 1\``
  - `last_seen_at: now`
  - `updated_at: now`
  - No other column in the `doUpdateSet` — `title`, `kind`, `confidence`, `due_local_date`,
    `counterparty_label`, `suggested_handling`, `first_seen_at`, `id` all stay at their existing
    (pre-conflict) values by omission, which is what "preserve the canonical row" means under
    Postgres `ON CONFLICT DO UPDATE` (unset columns are untouched).
- `.returningAll().executeTakeFirstOrThrow()`, pass straight to the existing `rowToCandidate`.
- Add `import { sql } from "kysely";` alongside the existing `assertDataContextDb` import.

## Task 2 — Concurrency test in `tests/integration/commitments.test.ts`

Add one `it` inside `describe("upsertCandidate", ...)` (after the existing "increments
sourceCount on re-upsert" case at line 83):

- Name: `"resolves two concurrent upserts of the same signature to one row with no 23505"`.
- Build one `input` object with a fresh `candidateSignature` (same shape as the existing dedup
  test at lines 63-73).
- Fire two upserts concurrently, each in its own `dataContext.withDataContext(...)` call, via
  `Promise.all([...])` — not sequential `await`s — so both hit the DB before either commits.
- Assert: both promises resolve (no thrown `23505`); both results have the same `id`;
  `sourceCount` is `2` on at least one resolved result (the higher of the two, since one write
  observes the other's effect); a follow-up `getCandidate` (or `listCandidates`) call confirms
  exactly one row exists for that signature with `sourceCount === 2`.
- This test fails against the current SELECT-then-branch code (both transactions can read
  "not existing" before either writes, producing a duplicate-key `23505` or two rows) and passes
  against Task 1's single-statement upsert — that's the behavior difference under test.

## Verification

Focused test only, on an isolated gate DB per the repo's guarded procedure (never unscoped):

```bash
pnpm --filter @moss/commitments typecheck > /tmp/1514-typecheck.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

```bash
pnpm check:file-size > /tmp/1514-filesize.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0` (no new file crosses the size gate; this task shrinks `repository.ts`).

DB-touching test (commitments integration suite) — run only via the `verify-gate` skill's isolated
gate DB, not directly:

```bash
<gate-DB-scoped vitest invocation for tests/integration/commitments.test.ts, per verify-gate skill>
```

Expected: all `CommitmentsRepository` tests green, including the new concurrency test.

Full local gate at wrap-up: `pnpm verify:foundation`, run only via the `verify-gate` skill.

## Kill gate

This is a single-phase, single-file behavioral change (no phase 2 planned). If the concurrency
test cannot be made to fail against old code / pass against new code inside one focused session,
stop and escalate to the coordinator rather than widening scope — do not start touching C2/C3/C4
surface (explicitly out of scope per the issue: "do not absorb sibling cleanup").

## Determinism boundary

Not applicable — no model output, no UI surface, no chat turn involved. Pure DB write path.
