# Finance pending-settlement metadata handoff

Continuation of the authorized ledger/parity work under #1144/#1146/#1148. No live bank,
credential creation, production mutation, deployment, publication or merge. Synthetic feeds only.

## Observed problem and evidence

Read-only synthetic reproduction on 6b7a3573: an incoming 1200-cent posted row naming a
1000-cent predecessor consumes that predecessor even when it is already posted. With an actual
pending user-reviewed predecessor, changed money retains confirmed status. Another defect is
in the real handler: a removal-only page can delete pending categorization/notes before the
posted addition arrives on a later page. A pure single-page replacement test cannot prove this.

[Plaid transaction states](https://plaid.com/docs/transactions/transactions-data/) and
[the Transactions API](https://plaid.com/docs/api/products/transactions/), checked 2026-10-30,
describe separate pending/posted identities, optional explicit predecessor linkage, changes in
settlement amount/name and removal/addition on different pages of the same update. This work
must preserve user metadata through that protocol, not automatically match by payee or amount.

## Bounded design

A posted row may consume only an actually pending provider source in the same owned account.
Never consume a posted or manual predecessor. An already-existing posted user review takes
precedence over an older pending twin during replay. User category, notes and splits carry
forward, but changed amount/currency requires needs_look; unbalanced splits retain existing
repair behavior. Same-page and month-boundary replay remain idempotent.

For SQL storage, introduce a private provider-handoff table and internal store API. Capture an
owned pending source atomically into the handoff table and remove it from the live register,
under ordered source row locks. Capture candidates are explicit provider removals or same-account
posted predecessor references; an account must belong to this item and both account/row must
be provider-backed. This closes the pending-user-edit versus deletion gap: the canonical latest
metadata is captured or the stale editor loses its row review, rather than silently disappearing.

A handoff stores only the whitelisted transaction-row snapshot needed for categorization/notes/
split repair, plus item/account/transaction identities and capture time. It contains financial
content and is owner-private, never a job payload, mirror, log, credential slot or public response.
Add migration 0039 and a twenty-first owned table, with owner/item/account foreign keys, composite
identity and snapshot shape checks. It deliberately survives deletion of the source pending row;
there is no transaction foreign key that would erase the handoff on capture. Do not modify any
applied migration or relax the module storage, confirmation or privacy contracts.

After capture, load relevant snapshots for incoming IDs, explicit predecessor IDs and removals.
Hydrate a private reducer workspace only when the snapshot belongs to the same incoming account
or an explicit removal, and only when a current canonical row does not already occupy its ID.
Load that snapshot's exact month as needed; an explicit provider ID can justify an older source
without amount-based guessing. The reducer consumes every virtual source before persistence;
never resurrect archived rows into the live ledger or household mirror. Preserve current posted
user choices and flag changed money before categorization can settle it automatically.

Write canonical chunks before mirrors and activity; mirrors reread saved canonical chunks so
virtual sources or stale categorized copies cannot leak into shared read state. Keep handoffs
through all partial pages and the existing 100-page continuation checkpoint. A failed chunk,
mirror, activity or cursor write must leave the source snapshot recoverable. Clear this item's
handoffs only after all pages of a completed update have durable canonical/mirror/activity writes,
then advance its final cursor. An incomplete update retains both paginationStart and handoffs.
No automatic financial-write retries are added; existing provider at-least-once sync remains.

Legacy KV storage keeps its established paging flow; pure source/review guards apply, but durable
handoff acceptance requires SQL migration. Do not claim legacy or universally atomic provider
parity. Account-balance snapshots, every page's entries and mirrors are still separate operations;
full update atomicity, arbitrary provider corrections and broader concurrency remain distinct.

## Acceptance and proof

First observe pure failures for posted/manual/cross-account impostors, changed money/currency,
existing posted user precedence and replay. Prove snapshot capture/removal, same-account matching,
no virtual resurrection, unchanged user notes/splits, removed-before-added across pages, month
boundaries, ordinary unmatched pending removal and SQL migration compatibility.

Use a fake provider feed with real installed SQL. Each query/KV call must use its own committed
data context, matching actual worker RPCs; do not wrap an entire sync in one transaction and
mistake that for production atomicity. Hold a pending user edit against capture to prove the
latest committed fields survive or stale editing is refused. Inject chunk/mirror/cursor failure,
resume from the actual durable checkpoint and verify one posted identity with user fields intact.
Prove the 100-page continuation and pagination restart boundary without increasing the cap.

New table privacy needs owned/foreign/admin checks and an observed fixture-only RLS negative
control, restored in finally. No private financial payload in activity or job assertions. Run
Finance units, real SQL and complete backend/native regressions, plus repository checks.

Exercise real native Needs a look after a synthetic settlement through actual installed reads
and host-confirmed category review; cancellation preserves the saved row. Label the provider
feed/credential ports as mocks; no actual bank acceptance or credentials were exercised. Inspect
phone/desktop light/dark/Sage and retain screenshots. Keep the central browser file below 1000
lines by extending its existing focused helper. Update the existing app-map declarations within
their limits and keep provider/duplicate parity Partial until broader evidence supports it.
