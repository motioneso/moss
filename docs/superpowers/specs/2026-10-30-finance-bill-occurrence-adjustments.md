# One-off bill date and amount changes

Authorized Finance parity continuation, extending #1144/#1148. Commit/push only; no PR publication,
merge, deployment, production data, real credentials, banks or live financial actions.

The official [YNAB scheduled-transaction guide](https://support.ynab.com/en_us/scheduled-transactions-a-guide-BygrAIFA9)
and [editing guide](https://support.ynab.com/en_us/editing-and-deleting-scheduled-transactions-a-guide-Skru9yNJo),
checked October 30, cover changing scheduled amounts/dates and individual occurrences. The
[Monarch recurring guide](https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills)
covers recurring amount/frequency/date management; Bill Sync is a separate provider-dependent feature.
Moss currently creates manual plans and matches/skips/stops them, but cannot change one projection.

## Data and behavior

Add an owned bill-adjustment table through additive module SQL, keyed by plan and original scheduled
date. Store the effective planned date, exact positive expense cents and update time. Retain the
original plan/anchor/cadence unchanged. Matching, skipping and Undo review continue using the original
occurrence identity. A changed date may cross months or years; range reads must include incoming
adjustments as well as remove outgoing ones, without emitting an occurrence twice. Do not shift the
next monthly/yearly date after a February clamp or one-off edit.

Only unreviewed projected occurrences on active owned accounts can be changed or reset. Validate that
the original date actually belongs to the plan. A reviewed occurrence requires Undo review first.
Reset removes only the one-off projection change and returns to the plan's date/amount. Closed-ledger
planning history stays read only for these new controls. Existing match/skip/stop behavior remains.
No transaction is created, no money is reserved or paid, and matched actual amounts remain separate.

Use the current bills review revision/fingerprint and include adjustments in that fingerprint.
Configuration and identifier/date/cent-only activity commit atomically. Recheck account, plan,
decision and captured review under the write, with no partial changes on stale/concurrent requests.
A new future dependency must advance the manual account's MVCC version without changing ledger
revision, money or observation date, preserving the account-close race contract. Close must also
recognize a future adjusted occurrence of an otherwise past one-time plan. Stop must refuse to erase
later adjusted or reviewed occurrences; explain reset/Undo review as the remedy.

Use original occurrence IDs when looking up decisions, including original dates outside the current
visible month. Match candidates must exclude transactions already claimed anywhere, not only by
visible occurrence decisions. Preserve owner/admin RLS, same-account/currency/posting and global
single-match constraints. Calendar math uses validated dates and UTC day arithmetic; owner-local
today still comes from the existing clock seam. Keep existing one-year read windows, 500-plan/
500-occurrence and 1,000-match-candidate bounds; refuse overflow rather than silently truncate.

## Native workflow

Upcoming offers Change this occurrence on eligible projections, showing the original schedule and
current expected date/amount. A separate native dialog edits only this occurrence and captures the
review. Show a before/after summary before the existing mandatory host confirmation. Cancellation
keeps typed values/review; stale or ambiguous saves block until an explicit successful fresh read.
Immediately suppress duplicate writes/dismissal during submission. Never retry a write automatically.

The list sorts and marks overdue state by effective planned date, labels one-off changes and still
shows their original schedule. Reset one-off change also asks for confirmation and preserves the
ledger. Matched/skipped rows explain that their review must be undone before changing a projection.
Use shared Park Press form/dialog/index primitives, semantic colors and compact responsive layouts;
check full control bounds at phone widths, not only document scroll width. No new primary tab or
superficial provider-sync imitation is needed.

## Acceptance

Prove exact-cent and calendar validation, month/year/leap/month-end moves, incoming/outgoing window
membership and stable subsequent cadence. Prove stale/concurrent/foreign/admin refusal, immutable
money/notes/clearing/reconciliation, global duplicate-match exclusion and preserved reviewed history.
Exercise both orderings of account-close/new-adjustment contention, including a held-lock snapshot;
observe the new dependency-version protection fail under a fixture-only negative control and restore
it. Install migrations through the real module installer. Test reset and stop boundaries atomically.

Exercise actual installed UI, API, worker and SQL with synthetic records: host cancel/save, reload,
month-crossing change, stale recovery, reset and unchanged ledger. Inspect desktop/phone light/dark/
Sage screenshots. Run focused units, SQL/migration, lint/types/style/static, complete browser and
aggregate checks. Keep the app map and evidence-linked matrix precise. Automatic bill detection,
calendar presentation, bank Bill Sync, automatic payments and automatic ledger posting remain gaps.
