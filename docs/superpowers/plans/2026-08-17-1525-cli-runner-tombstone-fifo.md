# Plan — 1525: bound cancel-only submit tombstones (FIFO ceiling 128)

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-C
**Issue:** Part of #1525
**Tier:** routine

## Seams check (file:line, current tree)

- `submitAttempts` ledger: `packages/cli-runner/src/engine-host.ts:194` —
  `Map<sessionKey, Map<attemptId, SubmitAttempt>>`.
- `SubmitAttempt` shape: `packages/cli-runner/src/engine-host.ts:163-167` —
  `{ digest: string | null; controller: AbortController; promise?: Promise<void> }`.
- `cancelSubmit` creates a synthetic tombstone (`digest: null`) only on first-time creation of an
  attempt entry: `packages/cli-runner/src/engine-host.ts:537-550`.
- `submit()` upgrades an existing `digest === null` tombstone to a real digest (delayed-submit
  rejection path) at `packages/cli-runner/src/engine-host.ts:488-497` — this entry must never be
  evicted once upgraded.
- Ledger is cleared wholesale (never per-entry) at three sites: launch success
  `engine-host.ts:432`, kill-with-engine `engine-host.ts:591`, kill-without-engine
  `engine-host.ts:601`. Any new per-session tracking structure must be cleared at all three.
- `attemptId` is not format-validated inside `engine-host.ts` — UUID validation happens one layer
  up in `packages/cli-runner/src/connection.ts:297-309`. Tests calling `host.cancelSubmit`
  directly may use plain string ids.
- Test file owned surface: `tests/unit/cli-runner-server.test.ts`, existing tombstone coverage at
  lines 392-415 (active-submit cancel) and 417-432 (cancel-before-submit retains tombstone) —
  both must stay green unmodified.

## Decision

Add a dedicated per-session-key FIFO of attemptIds that were inserted as synthetic tombstones,
separate from the ledger itself so eviction never scans real submitted attempts:

```ts
/** #1525: FIFO of attemptIds created as cancel-before-submit tombstones (digest === null at
 *  creation) per session key. Bounds only synthetic tombstones — never touches real submitted
 *  attempts or active-attempt abortion. */
private readonly tombstoneOrder = new Map<string, string[]>();
private static readonly MAX_SYNTHETIC_TOMBSTONES = 128;
```

`cancelSubmit` pushes the new attemptId onto that session's FIFO only in the branch that creates a
fresh tombstone (the existing `if (!attempt) { ... }` branch at `engine-host.ts:545-548`), then
trims: while the FIFO exceeds 128 entries, shift the oldest attemptId and delete it from the
ledger **only if** its current `digest === null` (guards against an entry that was upgraded to a
real digest by a concurrent `submit()` between tombstone creation and eviction — that entry is no
longer a synthetic tombstone and must survive).

All three ledger-clearing sites (`engine-host.ts:432`, `591`, `601`) additionally
`this.tombstoneOrder.delete(key)`.

No timeouts, no timestamps, no LRU class, no second export, no config surface — matches the
spec's explicit bans.

## Test cases (behaviour + why they'd fail against a broken implementation)

Add to `describe("verified submit attempt ledger", ...)` in `tests/unit/cli-runner-server.test.ts`:

1. **`bounds synthetic tombstones to a 128 FIFO and never evicts a real submitted attempt`**
   - Launch a session. Issue `cancelSubmit` for 129 distinct attemptIds (`tombstone-0` ..
     `tombstone-128`) sequentially.
   - Assert the oldest (`tombstone-0`) now submits cleanly: `host.submit(key, { attemptId:
"tombstone-0", text: "..." })` must NOT reject with `VerifiedSubmitError("unavailable")` —
     it must reach `verifiedSubmit` (spy called). A broken (unbounded) implementation still
     blocks this submit with "unavailable".
   - Assert the newest (`tombstone-128`) still blocks its delayed submit with `unavailable` — a
     broken (over-aggressive eviction) implementation would wrongly let this through too.
   - Interleave one real submitted attempt (`submit()` before any cancels, distinct attemptId)
     and assert its ledger entry / behavior (duplicate-submit still joins the cached promise)
     survives the 129 cancellations — proves eviction never touches `digest !== null` entries.
   - Assert `verifiedSubmit` was called exactly once for the real attempt and once for the
     recovered `tombstone-0` (bounds the "never alters active-attempt abortion" contract by
     absence of extra calls).

2. Existing tests at lines 392-415 and 417-432 run unmodified and stay green (regression guard for
   cancel-before-submit ordering and active-submit cancellation).

## Verification

```bash
pnpm vitest run tests/unit/cli-runner-server.test.ts > /tmp/1525-vitest.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`, all tests in the file pass including the new case.

```bash
pnpm format:check && pnpm lint && pnpm typecheck
```

Expected: all exit 0 (pre-push trio, run before pushing).

Full repository gate at wrap-up per `verify-gate` skill on an isolated gate DB (this change has no
DB surface, so the gate is a regression check, not a functional dependency).

## Kill gate

Single phase — this is a single bounded-queue change to one function plus its clearing sites. If
the new FIFO test cannot be made to pass without altering the two existing tombstone tests'
observed behavior (active-submit cancel, cancel-before-submit retention), stop and escalate to the
coordinator rather than loosening those two tests. Owner: this lane.

## Exit criteria

- Spec §1140-C's Focused acceptance bullets all hold (see spec lines 181-187).
- `tests/unit/cli-runner-server.test.ts` green, including the new bound test.
- No live-path proof required (backend-only, no UI surface) — stated explicitly in the wrap-up
  report per the handoff doc.
