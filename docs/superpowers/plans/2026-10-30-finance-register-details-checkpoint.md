# Register details and manual statement filters

Date: 2026-10-30. Branch task/finance-parity-20261028. No merge, deployment or PR publication.
[Parity matrix](../specs/2026-10-28-finance-parity.md),
[filter spec](../specs/2026-10-30-finance-ledger-status-filters.md),
[details spec](../specs/2026-10-30-finance-transaction-details.md).

## Implemented scope

358524bf implements separate manual uncleared, cleared-unreconciled and reconciled filters.
All 793 Finance units in 83 files passed after that slice. e07ea6d1 renumbers the unshipped
audit migration to 0354 without changing SQL bytes; its real schema/catalog and guarded
platform routes passed all 78 in nine files (135350-LQMB1Z / 92dff8edc299).

Clean bf918fb8 / 291ac9885240 full Finance 135851-vyBBvA passed 169 backend and
20 installed flows; its one failed browser check incorrectly assumed desktop-expanded
filters stay visible after moving to phone width. 59ebccb9 fixes the fixture to use the
actual Show filters control. This changes no product visibility, rate limit or timeout.
The completed check remains a failed run until restored acceptance passes.

The next slice opens transaction payees as captured detail dialogs, preserving full
multiline notes as read-only text. Exact amounts/currency, posting/manual status and
split allocations remain distinct. Shared details omit notes and identify owner-managed
review. No extra reads, financial writes, migrations, exports or jobs are added. Existing
category, split and transfer actions retain their separate reviewed workflows.

Details/manifest units passed all 24 (8 details plus 16 manifest). Removing only the
UI shared-note guard made the malformed-household test fail because a textarea appeared
(1 expected failure, 7 skipped). The source was restored in finally and all 24 then passed.
This proves the followed new UI guard, not an audit of every historical sharing path.

## Verification still required

Run fresh complete Finance backend/installed acceptance on the clean implementation,
all Finance units and static checks, fixture-only snapshot privacy negative and restored
positive SQL. Inspect details phone/desktop and the reconciled filter screenshots.

Aggregate 135852-XysU3e on clean bf918fb8 passed every static check including root, test,
web and all external-module types. It reached units but was deliberately stopped with
rc143 to supersede it after the details implementation; its partial unit run is not
a verdict or a reused receipt for changed source. A new clean aggregate must follow.
Historical earlier aggregates had exactly 277 unrelated failures; compare identities,
never assume a new failure belongs to that baseline. Later aggregate DB stages remain
unrun when units fail.

Disk pressure was recovered by removing 15 unattached anonymous volumes whose creation
times matched completed synthetic Finance gate receipts; no global prune or active/dev
database removal was performed. No credential or financial provider was contacted.

## Responsive dialog correction

Clean 33793f05 / ad2f321db785 complete receipt 141047-CRAlnJ passed all 169 backend
and 20 installed flows. The restored manual-status flow passed, including all 24
cleared/reconciled frames; dark 320px/light 1440px reconciled frames were inspected.
The new details flow failed at its first phone transition: Dialog is deliberately
inline in the shared library, so mounting it inside a desktop-only row hid it on
phone width. This is a product regression, not a fixture/baseline failure.

The register now owns the captured detail state and mounts one Dialog above both
responsive layouts. Row buttons only capture/open it. No portal implementation or
shared modal lifecycle is changed. Capture helpers clone the row and splits, and
focused restored details/register suites passed all 100 in 13 files. The shared-note
negative was repeated against the moved renderer (expected red, restored in finally);
new clean installed acceptance and full verification must establish the final result.
