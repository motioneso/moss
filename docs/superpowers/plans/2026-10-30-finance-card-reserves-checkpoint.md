# Manual card-payment reserves: implementation checkpoint

Date: 2026-10-30. Branch task/finance-parity-20261028. No merge, deployment or PR publication.

Implementation commits: 9b9db8dc (owner/module mutation ordering), d6c6a1c3 (vertical slice),
84c3009f (scoped native fixture and foreign-write proof), 5387107d (compact review and exact
input), f0d1a224 (closed-card reserve retention), 5817d0f4 (historical read boundary),
5438578c (locking-read ordering and race barriers), 9c0735e1 (explicit test actors).

## Delivered capability

Budget now offers reviewed per-manual-credit-card payment reserves in the working currency.
Existing cards retain full-debt accounting until explicit host-confirmed enrollment in the current
month. Older months retain their original method. Funded purchases move category cash into the
reserve; cash spending gets first claim on limited category funding. Multiple cards share remaining
cash proportionally, with deterministic exact-cent rounding. Flexible pools fund cards once.
Unfunded credit purchases never create Ready. Explicit complete manual payment pairs consume
reserved cash; refunds, overpayments, positive card balances and statement credits have distinct
rules. Starting debt needs explicit assignment. Current-month funding sets desired available cash;
release is possible, including from a closed card. Negative payment cash blocks automatic target
funding. No transaction or bank payment is initiated by this budget workflow.

The payment preview prioritizes resulting cash and Ready above the fold at 320px, labels its
currency, preserves cancellation and blocks uncertain/stale retries. Monthly payment activity is
disclosed on demand. Shared inline Dialog owns focus, scrolling and the fixed footer. A later
unlinked transfer pauses the affected budget with a Transactions repair path; it cannot block a
prior month. Exact input formatting and parsing preserve cents up to safe integer limits.

Two additive owner-only tables (module migrations 0040/0041, 23 owned tables total) enter the
captured budget fingerprint. Canonical module SQL serializes mutations by actor/module before
the authored statement snapshot, preserving RLS, read-only validation, timeout and redaction.
Tests demonstrate waiting, then rejection after an earlier ledger write commits; independent
owners/reads proceed, and timeout/rollback releases the key.

## Verification checkpoint

Full Finance acceptance passed all **203 tests in 18 files** at clean production commit
9c0735e1: 181 backend cases plus all 22 installed native flows. Receipt 190526-A6wcPC
records the exact input; its fingerprint is recorded below once the aggregate finishes.
The later 4f9358fd change only expands the native test to record an enrolled card's payment
through Accounts, with a fresh receipt pending. Production code is unchanged.
Repository aggregate results remain pending. Current clean focused
card/module SQL receipt 190242-PBNK2t passed all 26 in three files at 9c0735e1. Earlier backend
receipt 185409-iUPMBc passed all 194 in 18 files after the ordering fix; later changes cover
nested comments and a test-only actor type. Full typecheck passes at 9c0735e1, including
root, tests, web and all external modules. The test-only actor annotation was the sole
preflight type failure and is corrected. Lint, format and other static categories passed
before that annotation fix; the canonical aggregate will repeat them at its own input.

First complete receipt 184219-Ks94xp failed 13 task-related race cases (190 passed, seven
unhandled deadlock/timeout errors). Locking SELECTs now acquire the same owner/module key
before taking rows, so later writes cannot reverse acquisition order. Existing race tests
observe actual blocking PIDs at either the ordering boundary or the authored row query,
retaining all stale/replay/financial-state assertions. The new locking-read-then-write case
was observed failing with that path removed (185304-3nuvAT: one fail, 25 pass), then restored.
The lexer recognizes four lock clauses through comments and quoted text; a nested-comment
case was red before the scanner fix and green afterward.

Ownership/serialization negative receipt 184802-zeT27Y at 5817d0f4 intentionally disabled
only the fixture tables' RLS plus the owner mutation lock in its isolated checkout: exactly
two expected failures, ten passes. Foreign/admin reads and updates were observed; guards
were restored. No negative mode ships enabled. Current positive SQL includes these checks.

Earlier receipts below describe their own exact input and do not replace current checks. Superseded full run 183734-0VIDUz was stopped intentionally (rc143) for the
historical-boundary regression; it is neither a pass nor an unexplained hang.

## Remaining scope and next action

This remains Partial product parity. Provider-card reserves, linking existing unpaired imports,
changing/disabling historical enrollment, interest/APR payoff projections, account-linked goals,
transaction note editing/tags/attachments, holdings/performance and bank acceptance remain gaps.
Live credentials/provider agreements and investment data require separate access and authorization;
manual software gaps do not. No optional user decision is blocking implementation.

Next high-value slice: a reviewed “Record bill entry” flow from a due recurring occurrence into an
owned manual ledger. Reuse the existing bill, budget fingerprint, manual account/statement and host
confirmation contracts; atomically create an idempotent entry and match the occurrence. Detect
existing candidates before offering another entry. Never label this “Pay”, create future entries,
or send a bank instruction. Write its spec against #1148 before implementation, then test actual
SQL, replay/stale/concurrent handling, and native cancellation/reload on synthetic data.

## Suggested synthetic user check

On the task branch, use a fresh synthetic Finance owner: add cash of 1,000 USD, a card with
500 USD starting debt, assign 100 USD to Groceries and record a 50 USD card purchase.
Review Card payments with 100 USD assigned for starting debt. Cancel first and confirm that
nothing changes; then confirm. Expect 150 USD payment cash, 550 USD card debt, 50 USD left
in Groceries and 800 USD Ready. Try the review on a phone, including keyboard navigation and
reloading after a confirmed save. These exact totals assume no other accounts or assignments.
No real bank connection or payment is needed.

## Release note draft

Category: Added
Title: Card-payment cash reserves
Description: Reserve cash for manual card payments, review funded spending and refunds, and
change payment cash without rewriting earlier budgets.
