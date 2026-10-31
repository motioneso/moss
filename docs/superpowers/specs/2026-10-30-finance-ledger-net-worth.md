# Manual ledger net worth

Authorized continuation of Finance #1150 and the practical-parity roadmap. Keep changes on the task
branch, committed and pushed, without merge/deployment or live financial actions. Use synthetic
records. This records the delegated design before implementation.

[Monarch's account guide](https://help.monarch.com/hc/en-us/articles/360048393392-Connect-or-Manually-Add-Accounts),
read October 30, 2026, includes manual assets in net worth. Moss already stores explicit manual
opening balances and immutable posted entries, but its net-worth tool only reads bank snapshots.
Users who start without bank credentials therefore get no net-worth history. Close this specific
gap without inventing market valuations or changing the existing provider snapshot policy.

## Calculation and storage

Add a read-only daily manual-movement projection to the SQL manual-ledger store. Aggregate owned
posted manual entries by account/date with exact numeric sums, preserving potentially large internal
movement totals as integer strings. Include validation evidence for unsafe individual source cents,
wrong currency and entries before the account's opening date. Expose no transaction names or notes.
The existing owner/account/date indexes serve the query; no migration or production data rewrite
is required. Older stores without this read capability disclose unavailable manual coverage.

For each selected-currency manual account with a valid opening baseline, reconstruct balances from
opening date through the authenticated owner's local today. Assets subtract spending-positive
entries; liabilities add them and are subtracted from net worth. Include posted uncleared entries;
reconciliation changes no money. Ignore future entries. Do not backfill before the baseline. Include
the selected window start and local today as ledger-derived points, and actual movement dates.
Pre-window movements determine the first visible balance. Treat manual ledger history as authoritative
for manual accounts, instead of adding it on top of any legacy snapshot.

Keep connected/provider accounts on their existing recorded-snapshot contract. Do not silently use
live account-row balances or estimate missing history. Exclude future snapshot dates. Merge manual
ledger points and provider snapshots through the existing per-account carry policy. Sum signed
balances with bigint and check each public total; large intermediate asset/debt cancellation must
not round or falsely overflow. Every actor remains owner-only; net worth never reads shared mirrors.

## Interface and acceptance

Replace the manual-history gap notice with accurate coverage. Show the recorded total, trend and
an accessible chronological table/summary. A disclosure lists each selected account's balance source
and last-known date, with unavailable accounts explicitly omitted. State that saved provider balances
carry forward and may be older, manual history follows recorded entries, and no market/FX estimate
occurs. Preserve currency selection and explain empty, loading, invalid-data and old-storage states.
Use the authored typography, semantic colors, hairline sections, tabular amounts and phone layout.

Prove asset/debt signs, refunds, equal/opposite manual transfers, opening/year/leap boundaries,
pre-window carry, future exclusion, no invented provider history, missing baselines, mixed currencies,
exact cancellation and unsafe output rejection. Installed SQL tests verify actual owned aggregation,
source validation and no names/notes; negative controls must fail when owner protection is removed.
An installed browser must show the manual-account total and source dates without a bank connection,
retain private-owner boundaries and survive reload in desktop/phone/light/dark. Check that statement
reconciliation and category edits do not change ledger net worth. Update the matrix and app map and
run focused, installed and aggregate checks before the final pushed checkpoint. Property valuations,
holdings, market pricing, balance-history import and household joint net worth remain separate gaps.
