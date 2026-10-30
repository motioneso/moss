# Moss Finance practical parity

Date: 2026-10-28. Implementation brief: build toward YNAB and Monarch parity with Moss's
current Park Press identity, preserve data and functionality, use synthetic financial data,
and do not publish, deploy, merge, connect banks, or change real financial accounts.
This local specification records the implementation authorized by that brief. Existing
Finance epic: #1144; ledger/feed/budget/report work extends #1146–#1150. Publication of a
new task issue and PR is withheld by the brief. This is a staged programme, not a claim of
universal parity.

## Current-source audit

Base: `e41aa10f551f9a13a1c2f8b53d356b7186245e4f` (current main at audit). Separate worktree
and branch; original checkout remains untouched. No open PR returned by the Finance search;
open repository PRs at audit were #3812, #3795, #3771, #3753, #3571, #3534. None is a
Finance implementation. Historical [#3269](https://github.com/motioneso/moss/pull/3269)
merged October 10; [#3349](https://github.com/motioneso/moss/pull/3349) merged October 11.

Repository guidance: AGENTS.md, CLAUDE.md, DEVELOPMENT_STANDARDS.md, design-system.md,
shared-checkout, design-system and verify-gate skills. `.agents/skills` and codebase-memory
are absent in this environment; the applicable skills were found under `.claude/skills`.
Architectural observations below come from inspected source, not unavailable graph tools.

- External module: `external-modules/finance`; manifests declare read tools, assistant
  write families, metadata-only queues, navigation and app-map facts. Worker ports isolate
  bank adapters, clock, credentials, KV, household mirror and owner-scoped SQL.
- Data: integer hundredths with spending-positive sign; provider account balances are
  snapshots, not a reconciled transaction ledger. Nine owner-scoped SQL tables and eighteen
  additive migrations. KV compatibility and one-time backfill remain. Never edit applied SQL.
- Domain: provider-id replay and pending-twin replacement, taxonomy/rules/AI categorization,
  envelope carry, account-based ready-to-assign, heuristic transfer exclusion, spending and
  net worth. Found defects: invalid calendar months accepted; unsafe integers accepted;
  cross-currency transfers can pair; batch assignments write before all items validate.
- UI: Budget, Transactions, Accounts, getting started, Reports, Settings. Shared SDK
  primitives and layout-only CSS; responsive row/table layouts. Review and assignment writes
  queue asynchronously; a queued acknowledgment is not a persisted-success receipt.
- Tests: domain/reducer/worker/store/React suites, real module install/migration integration
  suites, existing UAT specs. Local fixture UI inspection is not installed live acceptance.

## Evidence-linked parity matrix

Statuses updated after the reviewed concurrent-budget slice on 2026-10-28. Supported means the bounded
capability is implemented, not full product equivalence. Exact verification and remaining limits
are in the [checkpoint](../plans/2026-10-28-finance-parity-checkpoint.md). The audit above remains
a dated baseline.

| Area                 | Official comparison evidence                                                                                                                                                                                                | Moss status                                                                | Acceptance criteria / next deliverable                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts             | [YNAB linked accounts](https://support.ynab.com/en_us/linked-accounts-in-ynab-B1991f2Cc), [Monarch connections](https://help.monarch.com/hc/en-us/articles/360048393352-Guide-to-Connecting-Your-Accounts)                  | Partial: manual/provider accounts, exact balances, provider sharing        | Manual cash/asset/liability accounts without credentials; archive preserves history; explicit currency; no silent FX sum.                                                                                                                                                                                                      |
| Import               | [YNAB file import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo), [Monarch CSV](https://help.monarch.com/hc/en-us/articles/4409682789908-Importing-Transactions-Manually)                             | Supported bounded manual CSV; provider sync remains separate               | Mapping, sign/date preview, duplicate choices and atomic replay proven for 200 manual rows. Provider-account import, larger batches and category mapping remain.                                                                                                                                                               |
| Reconciliation       | [YNAB reconciliation](https://support.ynab.com/en_us/troubleshooting-reconciliation-issues-rJkijlVki)                                                                                                                       | Supported bounded manual statements; provider/large reviews remain partial | Opening balance + posted ledger matches statement as of date; cleared/reconciled statuses; explicit adjustment preview; pending excluded. Snapshot equality is insufficient.                                                                                                                                                   |
| Duplicates           | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)                                                                                                                             | Supported bounded candidate review; provider ID/pending twin               | Same provider page is idempotent; candidate duplicates never auto-delete; amount, currency, account and date participate.                                                                                                                                                                                                      |
| Categories/rules     | [Monarch rules](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                                   | Partial: taxonomy, exact normalized-payee rules, review, chat edits        | Rule list/edit/disable and preview affected rows; archived categories retain history; no rule overwrites a user allocation.                                                                                                                                                                                                    |
| Splits               | [YNAB splits](https://support.ynab.com/en_us/split-transactions-a-guide-SJLEKwY0q), [Monarch splits](https://help.monarch.com/hc/en-us/articles/360050178492-Splitting-Transactions)                                        | Supported own posted category splits; installed UI proven                  | Allocation cents sum exactly to parent; parent counted once; refunds supported; invalid/stale save changes nothing; sync retains user allocations.                                                                                                                                                                             |
| Transfers/refunds    | [YNAB transfers](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj), [Monarch transfer math](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments)               | Partial: heuristics and signed refunds                                     | Transfers never pair across currency or owner; opposite legs across month end excluded once; refund restores its category; explicit linking and correction remain.                                                                                                                                                             |
| Envelope budget      | [YNAB method](https://www.ynab.com/ynab-method)                                                                                                                                                                             | Partial: reviewed currency, exact math, historical funding, positive carry | All writes validate before commit; no partial batch; cash/credit pending semantics explained; manual history and dated bank snapshots replace today’s balance in historical months; reviewed writes reject stale ledger state; installed concurrent-tab/draft flows proven. Credit-card payment reserves remain separate work. |
| Flexible budget      | [Monarch flex](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting)                                                                                                                              | Partial: cash-backed flexible pool with fixed/non-monthly groups           | One funded total counts member assignment guidance, activity and carry once. Confirmed current-month transitions preserve past policies; exit allocates exact available money. Optional per-member guidance editing, unrestricted future-funded transitions and separate non-cash-backed forecasting remain missing.           |
| Rollover             | [YNAB month rollover](https://support.ynab.com/en_us/when-the-month-rolls-over-a-guide-rkyyd6qC9), [Monarch rollover](https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets)                            | Supported: positive envelope carry; partial overall                        | Gaps/year end/refunds tested; explain overspend reset; configurable rollover and starting balance need explicit policy.                                                                                                                                                                                                        |
| Targets/goals        | [YNAB targets](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks), [Monarch goals](https://help.monarch.com/hc/en-us/articles/44373110771860-Goals-in-Monarch)                                                    | Partial: monthly/date-based category targets; broader goals remain         | Exact cent suggestions, historical versions, reached/overdue states and guarded saves. Account-linked goals, investment growth and automatic funding remain missing.                                                                                                                                                           |
| Recurring/bills      | [Monarch recurring](https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills), [YNAB planning](https://support.ynab.com/en_us/categories/planning-HJgZB2C69)                          | Partial: manual recurring plans and posted matching in Upcoming            | Anchored month-end/leap-year dates; bounded projections; explicit skip/match/undo and stop with history. Actual amounts stay separate. Automatic detection, calendar view, one-off date/amount edits and provider Bill Sync remain missing.                                                                                    |
| Cash flow/reports    | [Monarch reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports), [YNAB income/expense](https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq)                                                | Partial: currency-separated spending, cash flow and snapshots              | Date/account/category filters; currency-safe totals; drill through to exact contributing rows; pending policy; saved views later.                                                                                                                                                                                              |
| Net worth            | [Monarch getting started](https://help.monarch.com/hc/en-us/articles/360048393272-Getting-Started-with-Monarch)                                                                                                             | Partial: daily snapshots, liabilities, carry                               | Stale/missing valuation disclosure; manual assets; currency isolation; no invented historical balances.                                                                                                                                                                                                                        |
| Search/bulk          | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                              | Partial: filters/search and reviewed atomic bulk categorization            | Account/category/posting filters; explicit result limits; owner-safe captured selection; stale/failed writes preserve input; bulk categorization commits all or none. Bulk notes/clearing, rule management and legacy individual-write concurrency remain missing.                                                             |
| Household            | [Monarch households](https://help.monarch.com/hc/en-us/articles/20926382202004-Monarch-for-Couples-and-Households)                                                                                                          | Partial: opt-in shared read mirror                                         | Preserve private-by-default Moss semantics; deleted members excluded; shared labels; never broaden write authority for parity.                                                                                                                                                                                                 |
| Export               | [YNAB export](https://support.ynab.com/en_us/how-to-export-plan-data-Sy_CouWA9), [Monarch reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports)                                                 | Supported loaded filtered CSV; full-history export remains partial         | Exact loaded/filtered scope disclosed, currency and sign explicit, quotes/newlines/formulas safe, no private notes from shared rows. Full history export later.                                                                                                                                                                |
| Investments          | [Monarch overview](https://help.monarch.com/hc/en-us/articles/360048393272-Getting-Started-with-Monarch), [fund classifications](https://help.monarch.com/hc/en-us/articles/48401988544404-Fund-Classification-Definitions) | Partial: balances in net worth                                             | Holdings/performance require provider coverage, valuation policy and licensed data. Trading, financial advice and paid research integrations are out of scope.                                                                                                                                                                 |
| Long-range forecasts | [Monarch forecasting](https://help.monarch.com/hc/en-us/articles/48344305092244-Forecasting-in-Monarch)                                                                                                                     | Out of scope for initial roadmap                                           | Advanced scenarios need explicit assumptions and uncertainty; must not look like guaranteed outcomes.                                                                                                                                                                                                                          |

Currency evidence refreshed October 28: [YNAB recommends separate budgets for separate currencies](https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno). [Monarch's currency guide](https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency) explicitly warns that mixed currencies produce misleading totals without conversion. Moss must preserve currency separation rather than reproduce this limitation. Moss now requires reviewed single-currency setup, preserves legacy assignment cents without conversion and discloses missing historical funding. Concurrent writes are the next correctness priority.

## Ordered slices and UX contract

1. Ledger safety: calendar validation, exact hundredths, safe integers, same-currency transfers,
   atomic assignment batches. Keep existing financial semantics; document remaining mixed-currency
   aggregate and historical ready-to-assign limitations rather than hiding them.
2. Transaction workspace: retain calm numbered/rule sections, tabular amounts, warm paper and
   semantic colors. Labeled account/category/posting filters, clear count and loaded-scope CSV.
   At phone widths stack controls; keyboard controls retain labels and visible focus.
3. Splits: additive storage, bounded allocation editor, exact total and remaining amount;
   preserve original bank transaction. SQL update and activity commit atomically, reject stale
   totals. Changed provider total retains allocations for repair and shows needs-review.
4. Currency-separated Reports: require a choice before mixed-currency totals, retain owner
   boundaries, guard arithmetic and disclose snapshot/pending policies.
5. Accounts: preserve each row's currency, show separate asset-minus-debt totals, and retain
   exact decimal cents in display, inputs and loaded-row export.
6. Authorized platform prerequisite: implement the existing approved #3723/#3724 route and
   host tools handle contract, including confirmation, activity, RLS and actual installed-module
   proof. Foundation PR #3733 is merged; both continuation issues remain open and no matching
   open implementation PR was found on October 28. No competing platform implementation is copied.
7. Manual ledger/accounts and previewed import; reconciliation; budget currency/history policy;
   targets/goals; recurring obligations; flexible budgets and household refinement.

See the [current checkpoint](../plans/2026-10-28-finance-parity-checkpoint.md) for implemented,
missing, dependency-bound and unverified capabilities, exact test receipts and remaining work.

No integration-dependent feature is complete from a mock. New SQL must install through the module
installer and run through the isolated verify-gate. Run focused tests, lint, format, typechecks,
aggregate static/foundation checks and actual-source browser inspection. Synthetic browser proof
is explicitly distinct from the repository's installed real-data live gate; production is untouched.
