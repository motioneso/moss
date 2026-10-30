# Reviewed manual entry from a due bill

Date: 2026-10-30. Authorized continuation of Finance #1148 on the isolated parity branch.
No merge, deployment, PR publication, live bank connection, production data or financial instruction.

## User workflow

Upcoming offers Record bill entry on an unreviewed due occurrence on an active manual account.
The shared scroll-body dialog explains that this records an expense that already happened; it
never pays a bill. It starts with the bill name, account, category, effective date and expected
amount. The user edits actual date/amount and cleared state. Names/categories stay attached to
the reviewed plan in this first version. Exact decimal parsing is reused; future posted dates,
pre-opening dates and reconciled periods cannot be recorded.

A read-only preview captures the current budget revision/fingerprint, including account, ledger,
statement, bill and adjustment rows. Show actual amount/currency/date, expected amount and exact
account balance/debt before and after. Explicitly distinguish debt signs. A posted same-account,
same-currency, same-amount expense within seven calendar days blocks this convenience workflow,
even if already claimed. Show bounded candidate facts without private notes. Direct the user to
review/match existing records first. If it truly is a separate expense, Accounts' explicit manual
entry followed by Match posted remains available. No duplicate is deleted or matched automatically.

Cancel preserves input and makes no change. Confirm record invokes the mandatory host confirmation.
Persist one expense, change its account balance once, and match the original occurrence atomically.
Reload shows the actual amount and one ledger entry. Uncertain/stale failures preserve the review
and block retries until an explicit saved-state check. No future entry or background schedule is
created. The occurrence identity remains its original due date after one-off adjustments.

## Storage and contracts

Reuse existing owner-only transaction, account, occurrence, activity and budget tables; no schema
change or edit of an applied migration is needed. Add a SQL-only bill-entry store, read-only preview
and confirmed record tools. Legacy KV/provider accounts cannot record from this workflow.

The canonical owner/module SQL ordering contract remains. One dependent CTE statement must validate
captured revision/fingerprint, schedule membership, unreviewed occurrence, plan/account/category/
currency agreement, active manual account, date/statement bounds, duplicate absence, safe balance
and ledger revision, then insert entry, update balance/revision, attach match and log metadata-only
activity. Each effect depends on the successful gate; unique-conflict errors roll back the statement.
No two-step manual-create followed by bill-match is acceptable.

An operation UUID names the entry. Its digest binds original occurrence and all intended financial
fields, excluding transient review tokens. Exact completed replays with the existing matched link
return unchanged; changed intent or a removed/different match conflicts. No orphan can be repaired
by replaying an old write. Read-only replay lookup precedes stale-review preflight but remains RLS
scoped. Concurrent new identities for the same occurrence can produce only one entry/movement.

## Acceptance and evidence

- Handler tests: future/local-date boundaries, adjusted due identity, input cents, live categories,
  provider/closed accounts, duplicates, safe balances, stale captures and exact replay behavior.
- Actual disposable PostgreSQL: one entry/balance/match/activity/revision change; exact replay;
  same-ID changed-intent conflict; concurrent different IDs; stale ledger/bill/category/statement
  rejection; date/opening/reconciled/overflow and duplicate guards; rollback with no orphan.
- Foreign and admin actors cannot inspect or write the owner's records. Observe a relevant guard
  failing with its protection removed in an isolated fixture, then restore and rerun positives.
- Mandatory host confirmation is exercised through the installed app, including cancel and no
  ledger movement before approval. A negative control must fail when the new tool's confirmation
  policy is removed, then restore it. Never bypass platform checks for acceptance.
- Inspect desktop/mobile and light/dark preview, duplicate, empty/loading/error states. Preserve
  synthetic-only original screenshots and exact tested commits/fingerprints.
- Run focused units, installed UI and SQL tests, repository static/aggregate checks as appropriate;
  distinguish passes, known failures and unrun suites. Keep bounded capability status Partial until
  actual installed acceptance passes. Commit/push a precise checkpoint if the full slice is unfinished.

Account-linked goals, APR projections, automatic bill posting, editing original transaction names,
notes/tags, provider Bill Sync and live financial acceptance remain separate scope. This workflow
adds no claim of universal YNAB/Monarch parity.
