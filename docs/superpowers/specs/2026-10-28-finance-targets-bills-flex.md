# Finance targets, bills and flexible planning

Authorized continuation of the October 28 practical-parity brief, extending Finance #1148 and
#1150. Implement locally under the same no-publication, no-live-bank and no-deployment boundaries.
The concurrency plan supplies the currency, exact cents, persisted host actions and revision gate.

## Product decisions

Use the existing Park Press Budget page as the planning home. Targets attach to actual categories;
they do not create another balance or reserve the same account funds twice. Show a calm progress
line below the category name, plain-language remaining amounts and an explicit edit dialog. On
phones keep the category and its target together in the existing ruled rows. Money remains in the
ledger; a target alone never changes assigned or available amounts.

Support monthly contributions and a balance by a calendar date first. Monthly progress is the
month's net assignment, independent of carry and spending. Balance progress is positive available
money in the category; spending reduces it. For date targets, the suggested monthly contribution is
the exact ceiling of remaining cents divided by inclusive remaining calendar months. Recompute
from committed budget state. Past-due unfinished goals say overdue; reached goals say reached.
No growth assumptions, retirement forecasts, debt payoff promises, account-allocation subledger,
weekly targets or automatic funding are implied. Add/edit/remove requires the reviewed budget
revision and ledger fingerprint. Store an effective-month version, so later edits do not rewrite
what a historical month planned. Removal ends future target guidance but never moves money.

Recurring bills are plans, separate from transactions. Provide a ruled Upcoming page with dates,
payees, expected amounts, category/account and clear projected/posted states. Support one-time,
weekly, every-two-weeks, monthly and yearly anchored schedules. Clamp invalid month-end days and
February 29 without letting the clamped date drift future occurrences. A schedule never creates a
posted transaction. A user may match an owned posted transaction once, skip an occurrence or stop
a series while retaining history. Actual paid amounts come from the matched ledger row. Do not
claim automatic bill detection, bill payment or provider Bill Sync.

Flexible budgeting is a month-effective planning mode with fixed, non-monthly and flexible
sections. Flexible categories share one pool; allocations and detail must never count twice.
Changing modes preserves existing ledger, category and assignment history. Do not ship a cosmetic
summary and claim parity. If a trustworthy pool transition is not ready, retain Missing in the
matrix and record the exact remaining acceptance work.

## Acceptance and verification

- Targets: one cent over several months, leap dates, year boundaries, achieved/overdue, negative
  availability, refunds, carry versus monthly contributions, safe-integer overflow, exact history.
- Persistence: owner isolation, stale and competing target edits, atomic revision + activity;
  successful and rejected browser saves keep displayed totals truthful. No live data.
- Bills: anchored dates, bounded horizons, duplicate matching, foreign/pending/wrong-currency
  transactions rejected, replay, edited amount and skipped/matched history. Forecasts labeled.
- Flex: conservation of assigned and available amounts across transitions; no duplicate pool and
  category allocation, historical stability, overspend and rollover policy visible.
- Installed UI: desktop and phone, light/dark and Park palette, keyboard/dialog confirmation,
  empty/loading/error states. Narrow tests and static checks, then frozen aggregate gate.

## Official comparison evidence

[YNAB target types](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC)
provides the target-type comparison; its dynamically rendered article body is unavailable to the
current reader, so do not infer undocumented details.
[Monarch Save Up Goals](https://help.monarch.com/hc/en-us/articles/44373182867476-Using-Save-Up-Goals)
(updated October 19, read October 28) supports amount/date/contribution planning, account funding,
transaction linking and optional spending effects. This bounded category-target slice covers only
part of that broader capability.
[Monarch recurring bills](https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills)
describes reviewed recurring detection and manual tracking; bank-dependent Bill Sync remains a
separate integration gap.
[Monarch Flex Budgeting](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting)
describes fixed/non-monthly/flexible sections and one flexible spending pool. Moss must preserve
those accounting semantics before claiming support.
