# Finance parity checkpoint

Updated 2026-10-28, 07:56 UTC. Local branch `task/finance-parity-20261028`, under `~/Jarv1s`.
The original checkout is separate. Nothing has been pushed, published, merged or deployed.
The [source-linked parity matrix](../specs/2026-10-28-finance-parity.md) records the audited
baseline and testable acceptance criteria; this document records current implementation.

## Implemented slices

1. **Ledger safety.** Decimal-to-hundredths conversion rounds symmetrically before storage;
   unsafe money and impossible calendar dates/months are rejected. Transfer inference requires
   equal currency and excludes allocated purchases. Provider updates preserve reviewed state.
   Budget batches validate every category, amount and duplicate ID before one SQL/KV commit.
2. **Transaction workspace.** Account/category/posting/direction/review filters, own-note search,
   conservative duplicate candidates, loaded/total counts and an explicit 2,000-row cap. CSV is
   limited to loaded filtered rows, with exact decimal cents, separate inflow/outflow, currency,
   status and split allocations. Text formula characters are neutralized; shared notes excluded.
3. **Category splits.** Additive migration 0019, 1–20 signed allocations with exact parent total,
   compare-and-set on amount/currency/revision/account/month/posting state, atomic activity, replay
   handling and responsive editor. The page now invokes the guarded synchronous tool and waits
   for committed success; it no longer polls after queue admission. Legacy queued jobs remain
   supported. Pending/shared rows and legacy KV cannot be edited here. Conflicts preserve input.
   Budgets/reports expand allocations without double counting. Changed provider totals retain
   allocations for repair and count once as uncategorized until repaired.
4. **Currency-separated Reports.** Reports is a primary tab. Spending, cash flow and snapshot
   net worth require currency selection when mixed; single currency selects itself. Household
   contributions preserve owner transfer boundaries. Exact sums reject overflow. Copy explains
   pending/refund/transfer policy and snapshot gaps; no FX conversion is applied.
5. **Currency-safe Accounts and exact display/export.** Rows retain their currency; totals are
   assets minus debts per currency. Bigint aggregation reports Unavailable on unsafe totals while
   retaining rows. Intl receives exact decimal strings; inputs/CSV avoid floating division.
6. **Page write platform and first real consumer.** Guarded external-only invoke route, optional
   SDK handle and actual host shell dialog. Trusted Origin, active actor/module ownership,
   validation, forced actor, input-bound expiring single-use confirmation and metadata activity.
   Outbound/destructive always confirm. Input is snapshotted; ambiguous transport is not retried.
   Old hosts fail explicitly. Cancellation, unmount and actor changes abandon pending UI. The
   Finance split tool uses this path. Activity details now label page writes as Module page.

Current Park Press/Park Pass foundations supply Archivo, semantic colors, shared controls and
modal behavior, warm paper, tabular amounts and responsive layouts. Module styles add layout.
The Finance manifest is 0.7.0; app-map entries describe the bounded capability and remediations.

## Current capability matrix

| Area                        | Status now                                                                | Remaining acceptance                                                                      |
| --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Accounts                    | Partial: provider rows, per-currency totals and exact display             | Manual accounts/entries, opening balances, archive and reconciled ledger                  |
| Import/reconciliation       | Missing manual/file import and statement reconciliation                   | Atomic preview/apply, stable replay identity, cleared/reconciled records                  |
| Transaction workspace       | Supported bounded filtering, duplicate candidates and loaded-row CSV      | Full-history export, atomic bulk editing, explicit transfer linking                       |
| Splits                      | Supported posted own SQL category splits; installed UI persistence proven | Split transfers, line notes/payees and pending edits                                      |
| Categories/rules            | Partial existing categorization and merchant rules                        | Management/preview and ordinary-write concurrency                                         |
| Envelope budget/rollover    | Partial existing envelopes; validated atomic assignment batches           | Currency/history policy, credit-card reserves, configurable carry                         |
| Flexible budget             | Missing                                                                   | Fixed/non-monthly/flex model without double counting                                      |
| Targets/goals               | Missing                                                                   | Monthly/date-bound targets, exact remaining funds                                         |
| Recurring bills             | Missing                                                                   | Cadence, occurrences and one-time import matching                                         |
| Cash flow/reports/net worth | Partial: currency-safe spending/cash flow/snapshots                       | Ledger valuations, drill-through, saved/custom views                                      |
| Household                   | Partial existing opt-in shared reads                                      | Explicit co-edit and joint-account policy; preserve private notes                         |
| Investments                 | Partial balances only                                                     | Provider-dependent holdings/performance; trading out of scope                             |
| Long-range forecasts        | Out of scope for initial roadmap                                          | Separate assumptions/uncertainty design                                                   |
| Platform page writes        | Implemented; actual installed Finance and synthetic-module proof passed   | Independent review, CI and release/deployment acceptance; Meals consumer remains separate |

No manual-ledger capability is hidden behind a mocked form. Its
[committed design](../specs/2026-10-28-finance-manual-ledger.md) is the next implementation slice.

## Current verification

Node 24.19.0, pinned pnpm 10.6.2, throwaway PostgreSQL 17.11 and system Chromium. Every DB run
used `scripts/run-gate.sh` and removed its container. Records and accounts are synthetic.

- **51 unit files / 510 tests passed**, all Finance suites plus host controller, canonical input,
  route-catalog, activity label and typography/design integration checks. Latest log:
  `moss-finance-platform-assembled-unit.log`. Root/web/external-module TypeScript and aggregate
  static checks passed in `moss-finance-host-static-green.log` before the final test/copy edits;
  the final checkpoint must run aggregate verification again after further implementation.
- **7 platform integration files / 63 tests passed**, including real confirmation/audit storage,
  explicit auth/tool stand-ins and unchanged auth throttles. Receipt
  `moss_finance-20261028-074638.log`, base commit `348fb6ad`, dirty input `ce47ce22aedd`, rc 0.
- **Installed app: 1 file / 2 broad browser tests passed.** Receipt
  `moss_finance-20261028-075421.log`, base commit `1b10a374`, dirty input `de3aea9bf64a`, rc 0.
  Production-built signed-in host, real signup/enablement/approval APIs, installed Finance and
  synthetic proof module, real workers and owner RLS. No intercepted application responses.
  Finance split saves and persists after reload; another owner sees no rows. A synthetic list
  line saves, delete opens the actual dialog, cancel preserves data, confirm deletes once.
  Outbound risk opens the same real dialog before execution, cancel leaves no delivery, confirm
  writes one receipt to an explicitly synthetic external-recipient stand-in. No external message
  is sent. Real audit rows show direct/confirmed outcomes; actual Settings Activity details show
  Module page. This is local installed synthetic proof, not production/provider/Meals acceptance.
- **Security negative controls observed.** Removing only destructive risk admission produced
  200 instead of 409 (`071237`, input `ac30a9465105`, rc 1). Restoring risk and removing only
  module ownership produced 200 instead of 404 (`071341`, input `08eb1d017bb3`, rc 1). Restored
  route passed 46 tests (`071438`, input `529d808d6d8a`, rc 0), then the expanded 63 above.
  Removing the host input copy made confirmation resend mutated ID/nested values; the focused
  test failed in `moss-host-snapshot-negative.log`. Restored controller passed 21 tests in
  `moss-host-snapshot-restored.log`. No protection-removal code remains.
- **Host browser fixture: 8 scenarios passed**, 320/390/768/1440, light/dark Canyon. Shared dialog
  focus/keyboard/return focus, cancel, actor change, safe failures and overflow. HTTP stand-ins
  are explicit; this is additional visual evidence, separate from the installed test.
- **Finance browser fixture: 28 scenarios passed** before platform integration, actual built
  module with explicit synthetic responses. Register/splits/reports/accounts, mixed currencies,
  exact cents/overflow, empty/loading/error, 320/390/768/1440 and light/dark. Installed screenshots
  were subsequently inspected at desktop and phone sizes. Shortened filter labels avoid clipping.

Artifacts are outside the worktree: `finance-installed-split-desktop.png`,
`finance-installed-split-phone.png`, `platform-installed-confirmation.png`,
`platform-installed-activity.png`, `module-confirm-*.png`, `module-tools-inspection.json` and
prior Finance register/reports/accounts screenshots. The installed harness owns and closes its
server/browser and removes temporary installed modules. A free local port is allocated by the
harness; no shared dev server is modified.

Initial installed attempts found a duplicate permission ID in the synthetic manifest, a stale
post-save button selector, and a checkbox test that expected optimistic state before persistence.
These were harness mistakes; each was fixed before the final green run. The actual split save
and owner isolation had already succeeded before the stale selector timed out.

## Aggregate limitations and recoverable prerequisites

Historical full foundation at old pre-rebase product commit `09205a7c`:
`moss_finance-20261028-062710.log`, input `353683ec32d5`, **rc 1**. Static passed; unit phase
reported **1,590 files / 19,272 tests passed, 24 files / 279 tests failed, 16 skipped**. Failures
were outside Finance: Computer ancestor ownership/IPC, missing ACL utilities/bundled browser,
auth-session invalidation and a missing parity fixture. Later migration/UAT/full-integration
phases did not run. There was no separate whole-baseline gate, so not every failure is proven
pre-existing. A later old gate `064739` was deliberately stopped with rc 143 before tests to
include the CSV fix; its container was removed. No final full-gate or CI pass is claimed.

`getfacl` and `setfacl` have now been recovered from Debian's official signed package repository
into task-local tooling. Playwright's official Chromium download failed with HTTP 403 Domain
forbidden from its CDN; no mirror bypass was attempted. System Chromium works and supplies the
UI proof. Computer ancestor ownership constraints remain; no security check was weakened.

The first post-rebase static attempt exposed two upstream heartbeat mockup lint declarations,
fixed separately in `acdd4af9`. Adding the route took server.ts over 1,000 lines; existing auth
throttle helpers moved unchanged to a small file and their 17 integration tests passed. The final
full foundation must be rerun after the next substantive slice with available prerequisites.

## Next actions

1. Implement the committed manual-account/entry design through the existing Finance store and
   guarded page bridge. Preserve provider snapshots, legacy backfill, owner RLS and exact replay.
   Resolve actual host timezone before enforcing future-entry boundaries. Add installed UI proof.
2. Add statement reconciliation and CSV preview/atomic import, then explicit transfers/archive.
3. Define a budget currency migration before filtering historical assignments; current historical
   ready-to-assign uses today's balances. Fix ordinary assignment/category concurrency before
   moving those forms to the synchronous route. Continue targets/goals, recurring and flex budget.
4. Rerun current focused/static/foundation gates; diagnose remaining failures and record unrun
   phases. Keep commits local and leave a precise tested checkpoint if continuation is needed.

Fresh GitHub reads at this checkpoint: #3723/#3724 are open, unassigned **issues**, with no
matching open implementation PR; #3733 is merged. Main `b24780e3` is one documentation-only
commit ahead of branch base `66f8e4ef`, touching only the heartbeat build plan. No Finance PR is
open. Direct shell GitHub access is forbidden; the authorized GitHub connector supplied these
reads. Historical #3269 and #3349 remain merged, not pending dependencies.

Platform details and exact route contracts: [continuation plan](2026-10-28-finance-platform-integration.md)
and [module-author guide](../../module-page-actions.md). No provider-dependent holdings/import
completion is claimed; those need separately authorized configuration and agreements.
