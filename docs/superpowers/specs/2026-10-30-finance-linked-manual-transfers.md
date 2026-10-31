# Linked manual transfers

Continuation of the authorized Finance parity programme, following the manual-account lifecycle.
Existing tracking: Finance epic #1144 and ledger/feed/budget/report issues #1146–#1150. No new
issue/PR publication, merge, deployment, credentials or real financial action is authorized.

[Monarch transfers and credit-card payments](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments),
updated October 15 and read October 30, distinguishes movements between owned accounts from new
spending. [YNAB transfer transactions](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj)
and [adding transactions](https://support.ynab.com/en_us/how-to-add-transactions-in-ynab-HyDwA_byi)
likewise distinguish transfers from category spending. Moss currently infers transfer candidates;
that does not establish an explicit linked ledger pair or safe manual recording.

## Bounded first slice

Record a synthetic/manual movement between two different owned, active manual accounts in the
same supported two-decimal currency. Support the account kinds already included in Moss's
conservative net-debt budget funding: cash/checking/savings and credit cards. Exclude asset,
loan, provider and shared-owner endpoints, cross-currency moves, bank instructions, interest/fees,
matching existing imported entries and deletion/reversal workflows from this first slice. Explain
those limits in the interface. Credit-card reserve budgeting remains a separate missing capability.

Use the existing spending-positive transaction convention: positive source outflow, negative
destination inflow, with debt balances using their existing sign rule. Each pair is excluded from
income/spending but included in balance history and reconciliation. Its signed net worth and the
current funding basis remain unchanged. Never infer a pair from coincidentally similar purchases.

## Ledger and concurrency contract

An additive module migration creates owned transfer events and links both new transaction rows.
The event retains immutable identifiers, endpoints, date, currency, exact amount and replay digest.
Both transactions retain a durable transfer identifier, use the transfer category and cannot become
category spending or splits through legacy or reviewed edits. RLS and owner foreign keys protect
events and endpoints; admin has no private-data bypass. Exports disclose the explicit link without
notes or household mirrors. Existing provider/manual data and migrations remain intact.

A review read returns eligible named accounts, exact balances, opening/statement boundaries and
opaque account versions. The confirmed write locks both accounts in deterministic ID order and
rechecks captured versions, type/source/ownership/archive/currency, valid owner-local dates,
statement locks and safe-integer resulting balances. Store cents as integers throughout; intermediate
math uses exact arithmetic. No half pair, half balance update or activity survives a failed write.

Operation UUID and a digest of the immutable financial payload make explicit retries idempotent.
A repeated identical operation never moves balances twice, even after an ambiguous result; changing
its payload conflicts. Version references are not financial payload. A concurrent close/reconciliation,
entry, import or transfer must serialize or reject the captured review, never silently overwrite it.
Metadata-only activity carries identifiers, never private notes. Do not silently retry writes.

## Moss interface

Add Record transfer beside Add manual account in Accounts. The dialog uses shared Park Press
primitives, semantic colors and calm compact spacing. Pick From/To, then exact amount, recorded
date and clearing state. Filter valid destinations by currency and make empty/unsupported states
explicit. This records a past movement in Moss; it sends no money or bank instruction.

A captured review names both ledgers, amount/currency/date, resulting balances and budget/report
meaning before mandatory host confirmation. Cancellation retains the draft and operation identity;
ambiguous/stale outcomes retain inputs and block until explicit fresh reads. Saved success waits for
persistence and refreshes related account/register/report views. Clearly mark linked transfers in
Transactions; offer account history navigation without category/split controls for their legs.

## Acceptance

Test cash/cash and cash/card signs, inverse debt movements, zero net worth/funding/spending,
opening/statement/date/currency/source/owner/archive/precision refusal, exact maximum cents,
replay/conflicting reuse and all-or-none pairs. Exercise deterministic opposite-direction transfers,
concurrent entry/close/reconciliation and identical-operation races. Observe ownership/version/
confirmation tests failing with each protection removed, then restore and prove green.

Install the actual module in disposable synthetic-data tests. Exercise cancelled/saved/stale UI,
reload/history/export, source/destination currency choice, empty states, desktop/phone and
light/dark/Sage screenshots. Run relevant migration, backend, frontend, lint, type, static and
aggregate checks. Record failures and unrun checks honestly. Keep overall transfers Partial until
existing-transaction matching, off-budget endpoints, reversal and provider coverage are separately
implemented and evidenced; this slice alone is not YNAB/Monarch transfer parity.
