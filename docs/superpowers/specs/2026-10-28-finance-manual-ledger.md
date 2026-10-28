# Finance manual accounts and ledger

Date: 2026-10-28. Extends the authorized Finance parity brief, #1146–#1150 and #3160.
Implementation is local to `task/finance-parity-20261028` under `~/Jarv1s`. Ben delegated
reasonable product decisions and the platform work needed to finish Finance. No publication,
production data change, bank connection, external delivery, merge or deployment is authorized.

## Decisions and bounded delivery

Manual accounts are first-class accounts with an explicit source, not invented bank connections.
A manual account has a name, asset/debt type, immutable currency, opening date and opening
balance. Opening balance is the balance immediately before the first entered transaction on
that date. It is a baseline, never income or spending. Positive checking/cash/savings balances
are money owned; positive credit/loan balances are money owed. Signed net worth subtracts debts.

The existing money model stores hundredths. Initially offer USD, EUR, GBP, CAD, AUD, NZD, CHF,
CNY, HKD, SGD, INR and MXN for new manual accounts. All have two minor-unit digits. Do not offer
JPY or three-decimal currencies until the storage/format migration is explicitly designed.
Provider accounts and their currencies retain current behavior. No FX conversion or mixed total.

Every posted manual entry has a stable UUID-derived identity, account, calendar date, payee,
integer cents, category, optional own note and cleared state. Positive amounts mean money out;
negative amounts mean money in/refunds. Asset balance changes by minus the amount; debt owed
changes by plus the amount. The parent transaction remains the only balance movement when split.
Dates are explicit civil dates. Reject impossible dates and dates before the opening baseline.
Future occurrences belong to the later scheduled-entry design rather than silently changing
current balances. Resolve the user's timezone through the existing host context before enforcing
this boundary; never accept a caller-provided actor or timezone as authority.

Account and entry creates use client-retained operation UUIDs. A replay with identical original
fields returns the original result without a second balance movement or activity row; different
fields under the same identity return a conflict. On an ambiguous response, retain the identity
and input and instruct the user to refresh/check. Do not generate a new identity automatically.
SQL inserts, balance changes and metadata-only activity must commit in one statement. Insert a
transaction first with conflict-do-nothing, and derive account updates/activity only from rows
actually inserted. Lock the account and guard the exact resulting balance before inserting.
A failed insert must never leave a changed balance. Race two different entries and two identical
replays in integration tests. Bigint intermediates must remain within safe integer bounds before
returning to JavaScript. Do not silently round an overflowing total.

Add migrations after existing 0019; never alter installed migrations. Nullable provider item IDs
allow manual accounts to remain separate from bank status. Existing rows default to provider.
Add source/opening/revision/archive fields without rewriting balances or IDs. Existing provider
sync and user sharing updates must preserve manual ledger balances and source metadata; a stale
`putAccount` call cannot restore an older computed manual balance. All SQL remains through the
Finance store port and installer-generated owner RLS. Legacy KV must fail explicitly for new
ledger writes until the existing migration completes; it must not fabricate a second ledger.

## UX and vertical slices

1. **Manual account + entry.** Accounts shows an Add account action alongside existing bank
   connection. A shared Dialog asks name, type, currency, opening date and balance, with explicit
   debt wording and an exact preview. Successful creation shows the account in a Manual accounts
   section, without a sync error or bank prompt. Each account exposes Add transaction. A compact
   shared dialog asks date, payee, money in/out, amount and category; entered values survive errors.
   The account balance and register refresh only after committed success. Old hosts clearly state
   that a host update is required. Empty states offer manual setup without any bank credentials.
2. **Statement reconciliation.** Show ledger, cleared and statement balances with an explicit
   statement date and exact difference. Mark cleared entries and finish only at zero difference.
   Reconciliation records and marks commit atomically under the account lock. Reconciled entries
   and dates cannot be changed by ordinary editing. A non-zero difference opens review, never an
   automatic adjustment. Explicit adjustment preview is a later bounded action.
3. **CSV preview/apply.** Parse in the browser with explicit date/sign mapping and account currency.
   Display rejected rows, totals and conservative duplicate candidates before apply. Limit initial
   batches and reject the whole batch if one row is invalid. Use stable import identity and exact
   replay comparison. A repeated import cannot double the account balance. Potential duplicates
   require a choice; never auto-delete. File contents use the synchronous tool body, never a queue.
4. **Transfers and account lifecycle.** Explicit same-currency linked legs lock accounts in a stable
   order and commit together; reports/budgets exclude each transfer once. Archive retains history
   and stops new entries; non-zero archive effects on totals must be explicit. Never delete history
   to make an account disappear. Provider account modifications stay outside manual tools.

Use current Park Press primitives/tokens, Archivo headings, tabular amounts, hairline sections,
keyboard/focus behavior and phone layouts. No component-local colors or replacement modal system.
No new dashboard cards are needed to make entry understandable. Update the module app map for each
implemented form, error and prerequisite. Do not advertise later slices before their proof exists.

## Acceptance and evidence

- Preserve installed provider records and the KV-to-SQL backfill; install all additive migrations
  through the real module installer. Fresh and upgrade runs remain idempotent.
- Exact opening/spend/income/refund/debt math; safe-integer boundaries; impossible/leap dates,
  month/year edges and user timezone around midnight. Pending provider rows remain distinct.
- Same operation replay and concurrent replay yield one transaction and one activity event;
  distinct concurrent operations accumulate both amounts. Foreign-owner IDs and inactive module
  writes are unavailable under the actual runtime role. Observe owner enforcement fail when the
  corresponding protection is removed in an isolated test, then restore it before acceptance.
- No partial ledger, balance or activity on a rejected category/date/amount/currency/state.
  Provider sync cannot overwrite manual rows. Sharing is explicit; notes never enter the mirror.
- Frontend tests cover exact money input, required fields, older host, pending, cancelled, rejected
  and uncertain saves. Actual Chromium checks cover 320/390/768/1440, light/dark, focus and overflow.
- Extend the opt-in installed Finance browser test: create an account and entry via actual UI,
  reload and read persisted balances/register through real API/worker/RLS; no intercepted app
  responses. Synthetic identities and entries only, throwaway verify-gate database, clean teardown.
- Run focused tests, relevant database gates and repository aggregate checks after significant
  edits. Separate fixture evidence, assembled live proof, unrun CI and remaining parity gaps.
