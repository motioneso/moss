# Plan: admins see admin-owned AI providers (#2842)

Tier: security. Ruling (Ben, 2026-09-30): an admin sees everything another admin can see on AI
providers, whoever owns the row, even if the owner was demoted. A regular user's personal provider
stays hidden from admins. Supersedes "owner must be an active admin" in the issue.

## Seams checked (on this branch)

- `packages/ai/src/serialize-model.ts:22-31` hides provider ids and model id unless `owner_user_id === actor`.
- `packages/ai/sql/0091_chat_model_override.sql:15-27,43-57` RLS SELECT on provider configs and
  models: own row OR `app.owner_is_active_admin(owner_user_id)`. Visible to every user, not only admins.
- Callers pass the actor id: `routes.ts:514,552`, `provider-validation-routes.ts:183`,
  `provider-visibility-routes.ts:111`, `capability-route-routes.ts:61`.
- `admin-ai-pin-routes.ts:168` passes the TARGET user id on purpose. Untouched.

## Fork needing a decision

Two layers hide the list today. (1) The serializer hides ids from non-owners. (2) The database
hides rows whose owner is no longer an active admin, from everyone including admins.
Fixing only (1) covers admin-owned rows of current admins. A demoted owner's rows stay invisible,
which Ben's ruling says must be visible to admins.

Proposed: a new migration (next free number, assigned by coordinator) adding a third arm to both
SELECT policies: `app.current_actor_is_admin()` AND the row's provider is admin-owned-or-was.
"Was admin" has no stored flag today, so the least-new-state option is: on demotion, rows keep
their owner; the new arm shows a row to an admin when the owner is NOT the actor and the row
`origin`/provider is not a personal key. That needs a definition of "personal". Options:

- A. Reassign a demoted admin's providers and models to the demoting admin in the demotion path
  (no policy change; row becomes own-row for one admin, still admin-owned by an active admin).
  Weakness: it does not help when a second admin is not the demoter, and the rule fails for old
  already-demoted rows (needs a backfill).
- B. New policy arm using a recorded "created by an admin" fact. Needs a new column, backfilled by
  a migration that cannot read rows (FORCE RLS), so backfill is by owner-was-admin at write time only.
- C. Serializer-only change now (covers current-admin owners, the live proof case), and demoted
  owners handled as follow-up.

Recommendation: A for new demotions plus C now. Coordinator or Ben to pick; B adds state.

## Changes (assuming A + C)

1. `serialize-model.ts`: take a viewer object `{ actorUserId, isAdmin }`. Owner view when
   actor owns the row, OR viewer is admin (RLS already limits what an admin can read to own rows
   and active-admin-owned rows). Update all five call sites; the pin screen keeps target-user view.
2. Demotion path: reassign the demoted admin's provider and model rows (owner_user_id) to the
   acting admin in the same transaction. File located during build.
3. No secret fields added to any DTO (credential fields are never selected by the safe row).

## Tests (observe each failing with the protection removed)

- Second admin lists models of an admin-owned provider: ids and model list visible.
- Same after the owner is demoted (with A: rows follow the demoter).
- Admin does NOT see a regular user's personal provider (no row returned, no ids).
- Refresh on an invisible provider saves 0 rows and returns no error.
- Admin refused (403/404) refreshing a non-admin's provider.
- A regular user still gets the instance-default lens (ids hidden) on admin-owned models.
- Failing-first proof: revert serializer to owner-only, confirm the first test fails; add a
  permissive check, confirm the personal-provider test fails.

## Live proof

Isolated instance (not :1533), two admins, second admin opens Refresh models and sees the list;
a regular user's personal provider absent for admins. Posted as PR comment.

## App map and release note

Provider card behavior changes: update the AI settings entry in `packages/shared/src/app-map-core.ts`
or the owning manifest if it describes who sees models. Release note: Category Fixed.
