# Finance budget correctness continuation

Date: 2026-10-28. Authorized Finance parity work, extending existing budget task #1148. Keep
changes local, synthetic, tested and reviewable. Do not publish a task/PR or change production.

The manual ledger and CSV slices expose two existing defects more clearly: envelope aggregation
uses ordinary number addition, and a manual cash account is stored as `other/cash`, which the
ready-to-assign predicate omits. Budget UI also assumes USD, mixes currency/account histories and
uses current balances when displaying past months. Fix correctness before adding more plan modes.

## Stage A: exact arithmetic and manual cash

Keep the established positive-carry/overspend policy. Derive category activity, carry, assignments,
income and ready-to-assign in exact integer arithmetic; reject unsafe public results rather than
rounding. Cancellation of large intermediate values must remain exact. Validate each source amount.
Include `other/cash` among budget-funding accounts along with checking/savings and credit cards.
Other assets, loans and investments remain tracking balances. This fixes available cash without
inventing income or changing net-worth signs. Tests cover refunds, gaps, year boundaries, maximum
safe amounts, cancelling values and real manual-account budget reads.

This stage does not claim currency-safe envelopes or credit-card payment reserves. Existing
ordinary assignment concurrency and historical cash remain explicit gaps until the next stages.

## Stage B: one explicit budget currency and trustworthy historical reads

Add an owner-scoped immutable working-currency policy, established through a reviewed page action.
Never silently tag legacy assignments: show their presence and require explicit acknowledgement
that their unchanged cent amounts are interpreted in the chosen currency. Preserve the old ledger.
No FX conversion, automatic history rewrite or second budget is implied. New UI uses the selected
currency for every amount and explains excluded accounts. Existing old queued writes must fail
clearly when currency setup is incomplete rather than write ambiguous assignments.

Scope both funding balances and transaction activity to the chosen currency and budget account
kinds. Pending entries are presented separately from posted budget activity. Past-month funding
uses actual manual ledger balances as of month end and provider snapshots at/before that date;
missing historical provider valuations make ready-to-assign unavailable, never today's balance.
Account histories, transfer boundaries and opening dates require explicit acceptance tests. Future
months need a stated reservation policy before showing a spendable-cash number.

Use shared controls and the existing Park Press budget anatomy: a calm first-use currency review,
a clearly labeled currency beside the month, dense category rows, and explanatory unavailable
states. Preserve mobile keyboard entry, rejected drafts and confirmation/cancellation behavior.

## Stage C: atomic ordinary writes and richer planning

Use an owner budget revision/lock and compare-and-set assignment totals so ordinary assignments,
moves, draft start and undo cannot lose concurrent edits or log only part of a change. Guard every
dependent write, including draft status/undo marks. Keep page writes on the guarded host bridge.
Account/transaction changes that affect available funds must invalidate a stale funds review or
be checked within the atomic operation; do not claim this from assignment-only revision tests.

Then build targets, bills, flexible budgeting and configurable rollover against the corrected
currency/scope model. Each remains a separate tested vertical slice in the parity matrix.

Official comparison evidence: [YNAB multiple currencies](https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno)
recommends separate budgets; [Monarch's currency guide](https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency)
warns about misleading mixed-currency totals. Moss's implementation must preserve currency truth
rather than match those limitations. Sources were read on October 28, 2026.
