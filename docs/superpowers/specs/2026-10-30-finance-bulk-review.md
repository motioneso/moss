# Reviewed bulk transaction categorization

Authorized continuation of Finance #1147, #3176 and the practical-parity roadmap. Keep the isolated
branch pushed, without merging or deploying. Use only synthetic financial records for verification.

The register needs an explicit selection of loaded, owned, posted transactions. Shared rows remain
read-only; pending and split rows cannot join this first bulk-category operation. Show selected
count, target category and an explicit host confirmation. Keep amounts, dates, clearing and
reconciliation records unchanged. No rules are created by a bulk edit. Transfer classification
remains a separate gap; do not turn bulk editing into implicit financial transfers.

Return an opaque per-row revision with SQL transaction reads in the same statement as each row's
values. Legacy KV and old hosts have no bulk-write capability. A single SQL statement locks selected
rows in stable id order, checks every reviewed token and the destination category, then changes all
selected categories and their metadata activity rows or none. Merely checking a count before UPDATE
is insufficient: a concurrent writer can invalidate one row after other selected rows were changed.
Use FOR UPDATE and rechecked revision predicates before admitting the whole batch.

The UI exposes selection for eligible loaded rows, select/clear loaded selection, category choice,
and a review dialog listing count and records. Confirmed persistence refreshes the register;
cancellation keeps selection and choice. A stale/ambiguous response retains choices and requires
checking saved records before another attempt. Search, filter and month changes must not silently
retarget an old selection; key selection by stable row id plus captured revision. Limit one bulk
operation to 200 records and never fetch unseen transactions merely to expand selection.

Prove two simultaneous edits cannot partially commit or overwrite a newer categorization; reject a
foreign, missing, pending, split or stale row with zero activity/metadata changes. Test exact
account/date/amount preservation, reconciled manual rows, confirmation cancellation and a real
installed desktop/mobile/light/dark flow. Add app-map facts in the same slice. Broader bulk notes,
clearing, rules, split editing and cross-household writes remain partial until separately built.
