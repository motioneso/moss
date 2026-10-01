# Admin model refresh on another admin's provider (#2820)

## Problem

`createModel` and `upsertDiscoveredModels` in `packages/ai/src/repository.ts` stamp new model rows
with `app.current_actor_user_id()`. The table has a composite foreign key
`(provider_config_id, owner_user_id)` to the provider, so a second admin writing to a provider
owned by the first admin violates it. The route turns the error into a 400.

## Decision

Models take their owner from the provider row, not the signed-in actor. The insert policy already
allows any admin, so no migration or policy change is needed. The provider lookup runs under the
actor's row visibility (admins see every active-admin-owned provider), so a provider the actor
cannot see still yields no row and the existing not-found handling applies.

## Changes

1. `createModel`: read `owner_user_id` in the existing provider lookup and use it for the insert.
2. `upsertDiscoveredModels`: look the provider's owner up once, use it for every insert. A missing
   provider returns 0 inserted rows.

## Tests (`tests/integration/ai-provider-model-refresh.test.ts`)

- Second admin refreshes models on the first admin's provider: 200, new rows owned by the provider owner.
- Second admin adds a hand-typed model: row owned by the provider owner.
- Both fail before the fix with the foreign-key error.

## Verification

Narrow integration run through `scripts/run-gate.sh`, then the pre-push trio.
