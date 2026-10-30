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

Statuses updated through the manual card-reserve and write-ordering slices on 2026-10-30. Supported means the bounded
capability is implemented, not full product equivalence. Exact verification and remaining limits
are in the [current checkpoint](../plans/2026-10-30-finance-card-reserves-checkpoint.md). The audit above remains
a dated baseline.

| Area                 | Official comparison evidence                                                                                                                                                                                                                                                                                                                         | Moss status                                                                     | Acceptance criteria / next deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts             | [YNAB linked accounts](https://support.ynab.com/en_us/linked-accounts-in-ynab-B1991f2Cc), [Monarch connections](https://help.monarch.com/hc/en-us/articles/360048393352-Guide-to-Connecting-Your-Accounts)                                                                                                                                           | Partial: manual/provider accounts, exact balances, provider sharing             | Manual cash/asset/liability accounts without credentials; archive preserves history; explicit currency; no silent FX sum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Import               | [YNAB file import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo), [Monarch CSV](https://help.monarch.com/hc/en-us/articles/4409682789908-Importing-Transactions-Manually)                                                                                                                                                      | Supported bounded manual CSV; provider sync remains separate                    | Mapping, sign/date preview, duplicate choices and atomic replay proven for 200 manual rows. Provider-account import, larger batches and category mapping remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Reconciliation       | [YNAB reconciliation](https://support.ynab.com/en_us/troubleshooting-reconciliation-issues-rJkijlVki)                                                                                                                                                                                                                                                | Supported bounded manual statements; provider/large reviews remain partial      | Opening balance + posted ledger matches statement as of date; cleared/reconciled statuses; explicit adjustment preview; pending excluded. Snapshot equality is insufficient.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Duplicates           | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions)                                                                                                                                                                                                                                                      | Partial: candidate review and linked SQL pending settlement                     | Same provider page preserves one posted identity. SQL handoffs retain user category/notes/splits across pending removal/addition pages, retries and 100-page continuation. Changed user-reviewed money needs review. Candidate duplicates never auto-delete; account, currency, amount, date and payee participate. Unlinked matching, duplicate connections and whole-update atomicity remain gaps.                                                                                                                                                                                                                           |
| Categories/rules     | [Monarch rules](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                                                                                                                                                            | Partial: captured canonical rule management and exact normalized-payee matching | Native list/search/create/edit/disable/re-enable and owned monthly preview; atomic SQL configuration/activity/Undo, legacy retention and tombstones. Future uncategorized arrivals only; preview never rewrites history. Multiple criteria, ordered actions, tags, splits and retroactive application remain missing.                                                                                                                                                                                                                                                                                                          |
| Splits               | [YNAB splits](https://support.ynab.com/en_us/split-transactions-a-guide-SJLEKwY0q), [Monarch splits](https://help.monarch.com/hc/en-us/articles/360050178492-Splitting-Transactions)                                                                                                                                                                 | Supported own posted category splits; installed UI proven                       | Allocation cents sum exactly to parent; parent counted once; refunds supported; invalid/stale save changes nothing; sync retains user allocations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Transfers/refunds    | [YNAB transfers](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj), [Monarch transfer math](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments)                                                                                                                                        | Partial: manual pairs/corrections, heuristics and signed refunds                | Transfers never pair across currency or owner; opposite legs across month end excluded once; refund restores its category; manual cash/card linking and audited inverse corrections are implemented, preserving original history and statement boundaries; existing-record matching and provider corrections remain.                                                                                                                                                                                                                                                                                                           |
| Envelope budget      | [YNAB method](https://www.ynab.com/ynab-method)                                                                                                                                                                                                                                                                                                      | Partial: reviewed currency, exact math, historical funding, positive carry      | All writes validate before commit; no partial batch; cash/credit pending semantics explained; manual history and dated bank snapshots replace today’s balance in historical months; reviewed writes reject stale ledger state; installed concurrent-tab/draft flows proven. Manual-card payment reserves are an opt-in variant with separately reviewed cash; provider cards retain full-debt accounting.                                                                                                                                                                                                                      |
| Card payments        | [YNAB card handling](https://support.ynab.com/en_us/handling-credit-cards-overview-ry7cNub1s), [YNAB payment shortfalls](https://support.ynab.com/en_us/when-your-credit-card-payment-category-is-red-a-guide-SJDSr3Q1i), [Monarch transfer treatment](https://help.monarch.com/hc/en-us/articles/28953573066260-Transactions-and-Rules-Tips-Tricks) | Partial: reviewed manual-card cash reserves                                     | Opt in from the current month without rewriting earlier months. Funded category spending moves cash to payment reserves; unfunded credit never creates Ready. Exact split/refund/positive-balance/overpayment math, proportional shared funding and flex pools. Explicit manual payment pairs consume reserves once. Host-confirmed setup/funding, release from closed cards, stale/replay/concurrent-write protection and negative-payment target-funding guard. Later repairs do not block older budgets. Provider reserves, linking existing unpaired imports, disabling enrollment and APR/payoff planning remain missing. |
| Flexible budget      | [Monarch flex](https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting)                                                                                                                                                                                                                                                       | Partial: cash-backed flexible pool with fixed/non-monthly groups                | One funded total counts member assignment guidance, activity and carry once. Confirmed current-month transitions preserve past policies; exit allocates exact available money. Optional per-member guidance editing, unrestricted future-funded transitions and separate non-cash-backed forecasting remain missing.                                                                                                                                                                                                                                                                                                           |
| Rollover             | [YNAB month rollover](https://support.ynab.com/en_us/when-the-month-rolls-over-a-guide-rkyyd6qC9), [Monarch rollover](https://help.monarch.com/hc/en-us/articles/4411119762196-Rollover-Budgets)                                                                                                                                                     | Supported: positive envelope carry; partial overall                             | Gaps/year end/refunds tested; explain overspend reset; configurable rollover and starting balance need explicit policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Targets/goals        | [YNAB targets](https://support.ynab.com/en_us/how-to-use-targets-rk5kkI9ks), [Monarch goals](https://help.monarch.com/hc/en-us/articles/44373110771860-Goals-in-Monarch)                                                                                                                                                                             | Partial: contribution/refill/dated targets with reviewed funding                | Exact cent suggestions, historical versions, reached/overdue states and guarded saves. Reviewed selected current-month funding fits ready money, requires covered category and card-payment overspending and host confirmation. Weekly plans count four/five full-month occurrences with exact cents; spending/carry do not count as new assignments. Monthly refill counts carried money plus assignments, independent of current spending/refunds. Account-linked goals, debt payoff, custom periods and automatic priority/funding remain missing.                                                                          |
| Recurring/bills      | [Monarch recurring](https://help.monarch.com/hc/en-us/articles/4890751141908-Tracking-Recurring-Expenses-and-Bills), [YNAB planning](https://support.ynab.com/en_us/categories/planning-HJgZB2C69)                                                                                                                                                   | Partial: manual recurring plans and posted matching in Upcoming                 | Anchored month-end/leap-year dates; bounded projections; explicit skip/match/undo and stop with history. Actual amounts stay separate. Captured one-off date/amount changes and reset now preserve original cadence and ledger, including month/year moves. Automatic detection, calendar view, whole-series edits and provider Bill Sync remain missing.                                                                                                                                                                                                                                                                      |
| Cash flow/reports    | [Monarch reports](https://help.monarch.com/hc/en-us/articles/21846787088916-Using-Reports), [YNAB income/expense](https://support.ynab.com/en_us/income-v-expense-Byu1BYWRq)                                                                                                                                                                         | Partial: currency-separated totals and exact contributing rows                  | Category/payee and monthly income/outflow details preserve split portions, refunds, pending entries and owner transfer boundaries. Full count/total stays separate from each loaded page; changed records are disclosed. Saved views, arbitrary date/account filters and broader charts remain missing.                                                                                                                                                                                                                                                                                                                        |
| Net worth            | [Monarch manual accounts](https://help.monarch.com/hc/en-us/articles/360048393392-Connect-or-Manually-Add-Accounts)                                                                                                                                                                                                                                  | Partial: manual ledger reconstruction and dated provider snapshots              | Exact opening balances plus posted manual entries; asset/debt signs, refunds, transfers, pre-window carry and owner-local cutoff; explicit source dates and omissions; accessible point history; per-currency totals. No invented provider history or live/market/FX estimates. Valuation editing, holdings and history import remain missing.                                                                                                                                                                                                                                                                                 |
| Search/bulk          | [Monarch editing](https://help.monarch.com/hc/en-us/articles/360048393532-Editing-Transactions), [YNAB categories](https://support.ynab.com/en_us/categorizing-transactions-a-guide-HyRl60sks)                                                                                                                                                       | Partial: filters/search, atomic bulk categories and captured confirmation       | Account/category/posting and owned manual uncleared/cleared/reconciled filters with honest limits; owner-safe selections; stale/failed writes preserve input. Selected category edits and batches of up to 200 loaded confirmations persist all or none after the host guard. Explicit read retry keeps filters. Bulk notes/clearing, multi-condition or retroactive rules and pending/KV/rule-write convergence remain missing.                                                                                                                                                                                               |
| Household            | [Monarch households](https://help.monarch.com/hc/en-us/articles/20926382202004-Monarch-for-Couples-and-Households)                                                                                                                                                                                                                                   | Partial: opt-in shared read mirror                                              | Preserve private-by-default Moss semantics; deleted members excluded; shared labels; never broaden write authority for parity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Export               | [YNAB export](https://support.ynab.com/en_us/how-to-export-plan-data-Sy_CouWA9), [Monarch history downloads](https://help.monarch.com/hc/en-us/articles/15526600975764-Downloading-Transaction-or-Account-History)                                                                                                                                   | Partial: owned history by date/account, plus loaded filtered CSV                | One SQL snapshot across stored months; inclusive dates; exact parent/split cents, currency and reconciliation state; captured count/scope/time before download. Refuses over 5,000 rows or 2 MiB without truncation; larger histories need smaller ranges. Notes and household mirrors omitted; formula-safe CSV. Balance/budget exports and arbitrary-sized streaming remain missing.                                                                                                                                                                                                                                         |
| Investments          | [Monarch overview](https://help.monarch.com/hc/en-us/articles/360048393272-Getting-Started-with-Monarch), [fund classifications](https://help.monarch.com/hc/en-us/articles/48401988544404-Fund-Classification-Definitions)                                                                                                                          | Partial: balances in net worth                                                  | Holdings/performance require provider coverage, valuation policy and licensed data. Trading, financial advice and paid research integrations are out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Long-range forecasts | [Monarch forecasting](https://help.monarch.com/hc/en-us/articles/48344305092244-Forecasting-in-Monarch)                                                                                                                                                                                                                                              | Out of scope for initial roadmap                                                | Advanced scenarios need explicit assumptions and uncertainty; must not look like guaranteed outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Currency evidence refreshed October 28: [YNAB recommends separate budgets for separate currencies](https://support.ynab.com/en_us/using-multiple-currencies-in-ynab-a-guide-SyBF6PHno). [Monarch's currency guide](https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency) explicitly warns that mixed currencies produce misleading totals without conversion. Moss must preserve currency separation rather than reproduce this limitation. Moss now requires reviewed single-currency setup, preserves legacy assignment cents without conversion and discloses missing historical funding. Reviewed budget commits reject stale revisions and fingerprints. Legacy rule-plus-category queues remain separate. SQL category edits now use atomic captured metadata writes; same-ID provider updates preserve current user metadata. Different-ID SQL settlements now retain owned pending metadata through durable handoffs. Legacy KV paging, unlinked duplicates and whole-update atomicity remain gaps.

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
[the card-reserve checkpoint](../plans/2026-10-30-finance-card-reserves-checkpoint.md).

| Capability                                             | Status                                                | Testable boundary / remaining acceptance                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned history CSV by account/date                      | Supported within limits                               | One SQL snapshot; at most 5,000 rows / 2 MiB, otherwise refuse the file. No notes or household mirrors. Exact parent/split money, scope/count and actual download verified.                                                                                                                                                                                                                                                                                 |
| Manual ledger net worth                                | Supported within current read limits                  | Opening baseline plus posted history, exact debt/refund signs, no provider estimates, currency-separated coverage. Account/month projection retains daily validation and lifetime carry within the unchanged row, 5 MiB byte and execution-time caps; 6,001 daily dates and an unsafe-sized internal exact sum are verified.                                                                                                                                |
| Captured loaded category confirmation                  | Supported within limits                               | One to 200 own posted unsplit needs-look rows with live categories; host-confirmed atomic persistence, replay/stale rejection and explicit fresh-read recovery.                                                                                                                                                                                                                                                                                             |
| Manual account rename / close / reopen                 | Supported within manual lifecycle limits              | Preserve all history and immutable money/currency; owner-guarded reviewed metadata changes, zero/reconciled closure, and concurrent-entry protection.                                                                                                                                                                                                                                                                                                       |
| Explicit linked transfers                              | Partial; bounded manual pairs/corrections implemented | Atomic paired manual entries and balances, idempotency, account/date/currency/reconciliation guards; no heuristic pairing with unrelated purchases. Existing inference remains partial.                                                                                                                                                                                                                                                                     |
| Credit-card payment reserves                           | Partial; opt-in manual-card reserves implemented      | Reviewed current-month enrollment and funding, exact purchase/refund/overpayment/payment math, positive carry, stale/concurrent protection and original-history preservation. Provider cards, matching existing unpaired imports and disabling enrollment remain gaps.                                                                                                                                                                                      |
| Merchant-rule management and awaited individual writes | Partial; canonical rules implemented                  | Owned posted unsplit individual changes to non-transfer categories now use captured confirmed persistence. SQL chat/jobs/Undo update metadata only; same-ID provider sync preserves current user metadata. Canonical rules now support preview, captured host-confirmed management, future categorization and atomic backend Undo. Multi-condition/ordered/retroactive rules, pending/KV/rule UI queues and unlinked pending/provider matching remain gaps. |
| Investment holdings and performance                    | Missing                                               | Balance-only net worth exists; holdings, valuation provenance, returns and provider/licensed-data coverage need separate work.                                                                                                                                                                                                                                                                                                                              |
| Trading, paid research purchases and financial advice  | Out of scope                                          | No trades, purchases, real credentials or live financial actions are authorized.                                                                                                                                                                                                                                                                                                                                                                            |
| Provider-dependent aggregation and Bill Sync           | Partial; integration-dependent gaps                   | Existing connector paths require actual authorized provider credentials/agreements for live proof. Synthetic tests do not establish live coverage.                                                                                                                                                                                                                                                                                                          |

The linked manual cash/card slice and its current verification limits are recorded in
[the transfer checkpoint](../plans/2026-10-30-finance-linked-transfers-checkpoint.md). Its additive
ledger, replay/locking guards, captured native review and durable export links are implemented.
Matching existing records, off-budget endpoints, FX and provider corrections remain separate
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

[Awaited individual confirmation](2026-10-30-finance-individual-confirmation.md) now covers owned
posted unsplit non-transfer SQL rows without merchant-rule creation. Actual installed cancellation,
confirmation/reload, deliberate category change and competing financial-edit rejection passed;
[the checkpoint](../plans/2026-10-30-finance-individual-confirmation-checkpoint.md) records narrower
acceptance and pending combined checks. Pending/KV/merchant-rule compatibility remains queued.
Canonical rule management, payment reserves and the other missing matrix items remain.

## October 30 merchant-rule continuation

Canonical rule storage and native management now have bounded SQL and installed UI acceptance.
See the [merchant-rules checkpoint](../plans/2026-10-30-finance-merchant-rules-checkpoint.md) for
exact commits/inputs, negative controls, preview and history-preservation evidence, responsive
screenshots, the complete twenty-flow browser pass and aggregate limits. The broader categories/rules
comparison remains partial. Native rule updates always ask; legacy rule-plus-category jobs and
queued Undo retain their separate workflow boundaries. No real provider integration was exercised.

## October 30 one-off bill continuation

[One-off bill checkpoint](../plans/2026-10-30-finance-bill-adjustments-checkpoint.md)
records additive owned SQL, exact cents and original recurrence membership, month/year
moves, active-account and review guards, stop/close dependencies, stable matching
identity, globally claimed transactions and the captured native confirmation workflow.
Real installed browser cancellation/save, reload, two-tab stale refusal, explicit
read recovery and reset passed with synthetic data. Recurring bills remain partial:
no automatic detection, calendar presentation, whole-series edits, automatic ledger
posting, Bill Sync or payments are implied.

## October 30 selected target funding

[Target funding checkpoint](../plans/2026-10-30-finance-target-funding-checkpoint.md)
records explicit one-to-twenty current-month suggestions, reviewed assignments and ready
money before/after, mandatory host confirmation, atomic existing-ledger/activity writes,
concurrent/stale refusal and financial limits. Current category overspending must be
covered first. Dated guidance recalculates with balances; no stored monthly installment
or automatic funding is implied. Full installed synthetic acceptance passed twenty-one
flows, and the restored SQL regression passed twenty-two cases. Broader goals remain
partial; clean committed aggregate verification follows preservation.

## October 30 legacy target repair

[Repair checkpoint](../plans/2026-10-30-finance-target-repair-checkpoint.md) records named,
read-only reviews with metadata removal for old archived/pooled targets. Earlier target history
and financial records remain unchanged. New pooled target creation/funding stays rejected; the
synthetic flexible pool is excluded defensively. The installed removal fixture is explicitly
legacy, not a valid new mode transition. Finance units passed 711 tests and SQL passed 22 cases;
focused installed acceptance passed three cases. Full installed regression passed 20 / failed
one unrelated workflow's competing-page selection wait; diagnosis remains open. Clean committed
selected-funding checks passed 21 browser flows / 22 SQL cases. Its aggregate passed all static
checks and retained exactly the existing 277 unit-failure identities; later stages were unrun.
Broader goals remain partial. Next slices are assistant read freshness with preserved typed
budget review and audited linked-transfer corrections.

## October 30 assistant refresh and typed review

[Refresh checkpoint](../plans/2026-10-30-finance-assistant-refresh-checkpoint.md) records consumption
of the existing host refresh key, retained typed budget review identity, explicit rechecking after
changed/rejected/uncertain saves, failed/busy read recovery and local discard. Finance units passed
717 tests, full types and relevant static checks passed. Native stale-save recovery and responsive
bounds passed within a 20/21 development browser result; a target-funding read-recovery fixture
was then corrected and awaits clean full acceptance. The host-prop contract uses labeled unit
mocks; an actual configured-provider conversation was not exercised. Household co-editing and
universal cross-tab/native refresh remain missing. Broader transfer corrections remain next.

## October 30 audited manual transfer corrections

[Correction checkpoint](../plans/2026-10-30-finance-transfer-corrections-checkpoint.md) records one
reviewed inverse pair for an owned manual cash/card transfer, with exact server-derived source
facts, same-operation replay, captured original/account versions, valid posting dates, atomic
balances/links/activity, and preserved original/reconciled history. A correction may itself be
corrected once through the same append-only model. Native host cancel/confirm, reload/history,
owned export identifiers, report exclusion and compact responsive review passed. Disposable
negative controls observed duplicate prevention, row ownership and required host confirmation
fail when their protections were deliberately absent; production protections stayed intact.

The final development source passed 732 Finance unit tests, 150 complete Finance backend tests
and all 21 installed browser flows, plus repository lint/types/format/size/UI checks. Clean committed
aggregate verification follows preservation. This supersedes earlier development reporting and
category-confirmation waits; it does not imply CI or configured-provider conversation proof.
Transfer matching/provider corrections, FX, loan/investment endpoints, payment reserves and
household co-editing remain gaps. Broader goals, recurring series/calendar work, provider convergence
and reporting remain staged. Weekly contribution behavior is the next design/implementation slice.

### 2026-10-30 weekly contribution targets

Implemented an explicit weekday/per-week category target with exact full-month occurrence totals,
versioned storage and current-month selected funding through the existing mandatory host decision.
Creation mid-month deliberately plans the full calendar month; it is not prorated or automatically
funded. Monthly/balance targets and existing envelope/statement/card policy remain unchanged.
[Official YNAB target types](https://support.ynab.com/en_us/getting-started-with-targets-ryAEP08xC)
describes weekly occurrence differences; this bounded behavior does not claim every YNAB mode.
See the [design](2026-10-30-finance-weekly-contribution-targets.md) and
[checkpoint](../plans/2026-10-30-finance-weekly-target-checkpoint.md) for exact receipts, native
proof and remaining target gaps. Broader goals remain Partial.

### 2026-10-30 monthly refill targets

Monthly refill is an explicit new choice; existing monthly contribution definitions retain their
meaning. Carry plus net assignments counts toward this calendar-month plan; spending and refunds
do not reopen it. Refunds affect ordinary available money and next month's carry. Future guidance
is provisional. Saving creates no assignment. Selected current-month funding reuses mandatory
host confirmation and exact ledger checks. Eligible suggestions appear first on compact screens.
The [refill design](2026-10-30-finance-monthly-refill-targets.md) links official comparison evidence;
the [checkpoint](../plans/2026-10-30-finance-refill-target-checkpoint.md) records installed SQL/native
acceptance and remaining limits. Broader goals remain Partial, including custom periods and
account-linked/debt planning; this does not claim every YNAB refill/refund behavior matches.

### 2026-10-30 durable pending handoffs and report recovery

SQL sync atomically captures an owned pending source before removal, retaining its exact private
user metadata through paged settlement and interrupted writes. Explicit IDs require the same
account and an actual provider-pending source; existing posted user choices take precedence.
Changed money/currency reopens review, with split allocations retained for repair. Native labels
distinguish user-set categories needing review from predictions. Completed durable updates clear
the private handoff, while partial updates preserve it. See [design](2026-10-30-finance-pending-handoffs.md)
and [checkpoint](../plans/2026-10-30-finance-pending-handoff-checkpoint.md).

[Official provider state documentation](https://plaid.com/docs/transactions/transactions-data/)
supports the separate-page/identity boundary. Tests use synthetic provider and credential ports,
real committed SQL and real native reads/host category confirmation; actual bank acceptance is
unrun. Legacy KV paging, unlinked duplicates, whole-update atomicity and broader provider behavior
remain Partial. The full browser pass also exposed a report error-state gap: HTTP 429 hid the
server wait. Details now keep selection, expose the wait and pause reload/paging for explicit
recovery; server policy and financial writes are unchanged. That slice's complete receipts are
recorded in the register checkpoint.

## October 30 manual ledger filter continuation

The [manual ledger filter spec](2026-10-30-finance-ledger-status-filters.md) adds a
separate manual statement-state selector. It intersects existing filters before counts/limits;
provider/pending/shared rows have no manual statement meaning. Cleared excludes reconciled
rows. This is a bounded register improvement, not general query-language parity or provider
reconciliation. Final installed acceptance passed the actual cleared-to-reconciled transition;
see the register checkpoint for complete clean receipts and aggregate limitations.

## October 30 readable transaction details continuation

The [captured details spec](2026-10-30-finance-transaction-details.md) adds an accessible
payee dialog for exact money, account/date/status, category/splits and full owned notes.
Household details omit private notes, including a malformed projection in the UI guard
test; removing that guard was observed failing, then restored. The dialog has no write
controls or extra network calls. Notes editing, tags, attachments and general merchant/date
edits remain gaps. Acceptance and the final restored filter run are tracked in the
[register checkpoint](../plans/2026-10-30-finance-register-details-checkpoint.md).

## Earlier October 30 register verification

[Register checkpoint](../plans/2026-10-30-finance-register-details-checkpoint.md):
801 Finance units plus three browser-source-graph checks passed. Serialized installed
and backend Finance acceptance passed all 190 in 17 files, including every one of the
21 native flows. Fixture-only privacy negative controls were observed failing, restored
and followed by passing positive SQL/native checks. The broad aggregate passed static
checks and failed exactly the 277 earlier environment-baseline identities with no additions
or removals; it is not a green full repository gate. CI e2e and actual bank/provider HTTP
acceptance remain unrun. [Original inspected screenshots](../evidence/finance-parity-2026-10-30/README.md)
are committed. Supported/partial/missing/out-of-scope classifications above stay bounded;
test count does not establish universal parity. No merge, deployment or PR publication.

## October 30 card-payment reserve continuation

The [card-payment reserve design](2026-10-30-finance-card-payment-reserves.md) defines Moss's
exact cash conservation rules and comparison bounds. Existing accounts retain full-debt
accounting until explicit current-month enrollment. Payment reserves track cash rather than
claim that all debt is funded. Cancellation preserves the review; uncertain/stale saves block
retries pending a saved-state check. Closed cards retain visible reserves for release.

Common module SQL now orders mutations and locking reads before row locks, while ordinary
reads remain independent. Full acceptance initially exposed 13 task-related lock regressions;
these were diagnosed and fixed, not treated as baseline failures. The restored backend batch
passed 194 tests, and the clean focused card/module batch passed 26. Full Finance acceptance
at clean production commit 9c0735e1 passed all 203 tests, including all 22 native flows. An
additional payment round trip through Accounts also passed at da66aeb8; the payment does not
count as spending or change Ready. The repository aggregate passed all static checks but
failed its unit stage: the same 277 earlier individual test failure identities, plus four
missing-browser setup errors across three files. All 13 affected browser cases subsequently
passed with the installed Chromium path; the full aggregate was not rerun after that environment
correction, and its later chained stages remain unrun. Receipts, screenshots and exact tested
commits are maintained in the
[card-reserve checkpoint](../plans/2026-10-30-finance-card-reserves-checkpoint.md). These bounds
do not establish universal YNAB or Monarch parity.

## October 30 bounded bill-match date continuity

Continuation of the existing recurring-obligation work (#1148): a bill due on the first or last
of a month must be matchable to an existing posted expense across that month boundary. Extend
only the read candidate window by seven calendar days at each end, clamped to years 0001–9999.
Keep the occurrence projection window unchanged. Use UTC calendar arithmetic, including leap
days and DST periods. Include the boundary transaction partitions even when the month index
has not listed them yet. Retain the existing 1,000-candidate bound and the existing positive,
posted, currency, category and claimed-transaction filters. The native match review states the
candidate dates explicitly; it never selects or saves a candidate automatically. Existing
account matching, captured-review and host-confirmation write contracts remain in force.

Acceptance: unit cases prove year/leap/day-range boundaries and rejection of invalid windows;
handler cases exercise actual adjacent-month candidate reads, excluded pending/refund/other-
currency/outside-window rows and claimed matches. Installed UI acceptance must show the date
range and match a synthetic prior-month posted expense through the existing confirmation route.
No transaction creation or bank instruction is added by this slice. The separate reviewed
“Record bill entry” implementation remains the next larger action.
