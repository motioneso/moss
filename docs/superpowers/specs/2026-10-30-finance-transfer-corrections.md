# Audited corrections for linked manual transfer recordings

Authorized continuation of Finance #1144/#1148. Commit/push the isolated task branch; no published
PR, merge, deployment, production data, credentials, bank connection or real financial action.
This is a correction to Moss's own manual ledger history, never a payment or bank instruction.

## Comparison and scope

[YNAB transfers](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj) and
[Monarch transfer/card math](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments)
identify movements between owned accounts separately from spending. Monarch's October 15 guide
excludes transfer categories from spending/budget/cash-flow totals and treats a card payment as
a movement of cash and debt. Preserve that exact accounting boundary. Sources were checked
October 30; the YNAB page did not expose readable body text in the current browser tool, so do
not infer further competitor editing semantics from its title. Audited inverse entries are a
Moss design choice, not a claim that competitors implement this same policy.

Existing linked manual transfers save an owned receipt, two signed legs and exact account balances
atomically. They have replay identities, captured account revisions, currency/precision/date and
statement boundaries. They currently cannot be corrected. Do not destructively edit/delete their
original records or re-open a completed statement. Instead record one explicit inverse pair,
linked to the original receipt. A correction has its own operation identity and date, never earlier
than the original and always after both current statement cutoffs, on/after both opening dates and
no later than the owner's Moss-local today. The date remains historical if the user chooses a
valid unreconciled historical date. Amount, currency and inverse endpoints come from the owned
original receipt on the server, not caller-selected replacement values.

## Data and atomicity

Add one additive owned correction-link table with an owner/original primary key and unique
owner/correction key, both referencing the owned canonical transfer receipts; original differs
from correction. Keep original rows and reconciliation marks unchanged. One original can be
corrected once. A correction receipt may itself later be corrected once, forming an append-only
history rather than reviving/deleting earlier events. New receipt ids prevent cycles.

Reuse the existing ordered-account-lock transfer mutation for ordinary and correction pairs.
The correction path additionally checks its captured original/leg revision, exact inverse source
integrity, date and absence of an existing correction. Insert receipt, both legs, balance/ledger
revision updates, correction link and activity in one SQL statement/transaction. No extra allocation
ledger or mutable balance snapshot is introduced. Existing owned RLS applies to the new table;
no admin or household write bypass. Account versions serialize concurrent distinct operations;
the unique correction link is an additional invariant. Record correction relation in activity.

The financial payload digest includes the original transfer identity and excludes captured
versions, so exact same-operation retries can return an unchanged receipt after account changes.
Existing-operation lookup comes before current eligibility checks. Different saved payloads under
the same identity conflict. Native uncertain writes never automatically retry; an explicit fresh
read shows a saved correction if it committed. Reconciliation/archive/ownership/currency/precision
boundaries remain mandatory; original reconciled history may be corrected only with a new eligible
posting date. Do not silently reopen accounts, create adjustments or reinterpret currencies.

## Native review

Use current Park Press Transactions rows, shared Button, Dialog, Note, Checkbox and existing exact
balance formatter. An owned linked row offers Review transfer; shared rows remain read only.
The dialog first reads the owned original receipt and current eligible accounts. Show From, To,
original amount/currency/date, current correction status and an explanation that saved original
history stays intact. No original receipt or unavailable storage gets an honest named error and
explicit read recovery. Closed/ineligible ledgers explain why another correction cannot proceed.

For an uncorrected original, choose Correction date and whether both new entries have cleared,
then Review correction. The captured review shows inverse direction, exact amount/date and both
current balances before/after (card balances explicitly owed). Back retains fields. Confirm
correction invokes the guarded host write and requires its mandatory confirmation hook. Cancel
keeps the captured review; duplicate clicks/dismissal are locked immediately before React paints.
Stale or uncertain outcomes require an explicit successful saved-record check. Honor Retry-After
for read recovery and never automatically retry a write. A successful save refreshes transactions,
accounts, budget and reports through the existing invalidator. Reopening the original shows the
linked correction, and a user can review that receipt's own subsequent correction history.

Keep phone/desktop controls and footer within bounds using scrollBody; loading is a quiet sentence,
errors preserve useful original facts/input, and empty/unsupported states explain the next action.
No new bespoke color/class or generic platform confirmation bypass. Update app-map/tool metadata.
Owned complete history export must retain correction identities for both original and inverse
entries; no private counterpart names are added to shared mirrors.

## Acceptance

- Migration/install/backfill and manifest coverage; ordinary transfer regression remains green.
- Actual SQL cash/cash and cash/card inverse math, exact sum, prior history unchanged, original
  reconciled marks preserved; malformed/foreign/admin/current-version/date/archive/currency/unsafe
  rejections write nothing. Same operation is replay safe; changed digest conflicts; concurrent
  distinct corrections have one winner. Reconcile/close races reject changed reviews.
- Observe fixture-only RLS/duplicate protection negative controls fail, then restore guards and
  record the final result. Do not weaken production confirmation, ownership, CAS or constraints.
- Units pin handler validation/canonical derivation, mandatory native confirmation and duplicate,
  stale/uncertain/dismissal behavior; exact displayed balances match server sign conventions.
- Installed actual UI with synthetic manual ledgers: original transfer, correction review, host
  cancel/confirm, reload, unchanged original receipt, new linked legs, exact balances and report/
  budget exclusion. Inspect light/dark/park themes at phone/tablet/desktop widths and export links.
- Run scoped lint, complete types, formatting/size/UI checks, relevant SQL/installed browser and
  aggregate gate. Record source fingerprints and separate baseline failures from regressions.

Existing-import/provider matching, unilateral imported transfer repair, editing transfer amounts,
FX, loans/investments and household co-editing remain partial/missing. Credit-card payment reserve
policy is unchanged. Never claim universal transfer or YNAB/Monarch parity from this bounded slice.
