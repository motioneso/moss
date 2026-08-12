# Build plan — #1555 capability-route timeout

## Scope and risk

Issue #1555 reports the integration test `selects an active configured model by capability without
returning secrets` exceeding Vitest's 30-second timeout at the capability-route request. The live
path is `GET /api/ai/capability-route/:capability` → `AiRepository.resolveModelForCapability`.
This is an internal sensitive-tier performance fix. It does not change authentication, credential
decryption, response serialization, or model-provider selection policy.

## Seams check

- `packages/ai/src/capability-route-routes.ts:43-65` enters the public capability-route seam and
  executes resolution inside `DataContextRunner.withDataContext`.
- `packages/db/src/data-context.ts:54-72` establishes the RLS transaction and passes the branded
  scoped database to the resolver; this transaction boundary remains unchanged.
- `packages/ai/src/repository.ts:1045-1168` defines the resolver's ordered routing contract:
  admin model pin, admin provider pin, transcription branch, worker automatic routing, service
  binding/legacy read-through, then instance-default provider selection.
- `packages/ai/src/repository.ts:1526-1534` and `1604-1612` currently read the two admin-pin
  preferences independently, although both are in `app.preferences`.
- `packages/ai/src/repository.ts:664-721` currently reads the service-binding and retired legacy
  capability-route settings as separate `app.instance_settings` queries.
- `packages/ai/src/repository.ts:816-840` resolves the instance-default provider and
  `1262-1308` selects the active capable model; both remain the authoritative fallback stages.
- `tests/integration/ai.test.ts:441-526` exercises the reported public request and asserts active
  model selection plus absence of credentials/secrets from the response.

No assumed platform capability is left uncited. No UI/UAT surface is involved.

## Decision

Reduce avoidable database round trips within `resolveModelForCapability` without introducing a
new cache or a timer race:

1. Add a private repository read that fetches both admin-pin preference keys in one query and use it
   from the resolver. Its contract is
   `readAdminPinnedIds(scopedDb: DataContextDb): Promise<{ modelId: string | null; providerId: string | null }>`.
   Keep the existing single-key methods for callers that need one preference.
2. Make `getServiceBinding` fetch the current service-binding and legacy capability-route settings
   in one query, then preserve the current precedence and stale-legacy validation behavior.
3. Leave `withDataContext`, RLS predicates, pin hard-lock semantics, fallback reasons, and safe model
   serialization unchanged.

This removes two sequential settings round trips from the reported chat route while retaining the
existing fallback behavior. Adding a request-level `Promise.race` or returning a fabricated
`needs-config` result on timeout is explicitly out of scope because it would leave database work
running and could hide a configured model.

## Implementation and test slice

One vertical slice, committed green:

- Update `packages/ai/src/repository.ts` with the two coalesced reads and resolver wiring.
- Run the existing public integration test in `tests/integration/ai.test.ts` as the regression
  seam. It must resolve the active model and continue to omit `capability-secret`,
  `disabled-secret`, and ciphertext. A regression that restores the excessive query path remains
  observable as the same 30-second timeout under CI load.
- Add no speculative benchmark threshold; CI timing is environment-dependent and Vitest already
  supplies the failing timeout contract.

## Kill gate

After the first green targeted integration run, stop and report to the coordinator if the request
still approaches the 30-second timeout or if query coalescing changes any pin/binding fallback
result. The coordinator decides whether to pursue deeper database contention analysis; this lane
does not add a broader cache or schema change.

## Verification

Expected exit code is 0 for each command:

```bash
export JARVIS_PGDATABASE=jarvis_gate_1555
pnpm exec vitest run tests/integration/ai.test.ts
pnpm format:check
pnpm lint
pnpm typecheck
```

The integration command must run against a freshly created isolated gate database using the
`verify-gate` procedure. Before push, also run `git fetch origin main && git rebase origin/main`.
