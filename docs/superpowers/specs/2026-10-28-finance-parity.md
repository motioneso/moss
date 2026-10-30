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

| Area                 | Official comparison evidence                                                                                                                                                                                                | Moss status                                                                | Acceptance criteria / next deliverable                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts             | [YNAB linked accounts](https://support.ynab.com/en_us/linked-accounts-in-ynab-B1991f2Cc), [Monarch connections](https://help.monarch.com/hc/en-us/articles/360048393352-Guide-to-Connecting-Your-Accounts)                  | Partial: manual/provider accounts, exact balances, provider sharing        | Manual cash/asset/liability accounts without credentials; archive preserves history; explicit currency; no silent FX sum.                                                                                                                                                                                                                                                              |
| Import               | [YNAB file import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo), [Monarch CSV](https://help.monarch.com/hc/en-us/articles/4409682789908-Importing-Transactions-Manually)                             | Supported bounded manual CSV; provider sync remains separate               | Mapping, sign/date preview, duplicate choices and atomic replay proven for 200 manual rows. Provider-account import, larger batches and category mapping remain.                                                                                                                                                                                                                       |
| Reconciliation       | [YNAB reconciliation](https://support.ynab.com/en_us/troubleshooting-reconciliation-issues-rJkijlVki)                                                                                                                       | Supported bounded manual statements; provider/large reviews remain partial | Opening balance + posted ledger matches statement as of date; cleared/reconciled statuses; explicit adjustment preview; pending excluded. Snapshot equality is insufficient.                                                                                                                                                                                                           |
| Duplicates           | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)                                                                                                                             | Supported bounded candidate review; provider ID/pending twin               | Same provider page is idempotent; candidate duplicates never auto-delete; amount, currency, account and date participate.                                                                                                                                                                                                                                                              |
| Categories/rules     | [Monarch rules](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                                   | Partial: taxonomy, exact normalized-payee rules, review, chat edits        | Rule list/edit/disable and preview affected rows; archived categories retain history; no rule overwrites a user allocation.                                                                                                                                                                                                                                                            |
| Splits               | [YNAB splits](https://support.ynab.com/en_us/split-transactions-a-guide-SJLEKwY0q), [Monarch splits](https://help.monarch.com/hc/en-us/articles/360050178492-Splitting-Transactions)                                        | Supported own posted category splits; installed UI proven                  | Allocation cents sum exactly to parent; parent counted once; refunds supported; invalid/stale save changes nothing; sync retains user allocations.                                                                                                                                                                                                                                     |
| Transfers/refunds    | [YNAB transfers](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj), [Monarch transfer math](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments)               | Partial: linked manual pairs, heuristics and signed refunds                | Transfers never pair across currency or owner; opposite legs across month end excluded once; refund restores its category; manual cash/card linking is implemented; existing-record matching, reversal and provider correction remain.                                                                                                                                                 |
| Envelope budget      | [YNAB method](https://www.ynab.com/ynab-method)                                                                                                                                                                             | Partial: reviewed currency, exact math, historical funding, positive carry | All writes validate before commit; no partial batch; cash/credit pending semantics explained; manual history and dated bank snapshots replace today’s balance in historical months; reviewed writes reject stale ledger state; installed concurrent-tab/draft flows proven. Credit-card payment reserves remain separate work.                                                         |
| Flexible budget      | [Monarch flex](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting)                                                                                                                              | Partial: cash-backed flexible pool with fixed/non-monthly groups           | One funded total counts member assignment guidance, activity and carry once. Confirmed current-month transitions preserve past policies; exit allocates exact available money. Optional per-member guidance editing, unrestricted future-funded transitions and separate non-cash-backed forecasting remain missing.                                                                   |
| Rollover             | [YNAB month rollover](https://support.ynab.com/en_us/when-the-month-rolls-over-a-guide-rkyyd6qC9), [Monarch rollover](https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets)                            | Supported: positive envelope carry; partial overall                        | Gaps/year end/refunds tested; explain overspend reset; configurable rollover and starting balance need explicit policy.                                                                                                                                                                                                                                                                |
| Targets/goals        | [YNAB targets](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks), [Monarch goals](https://help.monarch.com/hc/en-us/articles/44373110771860-Goals-in-Monarch)                                                    | Partial: monthly/date-based category targets; broader goals remain         | Exact cent suggestions, historical versions, reached/overdue states and guarded saves. Account-linked goals, investment growth and automatic funding remain missing.                                                                                                                                                                                                                   |
| Recurring/bills      | [Monarch recurring](https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills), [YNAB planning](https://support.ynab.com/en_us/categories/planning-HJgZB2C69)                          | Partial: manual recurring plans and posted matching in Upcoming            | Anchored month-end/leap-year dates; bounded projections; explicit skip/match/undo and stop with history. Actual amounts stay separate. Automatic detection, calendar view, one-off date/amount edits and provider Bill Sync remain missing.                                                                                                                                            |
| Cash flow/reports    | [Monarch reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports), [YNAB income/expense](https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq)                                                | Partial: currency-separated totals and exact contributing rows             | Category/payee and monthly income/outflow details preserve split portions, refunds, pending entries and owner transfer boundaries. Full count/total stays separate from each loaded page; changed records are disclosed. Saved views, arbitrary date/account filters and broader charts remain missing.                                                                                |
| Net worth            | [Monarch manual accounts](https://help.monarch.com/hc/en-us/articles/360048393392-Connect-or-Manually-Add-Accounts)                                                                                                         | Partial: manual ledger reconstruction and dated provider snapshots         | Exact opening balances plus posted manual entries; asset/debt signs, refunds, transfers, pre-window carry and owner-local cutoff; explicit source dates and omissions; accessible point history; per-currency totals. No invented provider history or live/market/FX estimates. Valuation editing, holdings and history import remain missing.                                         |
| Search/bulk          | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                              | Partial: filters/search, atomic bulk categories and captured confirmation  | Account/category/posting filters and honest limits; owner-safe selections; stale/failed writes preserve input. Selected category edits and batches of up to 200 loaded confirmations persist all or none after the host guard. Explicit read retry keeps filters. Bulk notes/clearing, rule management and legacy individual/rule-write concurrency remain missing.                    |
| Household            | [Monarch households](https://help.monarch.com/hc/en-us/articles/20926382202004-Monarch-for-Couples-and-Households)                                                                                                          | Partial: opt-in shared read mirror                                         | Preserve private-by-default Moss semantics; deleted members excluded; shared labels; never broaden write authority for parity.                                                                                                                                                                                                                                                         |
| Export               | [YNAB export](https://support.ynab.com/en_us/how-to-export-plan-data-Sy_CouWA9), [Monarch history downloads](https://help.monarch.com/hc/en-us/articles/15526600975764-Downloading-Transaction-or-Account-History)          | Partial: owned history by date/account, plus loaded filtered CSV           | One SQL snapshot across stored months; inclusive dates; exact parent/split cents, currency and reconciliation state; captured count/scope/time before download. Refuses over 5,000 rows or 2 MiB without truncation; larger histories need smaller ranges. Notes and household mirrors omitted; formula-safe CSV. Balance/budget exports and arbitrary-sized streaming remain missing. |
| Investments          | [Monarch overview](https://help.monarch.com/hc/en-us/articles/360048393272-Getting-Started-with-Monarch), [fund classifications](https://help.monarch.com/hc/en-us/articles/48401988544404-Fund-Classification-Definitions) | Partial: balances in net worth                                             | Holdings/performance require provider coverage, valuation policy and licensed data. Trading, financial advice and paid research integrations are out of scope.                                                                                                                                                                                                                         |
| Long-range forecasts | [Monarch forecasting](https://help.monarch.com/hc/en-us/articles/48344305092244-Forecasting-in-Monarch)                                                                                                                     | Out of scope for initial roadmap                                           | Advanced scenarios need explicit assumptions and uncertainty; must not look like guaranteed outcomes.                                                                                                                                                                                                                                                                                  |

Currency evidence refreshed October 28: [YNAB recommends separate budgets for separate currencies](https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno). [Monarch's currency guide](https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency) explicitly warns that mixed currencies produce misleading totals without conversion. Moss must preserve currency separation rather than reproduce this limitation. Moss now requires reviewed single-currency setup, preserves legacy assignment cents without conversion and discloses missing historical funding. Reviewed budget commits reject stale revisions and fingerprints. Legacy rule-plus-category queues remain separate. SQL category edits now use atomic captured metadata writes; same-ID provider updates preserve current user metadata. Different-ID pending replacement and concurrent provider pages remain convergence gaps.

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

## Narrow capability status and remaining gaps — October 30

The broad product areas above remain partial. These classifications describe bounded capabilities,
not universal parity. Current receipts and the next action are in
[the current checkpoint](../plans/2026-10-30-finance-parity-checkpoint.md).

| Capability                                             | Status                                    | Testable boundary / remaining acceptance                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned history CSV by account/date                      | Supported within limits                   | One SQL snapshot; at most 5,000 rows / 2 MiB, otherwise refuse the file. No notes or household mirrors. Exact parent/split money, scope/count and actual download verified.                                                                                                                                                  |
| Manual ledger net worth                                | Supported within current read limits      | Opening baseline plus posted history, exact debt/refund signs, no provider estimates, currency-separated coverage. Account/month projection retains daily validation and lifetime carry within the unchanged row, 5 MiB byte and execution-time caps; 6,001 daily dates and an unsafe-sized internal exact sum are verified. |
| Captured loaded category confirmation                  | Supported within limits                   | One to 200 own posted unsplit needs-look rows with live categories; host-confirmed atomic persistence, replay/stale rejection and explicit fresh-read recovery.                                                                                                                                                              |
| Manual account rename / close / reopen                 | Supported within manual lifecycle limits  | Preserve all history and immutable money/currency; owner-guarded reviewed metadata changes, zero/reconciled closure, and concurrent-entry protection.                                                                                                                                                                        |
| Explicit linked transfers                              | Partial; bounded manual pairs implemented | Atomic paired manual entries and balances, idempotency, account/date/currency/reconciliation guards; no heuristic pairing with unrelated purchases. Existing inference remains partial.                                                                                                                                      |
| Credit-card payment reserves                           | Missing                                   | Current net-debt funding remains conservative. A reserve/debt-carry mode needs explicit migration, purchase/refund/overpayment/payment math and reconciliation with transfers.                                                                                                                                               |
| Merchant-rule management and awaited individual writes | Partial / missing                         | Owned posted unsplit individual changes to non-transfer categories now use captured confirmed persistence. SQL chat/jobs/Undo update metadata only; same-ID provider sync preserves current user metadata. Canonical rule management, pending/KV/rule UI queues and different-ID pending replacement remain separate gaps.   |
| Investment holdings and performance                    | Missing                                   | Balance-only net worth exists; holdings, valuation provenance, returns and provider/licensed-data coverage need separate work.                                                                                                                                                                                               |
| Trading, paid research purchases and financial advice  | Out of scope                              | No trades, purchases, real credentials or live financial actions are authorized.                                                                                                                                                                                                                                             |
| Provider-dependent aggregation and Bill Sync           | Partial; integration-dependent gaps       | Existing connector paths require actual authorized provider credentials/agreements for live proof. Synthetic tests do not establish live coverage.                                                                                                                                                                           |

The linked manual cash/card slice and its current verification limits are recorded in
[the transfer checkpoint](../plans/2026-10-30-finance-linked-transfers-checkpoint.md). Its additive
ledger, replay/locking guards, captured native review and durable export links are implemented.
Matching existing records, off-budget endpoints, reversal, FX and provider coverage remain separate
acceptance items; neither this slice nor the overall checklist establishes universal parity.

## Reviewed metadata continuation — October 30

[Current metadata checkpoint](../plans/2026-10-30-finance-metadata-checkpoint.md) records the captured
individual-edit workflow, atomic SQL metadata/Undo, same-ID provider preservation and restored negative
controls. Development acceptance passed all seventeen installed browser flows and fourteen SQL cases,
plus 661 focused Finance unit tests. These are bounded capabilities, not general rule-engine,
provider convergence, household co-editing or investment parity. Native startup without a preseeded
migration marker is a separate next acceptance case; current installed-browser fixtures explicitly
assume completed migration.

The subsequent approved-user startup case exercises the real control queue, reconciler and verified
installed migration worker, without a preseeded marker or financial data. It exposed the missing
approval reconciliation hook; the repair passed the complete eighteen-flow installed browser suite
and forty-seven approval/module route regressions. See the metadata checkpoint for the exact dirty
receipts and remaining committed aggregate check. Initial-active sign-up modes are not established
by this administrator-approval case.

## October 30 initialization continuation

Approval and completed/skipped onboarding now request the existing post-commit module job
reconciliation. Focused installed acceptance proves approved and initially active registration
through real migration and first manual budget; final complete-suite and aggregate limits are
recorded in the [initialization checkpoint](../plans/2026-10-30-finance-initialization-checkpoint.md).
Thirty-second package-scoped job coalescing is best effort, not exactly-once delivery or a latency
promise under arbitrary backlog. No bank worker or production integration was exercised.

The next bounded UX slice is
[awaited individual confirmation](2026-10-30-finance-individual-confirmation.md). Until verified,
Needs-a-look individual confirmation and merchant-rule compatibility workflows remain queued;
native confirmed-row category changes and captured loaded-batch tools have their narrower proven
contracts. Canonical rule management, payment reserves and the other missing matrix items remain.
