# Finance parity implementation checkpoint

Date: 2026-10-28. Branch: `task/finance-parity-20261028`. Base:
`e41aa10f551f9a13a1c2f8b53d356b7186245e4f`. Work remains local and unpublished.
Implementation commits: `f989ba06`, `a419911d`, `09205a7c` and `a688b4d6`; a further
CSV precision fix is included in this checkpoint. Receipts below identify their exact inputs.
Use the isolated Finance worktree, not the original checkout. Repository paths below are
relative to `~/Jarv1s`. No bank was connected, no credentials created, and no production
data, deployment, account settings or financial transactions were changed.

The [audit, official sources and acceptance matrix](../specs/2026-10-28-finance-parity.md)
remain the scope contract. Historical PRs #3269 and #3349 are merged. This checkpoint
implements five Finance slices. The authorized continuation now includes the required platform
write route and host bridge. It does not establish YNAB/Monarch parity or live acceptance.

## Implemented slices

1. **Ledger boundaries.** Decimal-to-hundredths conversion rounds symmetrically before
   storage. Non-finite/unsafe money and impossible dates/months are rejected. Transfer
   inference requires equal currency and excludes allocated purchases. Provider updates
   retain user-confirmed review state. Budget batches validate every category/amount/duplicate ID before
   one commit; legacy KV commits the month as one value.
2. **Transaction workspace.** Account, category, posting status, direction and review
   filters; own-note search; conservative duplicate candidates with no automatic deletion;
   loaded/total counts and an explicit 2,000-row cap. CSV exports only loaded filtered rows,
   separate inflow/outflow columns, currency/status/scope, and split allocations. Spreadsheet
   formula characters in text cells are neutralized. Shared notes remain outside the explicit
   projection and export.
3. **Category splits.** Additive module migration `0019`, allocation revision, metadata-only
   queue, compare-and-set SQL update with activity in the same statement, and a responsive
   editor. Up to 20 signed allocations must equal the bank amount exactly. One allocation
   returns to a single category. Pending/shared rows cannot be edited here; legacy KV requires
   storage migration. Queue admission is followed by reads and is not reported as a saved
   result. Amount, currency and revision conflicts/timeouts retain entered values. Sync preserves allocations; an altered
   bank total is marked for review and counted once as uncategorized until repaired. Budgets,
   drafts and spending reports use allocations without counting the parent twice.
4. **Currency-separated reports.** Reports is now in the main navigation. Spending, cash flow
   and snapshot net worth accept an explicit currency; a single currency selects itself and
   multiple currencies require a choice before totals are returned. Each household owner's
   transfers are excluded before merging same-currency contributions. Report and net-worth
   sums reject safe-integer overflow. Merchant names such as `__proto__` remain ordinary data.
   Responsive category/payee bars and mobile cash-flow rows retain labels and exact values.
   Copy states the pending/refund/transfer policy, snapshot carry-forward and missing account
   limitations. No exchange-rate conversion is applied. Budget still needs the separate currency policy
   described below.
5. **Currency-safe Accounts and exact display/export.** Each account row retains its currency;
   asset-minus-debt totals are separate for each currency. Totals accumulate as exact integers,
   and an out-of-range result shows Unavailable while preserving individual rows. Currency
   formatting passes an exact decimal string to Intl; form inputs and CSV generate decimal
   text without float division. Safe integer amounts near the upper limit retain every cent.
   The implementation follows the [Intl decimal-string contract](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/format).

The UI uses current Park Press/Park Pass foundations: Archivo, shipped semantic tokens and
SDK primitives, warm paper surfaces, labeled controls and tabular amounts. Module CSS adds
layout only. The manifest version is `0.7.0`; the app map describes the bounded features and
their limitations. External-module app-map schema supports descriptions, not separate error
or remediation arrays; prerequisite/conflict behavior is described in those entries.

## Verification and evidence

Current capability status supplements the source-linked baseline matrix; every UI below still
requires installed live acceptance before release.

| Area                        | Current checkpoint                                                    | Remaining acceptance                                                          |
| --------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Accounts                    | Partial: provider accounts, own currency labels and separated totals  | Manual accounts, archive, opening balance and reconciled ledger               |
| Import/reconciliation       | Missing manual/file import and statement reconciliation               | Atomic preview/apply, replay identity, cleared/reconciled state               |
| Transaction workspace       | Supported bounded filters, candidate duplicate review, loaded-row CSV | Full-history export, atomic bulk edits and explicit transfer links            |
| Splits                      | Supported for posted own SQL rows, confirmed persistence              | Split transfers, line notes/payees, installed live proof                      |
| Categories/rules            | Partial existing categorization and merchant rules                    | Rule management/preview and stronger ordinary-edit concurrency                |
| Envelope budget/rollover    | Partial existing envelopes; assignment batches now atomic             | Currency migration, historical cash, credit-card reserves, configurable carry |
| Flexible budget             | Missing                                                               | Fixed/non-monthly/flex model without double counting                          |
| Targets/goals               | Missing                                                               | Monthly and date-bound funding, exact remaining amounts                       |
| Recurring bills             | Missing                                                               | Cadence, occurrence edits and one-time import matching                        |
| Cash flow/reports/net worth | Partial: currency-safe reports and snapshots                          | Drill-through, custom filters, manual assets and saved views                  |
| Household                   | Partial existing opt-in shared reads                                  | Explicit co-edit policy; preserve private notes and owner boundaries          |
| Investments                 | Partial balances only                                                 | Provider-dependent holdings/performance; trading out of scope                 |
| Long-range forecasts        | Out of scope for initial roadmap                                      | Separate assumptions and uncertainty design                                   |
| Platform page writes        | Foundation only; route/bridge authorized but not implemented yet      | #3723/#3724 security tests and actual installed-module proof                  |

There is no new backend-only manual-ledger capability hidden behind a mocked form. All five
implemented Finance slices include their real handlers/model or view logic and synthetic UI
coverage; manual entry remains missing until the platform and ledger slices are assembled.

- Finance unit tests: **47 files / 476 tests passed**, using exact `tests/unit/*finance*.test.*`
  paths plus the typography/empty-state and Park Press integration audits. Initial ledger,
  currency-conflict, mixed-currency report and account/precision regressions were observed
  failing before fixes. The additional CSV edge regression failed before its fix and passed
  with the format/register suite afterward; the final whole-Finance rerun is recorded later.
- Isolated Finance integration gate: **3 files / 11 tests passed**. It installs the module
  migrations, exercises storage migration and owner-scoped RPC, races two split editors,
  rejects stale/foreign-owner writes, verifies one activity event, and preserves allocations
  during a stale provider upsert. A persisted USD/EUR fixture verifies that reports return no
  mixed headline and that selected EUR results contain only EUR balances and spending.
  Receipt: `moss_finance-20261028-064741.log`, rc 0, clean product commit `a688b4d6`, input
  fingerprint `e2a693c85889`, Node 24.19.0 / pnpm 10.6.2.
- Repository static checks: lint, Prettier, file-size, design tokens, UI classes, migrated
  sections, UI catalogue, ambient-date/password/package/migration checks, root/test/web/module
  TypeScript and app-map build passed at `09205a7c`. The final Finance static rerun is
  pending in this intermediate checkpoint; no final-commit full-gate pass is claimed.
- Actual production-built Finance browser fixture: **28 scenarios passed** at 320, 390, 768
  and 1440 pixels, light/dark; filters, exact split total, no horizontal overflow, Escape/focus
  restoration, empty/loading/error views and no page exceptions. Reports requires a currency
  choice and switching EUR/USD produces the correct separated values. Final register, split
  Reports and Accounts screenshots were inspected in light/dark themes. The browser also
  verifies separate account totals, debt signs, exact large-value cents and the unavailable-total
  state. The first overflow-fixture attempt lost its query mode during navigation; fixing the
  fixture host to retain its initial mode made that case pass.
  All financial records are synthetic. This is not an installed live end-to-end acceptance run.
- Initial integration attempts failed because a fresh checkout lacked the generated app map,
  then because the queue expectation omitted the new split queue. Both were fixed and the
  isolated gate reran successfully. A broad unit filename filter inadvertently matched
  integration files; the database guard blocked that path (and connections were refused).
  The exact unit-path rerun passed. Do not use the broad `finance` substring as a unit selector.

Full foundation receipt: `moss_finance-20261028-062710.log`, clean product commit `09205a7c`,
input fingerprint `353683ec32d5`, **rc 1**. Static checks passed. The unit phase reported
**1,590 files / 19,272 tests passed**, **24 files / 279 tests failed**, and 16 skipped. The gate
completed and removed its container. All failures were outside Finance. Post-unit migration,
UAT-seed and full integration phases did not run. A later run at `a688b4d6`
(`moss_finance-20261028-064739.log`) was deliberately stopped during static checks, **rc 143**,
to include the newly found CSV precision fix; its container was removed. It is not a pass. The
platform continuation must rerun the final aggregate gate after its own edits.

The earlier foundation run (`moss_finance-20261028-055443.log`, rc 1) exposed two relevant
stale search-label and Finance-version expectations in typography/Park Press tests. Both
were corrected and are included in the final focused suite. Other reported failures involved
Computer ancestor ownership/IPC, missing `getfacl`/`setfacl` and an absent Playwright bundled
browser. A focused diagnostic reproduced `Unsafe Computer ancestor`: this sandbox's filesystem
ancestors have UID 65534 rather than an accepted root/current-user owner. No security checks
or unrelated Computer code were changed. These environmental failures reproduce in unchanged
code; a separate full baseline gate was not run. CI, repository e2e and installed live-UI
acceptance have not run. No PR or live-proof claim is made.

Reproduce without contacting real providers:

```bash
# Use the repository-pinned pnpm 10.6.2, not a globally newer pnpm.
pnpm install --offline --frozen-lockfile
pnpm verify:static
# Expand only existing unit paths in Bash; never use a broad substring filter.
pnpm test:unit tests/unit/*finance*.test.ts tests/unit/*finance*.test.tsx tests/unit/typography-external-audit.test.tsx tests/unit/park-press-integration.design.test.ts
scripts/run-gate.sh start --gate test:integration:finance-parity
scripts/run-gate.sh wait --follow
scripts/run-gate.sh start
scripts/run-gate.sh wait --follow
# Optional screenshot directory must be outside the worktree.
MOSS_VISUAL_ARTIFACT_DIR=/tmp/moss-finance-visual pnpm exec tsx scripts/finance-ui-check.ts
```

The browser script needs Chromium (`CHROMIUM_PATH` can override its executable). It builds
the actual Finance bundle, hosts it locally with synthetic tool responses, and shuts down its
browser/server. Screenshot files include `register-1440-light.png`, `register-320-dark.png`,
`split-390-light.png`, `split-1440-dark.png`, `reports-390-light.png`,
`reports-1440-dark.png`, `accounts-390-light.png`, `accounts-1440-dark.png`,
`accounts-overflow.png`, the three state images and `inspection.json`.
Gate databases use throwaway containers and the script removes them at completion.

## Remaining scope and next action

The next implementation starts with **the authorized platform write route and host bridge**,
then a manual ledger. Current main and open PRs were rechecked before entering platform scope.

1. Accounts and Reports now separate currencies. Budget assignments have no currency dimension
   in SQL or KV. Define a budget currency and migration policy before filtering its transactions;
   otherwise a filter would relabel old assignments. Historical ready-to-assign still uses
   current balances. These existing gaps are not completed by the Reports/Accounts fixes.
2. Add a source distinction for manual accounts and transactions without weakening owner RLS.
   Define opening balance, asset/liability sign, posted versus cleared/reconciled, account
   archival, immutable import identity and audit behavior before deriving a ledger balance.
   Preserve existing provider IDs, balance snapshots and KV backfill. Allocate the next
   migration after checking current main and open PRs again. `sql/0002` currently requires
   `item_id`; manual accounts must not be shown as broken Plaid connections or assigned invented
   provider IDs. Update domain records, SQL/KV store contracts, handler/app-map schemas and
   Accounts grouping together. Specify account currency as immutable after ledger entries exist.
3. Build CSV preview/mapping and a validated atomic import batch over that ledger. Parse dates
   without timezone shifts, show sign/currency explicitly, identify exact re-imports, and let
   the user review possible duplicates. Synthetic data only; no bank or provider setup needed.
4. Reconcile against an explicit statement amount/as-of date using cleared posted entries;
   adjustment preview must show its ledger impact. Do not rename snapshot equality as
   reconciliation. Then proceed to targets/goals, recurring obligations and flexible budgets.

### Concrete platform prerequisite for manual-entry/import UI

[PR #3733](https://github.com/motioneso/moss/pull/3733) merged October 25, but only added the
dormant module-page confirmation foundation. The guarded synchronous route
[#3723](https://github.com/motioneso/moss/issues/3723) and host UI bridge
[#3724](https://github.com/motioneso/moss/issues/3724) are still open under
[#1699](https://github.com/motioneso/moss/issues/1699). No open PR for #3723 was found at this
checkpoint. Check ownership and current status before extending these shared platform files.

`packages/ai/src/routes.ts` still rejects every non-read call on
`/api/ai/assistant-tools/:name/invoke`; creating a pending action there never executes the
write. `packages/ai/src/module-page-confirmations.ts` has no production caller yet. The
intended module-scoped route and host contract are documented in
`docs/superpowers/specs/2026-10-25-module-page-write-tools-design.md`. Its old approval heading
does not undo the approved decisions recorded on PR #3733. This is an unfinished implementation
prerequisite, not a request for user permission. Ben explicitly authorized including the
necessary platform changes on October 28; work will continue on this isolated branch using
the existing approved design. No route or host bridge is implemented by this checkpoint.

Fresh GitHub inspection confirmed both #3723 and #3724 are open, unassigned issues, not PRs;
open-PR searches for each issue and the route title found no implementation PR. The intended
SDK boundary is an optional `ExternalModuleToolsHandleV1` prop with
`invoke(name, input): Promise<ModuleToolOutcome>`. Outcomes are `succeeded` with a result,
`cancelled`, `rejected` with an optional vetted `moduleCode`, `invalid_input`, or `failed`.
The host binds the module ID, owns the confirmation dialog and preserves the same validated
input for confirmation. Missing older-host support must fail closed. The route must enforce
actor/module ownership, trusted Origin, rate limiting and single-use input-bound confirmation;
outbound/destructive calls always confirm and executed writes record activity. Do not retry
an ambiguous transport failure automatically.

First verify/complete that route and bridge with the relevant owner, including owner scope,
single-use confirmation, atomic result and errors that retain form input. Then add the manual
ledger vertical slice. Account names, transaction payees/notes and CSV contents must not enter
metadata-only queue payloads. The current queue route only acknowledges enqueueing with HTTP
202 and supplies no synchronous result. Chat attachment storage is not a substitute public
module contract; its public attachment API work (#1695) is still open. Do not fabricate success
or bypass the intended host confirmation path to make the form appear complete.

Manual-ledger acceptance should cover opening balance/date/currency, positive asset versus
liability sign, spend/refund/transfer effects, account archive preserving history, owner RLS,
full validation before an atomic import, stable re-import identity, no duplicate batch on
retry, statement date boundaries and explicit reconciliation adjustments. Keep provider
snapshots separate from balances calculated from manual entries. Every value stays synthetic
during development; none of this requires connecting a real bank.

Still partial/missing: explicit transfer linking and split transfers; credit-card payment
reserves; editable rules management; atomic bulk transaction edits; full-history export;
saved report views/drill-through; manual net-worth assets; goal funding; recurring matching;
household co-editing policy. Existing review/category writes still use their older queue
acknowledgment behavior; only the new split editor waits for a persisted result.

Current split limitations: no line notes/payees, only non-transfer categories, no pending
splits, maximum 20 parts, each part bounded to one million currency units. A split cannot
move bank money. Sharing updates retain the existing household-mirror refresh behavior.
Allocation revisions protect split edits; ordinary category edits retain their existing
sync/concurrency semantics. The current storage model uses hundredths for all supported money fields; general ISO
minor-unit currencies and FX accounting require an explicit migration/policy.

Live bank import, holdings/performance and investment coverage require separately authorized
provider configuration, agreements and credentials. No such integration was fabricated.
The repository's installed live-UI gate remains outstanding; fixture screenshots cannot
satisfy it. Publishing an issue/PR, pushing, deploying or merging still requires authorization.

Suggested release note for an eventual authorized PR: **Added — A clearer transaction
workspace and currency-separated reports.** Filter and export your loaded transactions,
review possible duplicates, divide posted purchases between categories with exact totals and
confirmed saves, and view spending, cash flow and net worth in a chosen currency.
