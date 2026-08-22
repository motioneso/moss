# Plan: Custom Sports News Sources (#1572)

**Spec:** `docs/superpowers/specs/2026-08-17-1572-custom-sports-news-sources.md` (Approved)
**Task issue:** #1572
**Risk tier:** standard (owner-scoped RLS data, no admin bypass, no new external write path)

Reconstructed after a working-tree gap left this file unwritten while the coordinator's approval
of its content (schema, task split, migration number) had already landed via `herdr-pane-message`.
Content below matches what was approved and what Task 1 actually built and typechecked.

## Task split (kill-gate)

- **Task 1 (this build):** schema + discovery/preview/confirm REST + settings UI. Ships alone.
- **Task 2/3 (scope-only, not detailed here):** ranking integration (feed custom headlines into
  Today/Sports composition), chat tools, export/deletion lifecycle wiring. Blocked on Task 1's
  live end-to-end proof per `plan-build`'s kill-gate rule — do not detail until Task 1 is proven.
- **Kill-gate owner:** coordinator, evaluated against Task 1's live-path proof before Task 2/3 are
  planned in detail.

## Seams check

- Reused News' safe-fetch/discovery primitives via `packages/sports/src/source/discovery.ts`
  (`resolveSportsSourceInput`), which calls into News' public discovery seam rather than
  duplicating a second fetcher — confirmed by grep of that file's imports.
- Migration numbering is global, not per-module: 0187/0188 were already claimed by the settings
  module, so this feature's migration is 0189 — verified against the whole `sql/` tree across
  packages, not just Sports'.
- Module isolation invariant: all new UI (`AddSourceFlow`, `FollowAssignmentPicker`, `sp-src__*`
  CSS) is Sports-owned, patterned after News' `add-source.tsx`/`news-settings.css` but not
  importing them.

## Schema — `packages/sports/sql/0189_sports_custom_sources.sql`

Four owner-only, FORCE RLS tables, no `jarvis_worker_runtime` grants (no background worker path;
headlines fetch synchronously through the existing dataset-connector TTL cache):

- `app.sports_custom_sources` — one row per owner + canonical domain. Columns: `id`,
  `owner_user_id`, `label`, `canonical_domain` (lowercase, ≤253 chars), `homepage_url` (https,
  ≤2048), `feed_url` (nullable, https, ≤2048), `retrieval_method` (`feed`|`scrape`), `enabled`,
  `health_state` (`pending`|`healthy`|`failing`|`unsupported`|`auth_required`|`disabled`),
  `health_reason_code`, `health_message` (≤500), `last_checked_at`, `last_success_at`,
  `validation_fingerprint`, `validated_at`, `created_at`, `updated_at`. Unique
  `(owner_user_id, canonical_domain)`.
- `app.sports_source_assignments` — links a source to a followed team/league
  (`app.sports_follows` row). Unique `(source_id, follow_id)`. Cascades on both source and follow
  deletion, so removing a follow drops its assignments without deleting the source.
- `app.sports_policy_verdicts` — cached allow/reject verdict per owner + domain, mirrors
  `app.news_policy_verdicts`.
- `app.sports_headline_prefs` — per-owner toggle for built-in ESPN headlines
  (`espn_headlines_enabled`, default true).

Full DDL is committed at that path — see the file for exact CHECK constraints and the RLS DO
block (owner-scoped SELECT/INSERT/UPDATE/DELETE policies, identical posture across all four
tables, `jarvis_app_runtime` grants only).

## REST — `packages/sports/src/routes.ts`, `packages/sports/src/source/repository.ts`

`SportsSourcesRepository` (source/repository.ts):
- `list(scopedDb: DataContextDb): Promise<SportsCustomSourceDto[]>`
- `create(scopedDb, input: { candidate }): Promise<SportsCustomSourceDto | { limitExceeded: true }>`
  — returns `{ limitExceeded: true }` and the route throws 400 when the owner is already at the
  10-source limit.
- `remove(scopedDb, id: string): Promise<boolean>`
- `setAssignments(scopedDb, sourceId: string, followIds: readonly string[]): Promise<...>` —
  re-selects the submitted follow IDs against `app.sports_follows` under the caller's RLS scope
  and inserts only the ones that come back, so a follow ID belonging to another owner is silently
  dropped rather than assigned. (Postgres FK checks bypass RLS, so the FK reference alone cannot
  be relied on to reject a cross-owner ID — confirmed by a failing integration test before this
  explicit re-select was added.)
- `readPolicyVerdict` / `upsertPolicyVerdict` — cached domain verdict reuse across preview
  attempts.

Routes, all under `/api/sports/sources*`, owner-scoped via `AccessContext`:
- `GET /api/sports/sources` → `{ sources: SportsCustomSourceDto[] }`
- `POST /api/sports/sources/preview` → resolves the submitted URL via
  `resolveSportsSourceInput`, returns `PreviewSportsSourceResponse` (`status: "ok"|"rejected"|
  "unavailable"`, `candidate`, `confirmationId`, `duplicateOfSourceId`, `reason`).
- `POST /api/sports/sources` → confirms a previewed candidate by `confirmationId`, optional
  `followIds`; 400 at the 10-source limit.
- `PATCH /api/sports/sources/:id/assignments` → replaces a source's follow assignments.
- `DELETE /api/sports/sources/:id` → removes a source and its assignments (cascade).

Types: `packages/shared/src/sports-api.ts` — `SportsCustomSourceDto`,
`SportsCustomSourcesResponse`, `PreviewSportsSourceRequest/Response`,
`ConfirmSportsSourceRequest/Response`, `UpdateSportsSourceAssignmentsRequest`.

## Settings UI

- `packages/sports/src/settings/sources.tsx` — `SportsSourcesSection` (list + health badges +
  edit-teams/remove actions) and `AddSourceFlow` (URL input → preview → optional follow
  assignment → confirm), plus a shared `FollowAssignmentPicker`. Wired into
  `packages/sports/src/settings/index.tsx` below the existing follows-management block.
- `packages/sports/src/settings/sports-sources.css` — `sp-src__*` class family, tokens only,
  patterned after `packages/news/src/settings/news-settings.css`.
- `packages/sports/src/web/sports-client.ts` — `listSportsSources`, `previewSportsSource`,
  `confirmSportsSource`, `updateSportsSourceAssignments`, `deleteSportsSource`, all via the
  existing `requestJson` wrapper.
- `packages/sports/src/web/query-keys.ts` — `sportsQueryKeys.sources`, invalidated by every
  mutation above.

## Task 1 test cases

- `resolveSportsSourceInput` rejects a non-HTTPS URL, an unreachable/blocked/robots-denied
  target, and a post-redirect domain mismatch — each with the matching rejection reason code
  (`policy`|`invalid_input`|`unreachable`|`not_https`). A broken implementation that skips
  redirect revalidation would pass a spoofed domain through as `status: "ok"`.
- `SportsSourcesRepository.create` enforces the 10-source-per-owner limit — the 11th create call
  must return `null`/throw rather than silently exceeding it, since the route's 400 depends on
  this signal.
- Owner-scoped RLS: an actor cannot `list`, `remove`, or `setAssignments` against another owner's
  `sports_custom_sources`/`sports_source_assignments` rows — a broken policy would leak rows
  across owners in `list` or allow a cross-owner delete to succeed.
- `setAssignments` silently drops a `followId` that RLS makes invisible to the caller (belongs to
  another owner) rather than assigning it — proves cross-owner assignment injection is impossible
  even with a forged ID, not just discouraged by client validation.

## Verification

```bash
pnpm --filter @moss/sports typecheck > /tmp/sports-tc.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm --filter @moss/sports lint > /tmp/sports-lint.log 2>&1; echo "EXIT=$?"      # expect 0
pnpm exec prettier --check packages/sports packages/shared > /tmp/pf.log 2>&1; echo "EXIT=$?"  # expect 0
pnpm --filter @moss/sports test:unit > /tmp/sports-test.log 2>&1; echo "EXIT=$?" # expect 0
```

## Live-path / UAT (Task 1 exit criterion)

- Add `tests/uat/specs/1572-sports-custom-sources.uat.spec.ts` and a row in
  `.claude/skills/coordinate/uat-trigger-map.tsv`.
- Live proof on the PR: add a public URL, preview and confirm it, assign it to a followed
  team/league, edit assignments, remove a source — exercised through the real Settings UI on a
  live dev instance, not just the gate.
