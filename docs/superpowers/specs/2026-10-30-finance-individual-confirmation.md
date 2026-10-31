# Reviewed individual transaction confirmation

Authorized continuation of the Finance parity task and #1144/#1147. Commit and branch push only;
no PR publication, merge, deployment, real credentials, banks or live financial actions.

[Monarch transaction editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)
was checked October 30. Its broad transaction editing and rule workflows remain separate from this
bounded improvement. Moss already has captured, always-confirmed bulk category editing and loaded
category confirmation. The individual Needs a look Confirm button still submits a legacy queue job,
even for an owned posted unsplit SQL record without a merchant rule. Queue acceptance does not
establish persistence and should not be presented as an awaited saved result.

Extend the existing individual captured review to that path. For an unchanged category, use the
existing `finance.transactions.confirm` tool with the captured row revision; for a deliberately
changed category, use `finance.transactions.bulk-category`. Reuse the existing review dialog,
confirmation guard and metadata-only database contracts. Do not create a new writer or alter
amounts, currency, dates, notes, clearing, statement records, balances or merchant rules. Existing
confirmation records user provenance; do not claim to preserve an automatic categorization origin.

The review shows exact money, date and the existing category, or the before/after category when
changed. Use singular, plain financial language, shared Park Press dialog/index/button primitives,
and existing semantic colors. Keep host cancellation and captured inputs, immediately suppress
repeat submission/dismissal while pending, and announce success only after persisted success.
Stale or ambiguous outcomes block resubmission until an explicit successful read of saved records.
No automatic write retry. Keep pending/KV/rule workflows on their existing compatibility paths,
with those limitations explicit; transfer/shared/split exclusions remain.

Prove the unchanged-category tool choice, capture stability, cancellation, duplicate suppression,
persisted success, uncertain/stale refusal and no automatic retries in focused component tests.
Exercise the actual installed UI, host guard, worker and SQL with synthetic Needs a look records:
cancel, confirm, reload, deliberately change a category, and reject a competing financial edit.
Inspect desktop/phone light/dark/Sage layouts and screenshots. Keep the app map and parity matrix
truthful; run relevant unit, SQL, lint/type/static, full installed browser and aggregate checks.
This is not canonical merchant-rule management, provider pending-ID convergence or universal parity.
