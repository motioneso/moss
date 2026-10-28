# Finance parity checkpoint

Updated 2026-10-28, 09:00 UTC. Local branch `task/finance-parity-20261028`, under `~/Jarv1s`.
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

7. **Manual accounts and posted entries.** Additive migrations 0020–0021; explicit opening
   balance/date, asset/debt signs and immutable supported two-decimal currency. Atomic entry,
   balance and metadata activity; stable identity/digest replay; concurrent distinct entries
   accumulate exactly once. Provider updates preserve manual rows. User timezone comes from
   authenticated preferences. Accounts forms use the guarded page bridge and await persistence;
   ambiguous saves freeze the draft for a records check. Manual rows show cleared/uncleared.
   Manual household sharing is explicitly unavailable until its projection supports ledger
   writes; existing bank sharing is preserved. CSV import remains next.
8. **Manual statement reconciliation.** Migrations 0022–0023 add statement baselines and owner
   receipts. Review exact recorded/cleared/statement balances, choose cleared entries, and finish
   only at zero difference under a ledger revision. Receipt, marks, statement and activity commit
   atomically. Replays and concurrent finishes do not duplicate; posting/finish races cannot close
   a stale ledger. Existing outstanding entries carry forward. New postings on/before a completed
   statement are refused. Categories/notes remain editable without changing reconciled dates,
   amounts, cleared state or balance. Reviews above 500 entries cannot finish a truncated list;
   choose an earlier cutoff where possible. Larger single-day reviews and provider reconciliation
   are not supported. The actual installed UI has persisted and reloaded a statement, exercised
   mismatch/cancel and keyboard selection, and been inspected in light/dark at four widths.

Current Park Press/Park Pass foundations supply Archivo, semantic colors, shared controls and
modal behavior, warm paper, tabular amounts and responsive layouts. Module styles add layout.
The Finance manifest is 0.7.0; app-map entries describe the bounded capability and remediations.

## Current capability matrix

| Area                        | Status now                                                                              | Remaining acceptance                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Accounts                    | Partial: manual/provider accounts, exact opening balances and posted entries            | Archive, provider reconciliation and broader currency model                                     |
| Import/reconciliation       | Manual entry and bounded manual statement reconciliation supported; file import missing | Atomic CSV preview/apply, duplicate decisions, provider reconciliation, large statement reviews |
| Transaction workspace       | Supported bounded filtering, duplicate candidates and loaded-row CSV                    | Full-history export, atomic bulk editing, explicit transfer linking                             |
| Splits                      | Supported posted own SQL category splits; installed UI persistence proven               | Split transfers, line notes/payees and pending edits                                            |
| Categories/rules            | Partial existing categorization and merchant rules                                      | Management/preview and ordinary-write concurrency                                               |
| Envelope budget/rollover    | Partial existing envelopes; validated atomic assignment batches                         | Currency/history policy, credit-card reserves, configurable carry                               |
| Flexible budget             | Missing                                                                                 | Fixed/non-monthly/flex model without double counting                                            |
| Targets/goals               | Missing                                                                                 | Monthly/date-bound targets, exact remaining funds                                               |
| Recurring bills             | Missing                                                                                 | Cadence, occurrences and one-time import matching                                               |
| Cash flow/reports/net worth | Partial: currency-safe spending/cash flow/snapshots                                     | Ledger valuations, drill-through, saved/custom views                                            |
| Household                   | Partial existing opt-in shared reads                                                    | Explicit co-edit and joint-account policy; preserve private notes                               |
| Investments                 | Partial balances only                                                                   | Provider-dependent holdings/performance; trading out of scope                                   |
| Long-range forecasts        | Out of scope for initial roadmap                                                        | Separate assumptions/uncertainty design                                                         |
| Platform page writes        | Implemented; actual installed Finance and synthetic-module proof passed                 | Independent review, CI and release/deployment acceptance; Meals consumer remains separate       |

Manual account/entry persistence is exercised through the installed app. The remaining
[manual-ledger design](../specs/2026-10-28-finance-manual-ledger.md) now includes completed bounded reconciliation. Previewed CSV, explicit transfers and archive
remain unimplemented.

## Current reconciliation verification

- **56 focused files / 557 tests passed**, including Finance, shared host/input/activity/design
  checks and the gate-log regression (`moss-finance-reconcile-final-unit.log`). Final metadata
  edit regression: **2 files / 37 tests passed**, `moss-finance-reconcile-metadata-unit.log`.
- **11 installed SQL ledger/reconciliation tests passed**, including complete 501-row count/cap,
  replay and concurrency, refunds/debt, owner isolation, and immutable reconciled money/date
  fields during later category/note edits. Receipt `moss_finance-20261028-085650-JKRsuv.log`,
  base `09575440`, dirty input `a77dd1a62304`, rc 0.
- **3 install/backfill files / 11 tests passed**, `085506-u1n1A7`, input `a863f102d59b`, rc 0,
  including 23 additive migrations and generated FORCE RLS on the tenth Finance table.
- **3 installed browser flows passed**, `085506-vMNAdl`, same input, rc 0. This expanded run
  includes a real manual statement finish/reload through signed-in production UI, API, worker
  and SQL; cancellation leaves marks unchanged, a mismatch disables finish, keyboard selection
  changes the difference, and another owner cannot read the account review. Light/dark screenshots
  at 320/390/768/1440 were inspected (`finance-reconcile-*.png`). No application responses were
  intercepted. The later metadata-only storage change is covered by the final 11-test DB run.
- **Aggregate static passed**, `moss-finance-reconcile-static-final.log`, including all lint,
  format, design, file-size, dependency, migration, TypeScript and app-map checks. Docs were
  formatted separately after recording these receipts.
- Receipt-table RLS negative control: disabling only its generated policy made a foreign owner's
  replay return `unchanged` instead of `conflict` (`084725`, input `2976a5cac796`, rc 1). Restored
  tests passed before acceptance; no disabled guard remains.
- **Recovered gate tooling defect:** same-checkout starts within one second shared a log filename.
  The `084836` combined output is discarded as acceptance evidence even though all three containers
  recorded cleanup. `09575440` reserves a unique log atomically; a frozen-clock regression first
  failed with one log, then **9 tooling tests passed** (`moss-gate-concurrent-restored.log`). The
  three independent `085506-*` receipts demonstrate separate logs for simultaneous real gates.
- Initial declaration checks caught the app-map feature-count/description limits. Consolidating
  manual-ledger and reconciliation facts kept the map complete within the existing limits. A
  manifest expected-tool tuple in a test also needed correction. These are fixed in green checks.

## Earlier manual-ledger verification

- **52 files / 532 focused unit tests passed** in `moss-finance-manual-assembled-unit.log`,
  plus **4 form-state tests** in `moss-finance-manual-form-unit.log` (old host, rejected draft,
  stable identity, uncertain save and exact successful entry).
- **5 database tests passed** after the owner negative control was restored:
  `moss_finance-20261028-082201.log`, base `2e3bddbd`, input `c8e8f5f08777`, rc 0. Identical
  and distinct races, refund/debt/overflow, owner isolation, opening baseline and provider-write
  preservation use the installed module and runtime role. Disabling account/transaction RLS
  in the disposable test setup produced `created` instead of `unavailable` (`082118`, input
  `6f38ed744d76`, rc 1); no disabled protection remains.
- **7 platform files / 64 tests passed**, `082502`, base `2e3bddbd`, input `fa3b7c25e949`, rc 0.
  Forcing the host timezone to UTC made the new authenticated-preferences test fail (`082335`,
  input `09d60c8ded00`, rc 1); correct forwarding was restored before the green run.
- **3 Finance install/backfill files / 11 tests passed**, `082505`, input `fa3b7c25e949`, rc 0,
  now installing 21 additive migrations.
- **3 installed-app tests passed**, `082503`, same input, rc 0. Real signup/approval, production
  web build, installed worker/store and signed-in page: split save, manual account + cleared
  entry + reload, owner isolation, and host confirmation/audit. Manual entry was inspected at
  320/390/768/1440 in light/dark. Screenshots exposed native date-widget contrast in dark mode;
  the shared theme now declares the browser color scheme. The cleared control uses shared Switch.
  Final installed run **3/3 passed**: `083038`, input `ab03eaf09a9e`, rc 0, including the
  shared Switch and corrected native date contrast. The first Switch harness attempt clicked its
  intentionally hidden input and timed out; clicking the visible label passed. Final visual/form
  regression rerun: **3 files / 23 tests passed**, `moss-finance-manual-visual-unit.log`.
- First manual DB attempts correctly failed on the module installer's one-statement migration
  contract, then a SQL bigint/numeric parameter conflict. Both were fixed before green runs.
  The first static attempt caught a manifest over 1,000 lines. Preserving its existing compact
  declarations fixed this without removing schema validation. **Aggregate static passed** in
  `moss-finance-manual-static-final.log`: lint, format, file size, token/classes/catalogue, ambient
  dates, package dependencies, migrations, all TypeScript projects and app-map generation. The
  final browser-test selector and documentation edits were formatted after that run; the frozen
  foundation rerun will validate their final committed form.

## Earlier platform verification

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

Latest frozen full foundation: clean committed `e7ef904a`,
`moss_finance_verify-20261028-083341.log`, input `3ae7e91c4893`, **rc 1**, ended 08:52:40 UTC
and removed its container. Static passed. Unit phase: **1,595 files / 19,344 tests passed,
24 files / 277 tests failed, 16 skipped**. Manual accounts/entries were included; reconciliation and the later gate-log fix were not.
Failures are outside Finance: Computer ancestor ownership/IPC (including the auth-session
invalidation fixture), unmappable native ACL IDs, and four bundled-browser suites. The
container maps only UID/GID 1000, so `/` appears owned by 65534 and ACL user 100001 is invalid.
Changing the temp directory cannot satisfy an ancestry check that reaches `/`. Guards were
not weakened. Compared with the preceding frozen `2e3bddbd` run (`075738`), all 281 failed
assertion/suite identifiers are identical, with no additions or removals. This establishes no new
aggregate failure from the manual slice; it is not a whole-main baseline proof. Later foundation migration/UAT/full-integration phases did not run; the separately
listed narrow gates did. No separate whole-baseline gate or CI was run, so this is not a claim
that every failed assertion is independently proven pre-existing. Historical receipts remain
in the earlier committed checkpoint. The final reconciliation static/focused/DB/browser checks are listed above; its full foundation
and CI remain unrun at this checkpoint.

`getfacl` and `setfacl` have now been recovered from Debian's official signed package repository
into task-local tooling. Playwright's official Chromium download failed with HTTP 403 Domain
forbidden from its CDN; no mirror bypass was attempted. System Chromium works and supplies the
UI proof. Computer ancestor ownership constraints remain; no security check was weakened.

The first post-rebase static attempt exposed two upstream heartbeat mockup lint declarations,
fixed separately in `acdd4af9`. Adding the route took server.ts over 1,000 lines; existing auth
throttle helpers moved unchanged to a small file and their 17 integration tests passed. The final
full foundation must be rerun after the next substantive slice with available prerequisites.

## Next actions

1. Preserve this reconciliation checkpoint. Improve manual onboarding and add CSV preview/atomic
   import with explicit duplicate decisions, then explicit transfers/archive.
2. Keep the 500-entry reconciliation limit explicit; add pagination/selection before claiming
   support for larger single-day statements. Provider reconciliation remains separate.
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
