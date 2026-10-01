# Admin-created AI providers stay visible after demotion (#2844)

Spec-lite. Follow-up to #2842. Ruled by Ben 2026-09-30: an admin sees everything another admin can
see on AI providers, even when the owner was demoted. A regular user's personal provider stays
hidden from admins.

## Problem

Migration 0091 lets a user read a provider or model when the owner is an active admin _now_. After
the owner is demoted the test fails, so no other admin can see or manage rows that were set up as
shared admin providers.

## Design

Migration `packages/ai/sql/0250_ai_admin_created_visibility.sql`:

| Part     | Behavior                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Column   | `created_by_admin boolean NOT NULL DEFAULT false` on `ai_provider_configs` and `ai_configured_models`                                             |
| Set      | BEFORE INSERT trigger sets it from `app.current_actor_is_admin()`; clients cannot choose it                                                       |
| Lock     | BEFORE UPDATE trigger raises if the value changes                                                                                                 |
| Backfill | Marks only rows whose owner is an active admin at migration time. RLS is off for the backfill only, restored in the same transaction (0173 idiom) |
| Read     | New permissive SELECT policy on both tables: `created_by_admin AND app.current_actor_is_admin()`. ORs with the 0091 rule                          |

## Out of scope and invariants

- Row owners never change. 0013's triggers forbid it, and it would misattribute keys.
- 0013 and 0091 are not edited.
- No admin gains access to a regular user's rows. Their rows are never marked.
- Write rules are unchanged (already any-admin from 0091).
- No screen or setting changes, so no app-map edit.

## Proof

`tests/integration/ai-admin-provider-visibility.test.ts`, observed failing before the migration:

- Admin B sees admin A's provider and model after A is demoted (both tables).
- A regular user's provider and models stay hidden from admins and other users.
- A non-admin cannot see a demoted admin's rows.
- New admin inserts are marked, and the mark cannot be changed on either table.
