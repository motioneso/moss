# Plan — [906-A] Story feedback persistence, target verification, and lifecycle API (#2016)

Spec: `docs/specs/2016.md` (also posted as the `SPEC` comment on issue #2016).
Branch: `fleet/lane-2016`. Risk tier: security.

## Seams (checked on this branch before planning)

| What                     | Where                                                                     | State today                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feedback tables          | `packages/usefulness-feedback/sql/0120_usefulness_feedback_signals.sql:1` | Four target kinds, four surfaces, six actions, two statuses. Forced row-level security, owner-only, no admin bypass.                                      |
| Shared contracts         | `packages/shared/src/usefulness-feedback-api.ts:3`                        | Same four vocabularies, no reason field, no edit route.                                                                                                   |
| Row types                | `packages/db/src/types.ts:620`                                            | Four union types mirroring the SQL.                                                                                                                       |
| Repository               | `packages/usefulness-feedback/src/repository.ts:44`                       | `findActive` is per-direction; no supersede, no reason edit, no filtered list.                                                                            |
| Routes                   | `packages/usefulness-feedback/src/routes.ts:245`                          | Body parser insists on exactly four keys in a fixed order.                                                                                                |
| Allowed pairs            | `packages/usefulness-feedback/src/target-verifiers.ts:40`                 | No story kinds.                                                                                                                                           |
| Verifier registration    | `packages/module-registry/src/index.ts:1716`                              | Four verifiers registered.                                                                                                                                |
| Metadata cleaner         | `packages/usefulness-feedback/src/metadata.ts:3`                          | Drops keys that look like `body`, `excerpt`, `externalId`, `prompt`, `raw`, `secret`, `sourceId(s)`, `summary`, `token`. `reason` is not on the list yet. |
| Export                   | `packages/settings/src/data-export-queries.ts:635`                        | Both tables exported, without the new columns.                                                                                                            |
| Deletion count sweep     | `scripts/delete-user-data.ts:57`                                          | Neither feedback table is counted.                                                                                                                        |
| Migration list assertion | `tests/integration/foundation-schema-catalog.test.ts:355`                 | Ends at `0199`.                                                                                                                                           |

Highest migration number on the branch is `0199`, so this slice takes `0200`.

## Phases

Each phase commits green.

1. **Storage.** New migration `0200_story_relevance_feedback.sql`: widen the four vocabularies on
   the signals table and the two on the targets table, add `reason_text`, `rule_json`,
   `rule_version`, `revision`, `updated_at`, add the "a reason is required for Less like this and
   forbidden otherwise" check, add a partial unique index giving one active story preference per
   story across both directions. Mirror all of it in `packages/db/src/types.ts`. Add the file to the
   migration list assertion.
2. **Contracts.** Widen the four unions and their schemas in
   `packages/shared/src/usefulness-feedback-api.ts`, add an optional reason to the create request,
   add `reason`, `revision`, `ruleVersion`, `updatedAt` to the returned object, add the edit request
   and route schemas, add the list query schema. No Node-only imports in this package.
3. **Story identity.** New `packages/usefulness-feedback/src/story-target.ts`: a hashing helper that
   turns a module id plus a story's canonical link into an opaque reference, and a bounded context
   builder. Add `reason` to the blocked-key list in `metadata.ts`. Unit test alongside.
4. **Verification.** New story verifier in the feedback module that looks the target up through
   `findTarget`; widen `isAllowedFeedbackPair`; register both story kinds in the module registry.
5. **Repository.** Reason and revision on create; a cross-direction active lookup; supersede;
   update reason; module and status filters on list.
6. **API.** Rewrite the create body parser to take an optional reason and still reject unknown keys;
   reason validation; supersession; `PATCH /api/me/usefulness-feedback/:id`; module and status
   filters on the list route; an unwired "story preference changed" callback for 906-C and 906-D.
   Declare the new route in the manifest.
7. **Export and deletion.** New columns in both export queries; both tables added to the deletion
   count sweep.
8. **Tests.** The twelve integration cases from the spec, plus the story identity unit test, plus
   the updated route-list and migration-list assertions.

## Verification

- `npx tsc --noEmit`
- `npx eslint <changed files> --max-warnings=0`
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
- Database migration and the integration suite, run only through the `verify-gate` skill.

## Out of scope

Rule compiling and evaluation (906-B), News and Sports candidate selection (906-C, 906-D), every
front-end surface, and any queue job. This slice adds no user-visible behaviour, so the release note
category is N/A.
