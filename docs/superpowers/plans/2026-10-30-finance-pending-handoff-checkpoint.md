# Finance pending settlement checkpoint

Authorized continuation of #1144/#1146/#1148. Design:
[pending handoffs](../specs/2026-10-30-finance-pending-handoffs.md).
Commit/push to the isolated task branch is authorized. No PR publication, merge, deployment,
production data, live bank request or credential creation is authorized or performed.

## Implemented boundary

SQL sync captures and removes the locked canonical pending source in one statement. A private
handoff preserves the whitelisted transaction snapshot, exact decimal-text cents, user category,
notes and splits. Capture accepts explicit removals or same-account posted references, requires
provider-backed account/entry and matching owned item, and never consumes a posted/manual impostor.
Snapshot insertion failure rolls back source removal. Ordered row locks preserve the latest
committed pending metadata; stale editing after capture loses its row review instead of overwriting.

Migration 0039 adds the twenty-first owned table with owner/item/account foreign keys and snapshot
shape checks; there are 39 migrations. No applied migration was edited. Handoffs deliberately
survive source removal, remain private and are cleared only after a completed update's chunk,
mirror and activity writes, before final cursor advancement. Partial 100-page updates retain them.
Relevant archived sources hydrate an internal exact-ID workspace, including older source months;
current canonical rows win and virtual sources are consumed before persistence. New posted user
choices outrank older pending fields. Changed amount/currency reopens review and invalidated splits
stay available for repair. Household mirrors reread saved canonical chunks and exclude notes.
Legacy KV keeps its established paging flow; durable handoff acceptance requires SQL migration.

Native categories set by a user say Review needed when attention is required; guesses retain
Predicted. Existing Park Press components, tokens, review/host confirmation and cancellation apply.
No new bank action, credential permission, financial-write retry or platform authorization bypass.

## Verification receipts before final clean runs

Synthetic data and disposable gate databases; Node 24.19.0 / pnpm 10.6.2:

- Pure red: 6 failed / 1 passed on old predecessor/review behavior. Restored focused old/new
  reducer, sync and manifest suites: all 73 passed. Internal workspace cases cover exact older
  sources, no resurrection, current-row precedence, replay and impostor refusal.
- Finance units passed all 784 in 82 files on the completed handoff/review-label code. Full
  typecheck, lint, formatting, file-size and UI-class checks passed on that snapshot.
- Initial SQL fixture errors expected item errors instead of thrown injected interruptions,
  misnamed the admin actor, and used a provider account ID containing a forbidden mirror-key
  separator. Corrected fixtures preserve the existing contracts. Source/current user choices,
  row-lock waits and durable source capture were actually exercised.
- SQL 132042-Mpa6D4 / 0308909721cc passed all 28 cases. Includes pending user metadata,
  exact older source month, split repair for USD/EUR settlement, real lock wait, stale editor
  refusal, snapshot rollback, impostor/item boundaries, unmatched authorizations, independently
  committed chunk/mirror/cursor interruptions, 100-page continuation and pagination restart.
- RLS negative 132305-CuVFXp, same input, failed exactly one / passed 27: only a disposable
  table loses RLS; a foreign owner then reads the synthetic private snapshot. finally restores
  ENABLE/FORCE. Earlier negative run also caught two split fixture mistakes: normal putTransaction
  correctly would not overwrite existing splits. The final fixtures insert and assert new legacy
  pending-split sources. No production guard was removed.
- Native first failed because the synthetic KV port omitted host-bound Finance identity for
  worker-role RLS. It now sets the same local module context as the real host; no policy changed.
- Native 132903-arRW0b / e4b2edffed05 passed its selected installed flow (20 unrelated skipped).
  Actual committed SQL sync uses a mocked provider/credential port, followed by real installed
  reads and host-confirmed category review. Cancel preserves the settled row; confirm advances
  its revision while preserving every financial field and note. No credentials are written.
- Positive SQL 132745-Bk3z7D / c8ebb9b2069c passed all 28 after the KV fixture correction.
- Complete backend 133130-Q9dOzl / 94147451b07c passed all 168 in 16 suites; browser opt-in
  file skipped separately. Full installed browser 133128-NlBZYl passed 20 / failed 1: handoff,
  goals and all other flows passed, but report details hit a real HTTP 429 with Retry-After 8.
  The dialog hid that wait and the fixture waited for a total without another explicit reload.
  This failure is not labeled a baseline failure or a passed whole-browser gate.

## Report recovery fix and final checks

The observed report error-state defect now uses the existing read-cooldown hook: busy detail
reads show the server wait, retain scope and disable reload/paging during cooldown. No request
is scheduled automatically. The browser fixture captures actual read responses and follows one
explicit Retry-After recovery. A new fake-timer regression was observed failing before the fix;
restored report/manifest units passed all 20. Scoped lint passed. App-map facts remain within the
existing limits. A further SQL test covers final-cursor failure followed by a newer posted user
review. These last changes require the final clean runs; do not reuse the earlier full pass as
proof for them.

Inspected pending review dark 320px/light 1440px screenshots and the report failure screenshot.
Bounds exercise light/dark/Sage at 320/390/768/1440. Final screenshot names:
finance-pending-settlement-{theme}-{width}.png. The final full run checks Review needed in the
actual register before opening the dialog. The provider/credential ports and mirror transport
are explicitly synthetic fixtures; native reads/host review and SQL persistence are actual.
This is not actual bank/installed-provider-HTTP acceptance, which remains unrun.

The new snapshot is not added to activities, job payloads or mirrors. SQL RPC drops data-bearing
PostgreSQL detail/hint/where; the runtime logs module/method/primary error message without params.
The synthetic mirror assertions exclude private notes. This describes the followed new data path,
not a blanket audit of every historical SQL primary message.

Commit/push this coherent checkpoint, then run the reproducible finance-complete gate (fresh web
build plus all backend and installed flows), fixture-only privacy negative and restored positive
SQL, all Finance units and the isolated aggregate on the clean implementation commit. Record exact
receipts and distinguish any 277 known baseline identities from added failures. The previous clean
refill aggregate failed with exactly those 277 identities and no additions; it is not this commit's
aggregate result. Broader card reserves, account-linked/debt goals, household writes, unlinked
provider matching, whole-update atomicity, richer reports and holdings remain staged in the
[parity matrix](../specs/2026-10-28-finance-parity.md).

## Clean implementation verdict and upstream migration numbering

Clean implementation cf8aa8431d3e48cc8ef64d6694bc3dd07dfb3581, fingerprint
cd5af37482fc: finance-complete receipt 134452-en0hhV passed all 190 tests in 17
files (169 backend and 21 installed browser flows). This includes the final-cursor
interruption case and actual report HTTP 429 recovery with Retry-After 12. All
785 Finance unit tests in 82 files passed separately. These are synthetic-provider
results, not a real bank acceptance run or permission to merge.

The aggregate receipt 134451-fhbeeG failed before type checking or units at
check:migration-numbers. Current fetched main 3a9c744d035bf1d91220ec13a634c51453282bb3
claims global 0342 for chat notices; this branch's earlier unmerged module-page audit
migration independently used 0342. This is a branch integration defect, not one of
the historical 277 unit failures. Current main uses numbers through 0353. Read-only
GitHub file-list inspection of all four currently open PRs (3851, 3571, 3771, 3534)
found no claim on 0354. The unshipped task migration is therefore renamed to 0354,
with identical SQL bytes and the schema-catalog expectation updated. No deployed
migration, production database, or main branch is changed. Fresh disposable gates
must validate the renamed migration and schema catalog before accepting this fix.

Renamed migration clean e07ea6d1 / 92dff8edc299: module-page-writes receipt
135350-LQMB1Z passed all 78 in nine files, including schema catalog and authorization,
confirmation, audit and bearer regressions. Aggregate 135348-2Y1sLc passed the migration
collision check but stopped at the report fake-timer test's callback return type (TS2769).
The callback now explicitly returns void. This is a task regression being corrected,
not a historical baseline failure.

Privacy negative receipt 135757-B8mg7E / 51bc8cd1a1fc (358524bf plus matrix whitespace)
failed exactly the intended foreign/admin snapshot test, with the other 28 passing.
Only the disposable fixture disables the snapshot policy, restored in finally. The
restored positive Finance run must follow; this expected red is not a passing gate.
