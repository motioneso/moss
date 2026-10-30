# Manual card-payment reserves: implementation checkpoint

Later continuation: [reviewed bill-entry checkpoint](2026-10-30-finance-record-bill-entry-checkpoint.md)
implements the formerly missing record-from-bill slice and supersedes that next-action note below.
Earlier receipts retain their exact tested inputs.

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
9c0735e1: 181 backend cases plus all 22 installed native flows. Receipt 190526-A6wcPC,
fingerprint c631c6eed2f7ed1d0a593d05849b0da459ecd75d73175aff022a411a9b5fd858.
The clean focused card/module SQL receipt 190242-PBNK2t passed all **26 in three files**
at the same commit/fingerprint, including the generic locking-read/rollback/timeout cases.

4f9358fd expands only the native test to record an enrolled card's payment through Accounts.
That additional installed path passed at clean da66aeb8 (test plus docs/evidence; production
code unchanged), receipt 191354-BK0Kda, fingerprint
134826048079a20f3955bd13d1dcd4699c23eafe7784e124f264175840565422: one selected case
passed, the other 21 were intentionally skipped by the narrowed command. It records a 100 USD
payment through real UI/host confirmation, checks that no movement occurs before confirmation,
then verifies one balanced transfer pair, reserve 150→50, debt 550→450 and unchanged 800 Ready
and 50 spending. Later funding/release, stale refund rejection and negative-cash recovery also
pass in the same flow. See the [original inspected screenshots](../evidence/finance-card-reserves-2026-10-30/README.md).

All receipts above use Node 24.19.0, pnpm 10.6.2 and disposable PostgreSQL 17.11. Provider and
credential ports in the shared fixture are synthetic; actual bank/provider HTTP acceptance is
unrun. Host/UI/API/worker/storage/RLS are actual installed code. Production files are unchanged
after 9c0735e1. Full typecheck passes there, including root, tests, web and all external modules.
The test-only actor annotation was the sole preflight type failure and is corrected.

The canonical aggregate at clean da66aeb8 (191713-nwVXtY, fingerprint
134826048079a20f3955bd13d1dcd4699c23eafe7784e124f264175840565422) passed all static
checks, including lint, format, policy and all typechecks, then **failed, rc1** in units:
19,748 passed, 277 failed and 16 skipped; 24 failed files and 1,636 passed files.
All 277 individual test failure identities exactly match earlier receipt 143017-SaB79F;
none is Finance. Their normalized identity-set SHA-256 is
dd40a5d54c5f4a990654eb4039f9055a3ecad8a99ada3088d76336ede12a0ba9.
There are also four new suite/setup errors across three visual-parity files: this aggregate
omitted CHROMIUM_PATH and the default Playwright browser is absent. This is not a clean
aggregate or a zero-addition suite-failure result.

Recovery at the same clean da66aeb8: all **13 cases in those three files passed** using
CHROMIUM_PATH=/usr/bin/chromium and the same task XDG directories. Command: pnpm test:unit
with tests/unit/parity-capture-offset.test.ts, tests/unit/parity-setup-hygiene.test.ts and
tests/unit/parity-walk-setup.test.ts; receipt /tmp/finance-card-recovered-parity-units.log.
No test, browser setup helper or product code changed for this recovery. The full aggregate
was not rerun after that environment correction. Its disposable database was removed normally.
The wrapper's initial database migration passed, but the later chained db:migrate, UAT seed and
repository integration stages did not run after the failed unit stage. CI e2e is unrun.
A final documentation-only commit preserves these results and original images; it does not
constitute another production-code gate.

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

Superseded full run 183734-0VIDUz was stopped intentionally (rc143) for the
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
No real bank connection or payment is needed. For the extended check, record a synthetic
100 USD cash→card transfer in Accounts. Expect cash 900, card debt 450, payment reserve 50,
Groceries still spent 50 and Ready still 800. Reload and verify the values remain.

## Release note draft

Category: Added
Title: Card-payment cash reserves
Description: Reserve cash for manual card payments, review funded spending and refunds, and
change payment cash without rewriting earlier budgets.
