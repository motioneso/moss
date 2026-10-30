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

Selected 785c6eb5 / 3e65cd0a7733 installed receipt 142047-6ukqSP proved owned
details, full notes, all 12 responsive/theme frames and focus return after the dialog
move. It then failed because the new private metadata owner has no shared report row.
The shared-details assertion now runs inside the existing owner report fixture that
actually creates that shared mirror. The selected metadata flow remains independently
owned; the complete suite must prove the shared path. No fallback skips that assertion.
Phone/desktop screenshots also exposed clipped account text in the compact three-column
index; details now use the existing two-column facts variant and wrapped values.

The wider unit run also caught an added module-web-browser-safety failure, not in
the 277 historical failures. Its source graph traversed the shared store interface
into the pending-handoff worker implementation and node:crypto key helpers. The
ProviderHandoffStore vocabulary is now a dependency-free type file; the runtime
workspace helpers stay worker-only. No import guard is changed or bypassed. This
is a structural browser-dependency fix; the earlier successful browser bundle is
not evidence that raw crypto or credentials had actually shipped to the browser.

## Current clean implementation evidence — 682a8162

Current pushed implementation 682a8162999f24d92610fa80fc6702766f5a47f4, fingerprint
ef9dfd37eadce516be8a9d0ac6ce43239818d16b149c113d22b2152ebc79c7ee, Node 24.19.0 / pnpm 10.6.2.
All 801 Finance unit tests plus three unchanged browser-source-graph tests passed
(804 in 85 files). Focused handoff/details/reports/manifest/graph suites passed 43.

Selected installed metadata 142715-Ms9Br9 passed its whole selected flow, with the
other twenty skipped. Details now remain open across responsive layouts, full account
names wrap without clipping, all twelve theme/width frames fit and focus returns.
The [two original screenshots](../evidence/finance-parity-2026-10-30/README.md) were
inspected at light 1440px/dark 320px. The subsequent full 142921-Z9rN0U passed all
169 backend and twenty browser flows, including actual shared details. Its only
failure was the first cleared-filter read returning 400 with the fixed validation
error Pattern matching failed and was rejected. This is not a failed ledger write.
The isolated pattern worker has a 100ms/resource budget; rejection during competing
heavy tests is consistent with resource pressure, but its generic error does not
prove which underlying worker failure occurred. No guard/timeout is relaxed.
Retain this failed receipt and repeat whole Finance acceptance without a competing
broad unit workload. Do not call 142921-Z9rN0U a passing whole run.

Clean snapshot-policy negative 143802-Lq4en4 failed exactly the intended foreign/admin
content test, with the other 28 passing. Only the disposable fixture removes that
policy and restores it in finally. Restored positive SQL 144017-p5z2a7 passed all 29
on the same clean implementation/fingerprint. No live data or credentials were used.

Earlier aggregate 141048-KGoL8T finished with 281 failures: all 277 historical
identities plus the now-corrected source-graph regression and three chat cases
contaminated by the browser-only MOSS_CHAT_HOME setting. No historical identity
disappeared. The three affected chat/source-graph files passed all 21 when that
directory setting was removed from the unit-test environment. No chat test or
production priority rule changed. The fresh aggregate 143017-SaB79F is running on
682a8162 without MOSS_CHAT_HOME; its exact verdict/identity comparison remains pending.

Read-only current GitHub verification: #3723 and #3724 are open task issues, not PRs;
this branch follows their guarded invoke and host dialog contracts without closing
them or publishing a PR. #3269 merged October 10 and #3349 merged October 11. A fresh
main fetch still resolves 3a9c744d035bf1d91220ec13a634c51453282bb3; migration collision
checking passes. Automatic cross-PR checking is unavailable in the CLI; the documented
manual four-PR file-list snapshot found no 0354 claim.

## Exact continuation

Wait for aggregate 143017-SaB79F, compare every FAIL identity with 040401-c9zwQ0 and
record additions/removals. Then run finance-complete alone through verify-gate, using
the existing isolated toolchain and Chromium plus the private synthetic chat path.
Keep MOSS_CHAT_HOME out of the broad unit environment. Record the actual whole-suite
verdict before declaring this checkpoint verified. Keep source frozen while its
gate runs. All current code is committed/pushed; evidence docs may follow separately.

Next accounting capability: design a versioned, reviewed card-payment-reserve policy
without reinterpreting the existing conservative net-debt budget or prior months.
Start with synthetic conservation fixtures for starting debt, funded/unfunded card
purchases, same-category cash spending, partial payments, cross-month refunds,
positive balances/overpayment, multiple cards and rollover. Prove the model before
adding migration/API/native activation. Then add captured, stale-safe activation
and payment funding with real SQL/native review. Notes editing, richer rules and
reports, household co-editing, unlinked provider convergence and holdings remain
separate matrix items. Actual bank/provider HTTP acceptance still needs permitted
credentials/agreements and is unrun; do not fabricate it or connect a real bank.
