# Finance parity checkpoint

Updated 2026-10-28, 10:48 UTC. Local branch `task/finance-parity-20261028`, under `~/Jarv1s`.
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
   writes; existing bank sharing is preserved.
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

9. **Manual CSV import and onboarding.** Migration 0024 adds owner-scoped import receipts. UTF-8
   CSV mapping explicitly chooses date order and money direction; 1 MiB files, 200 rows and 500 KiB
   mapped entries are bounded. Read-only preview identifies same-file and ledger candidates; each
   needs Skip or Import anyway. Stable original row identities, exact balance, all entries, receipt
   and metadata activity commit together. Stale reviews, invalid dates/currency and unsafe totals
   write nothing. Replays after later ledger changes remain idempotent. Getting started provides
   a manual-account link without bank keys. Long forms use the shared optional body-scroll dialog,
   preserving visible headings/actions. Import into provider accounts, categories/tags from files,
   larger batches and automatic replacement are not claimed.

10. **Exact budget arithmetic and manual cash funding.** Envelope activity, carry and cumulative
    income/assignment math now use integer arithmetic throughout. Safe public values are checked
    on output; large intermediate cancellation does not lose cents. Ready-to-assign includes manual
    cash without treating other assets/loans/investments as spendable money. Existing carry and card
    policies remain. Currency and historical funding follow below; ordinary-write concurrency remains in progress.

11. **Reviewed budget currency and historical funding.** Migration 0025 adds an owner policy.
    No currency is preselected; setup requires the host confirmation, and existing assignment
    amounts require explicit acknowledgement without conversion. Open untyped drafts close after
    review. Budgets include only matching-currency funding accounts and posted activity through
    the owner's local day. Tracking-account transfers do not remove genuine budget spending.
    Historical manual cash/debt derives from opening baselines; bank history uses dated snapshots.
    Missing history and future ready-to-assign show Unavailable. Current funding reserves positive
    future assignments, disclosed beside the total. Drafts, accounts and activity display the
    chosen or recorded currency. This is one immutable budget currency, not FX or multi-budget
    support. The REST read-tool path now receives the authenticated owner's locale, fixing an
    actual installed-page failure without taking a second database connection.

Current Park Press/Park Pass foundations supply Archivo, semantic colors, shared controls and
modal behavior, warm paper, tabular amounts and responsive layouts. Module styles add layout.
The Finance manifest is 0.7.0; app-map entries describe the bounded capability and remediations.

## Current capability matrix

| Area                        | Status now                                                                   | Remaining acceptance                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Accounts                    | Partial: manual/provider accounts, exact opening balances and posted entries | Archive, provider reconciliation and broader currency model                               |
| Import/reconciliation       | Manual entry, statements and bounded atomic CSV preview/import supported     | Provider-account import/reconciliation, larger files/reviews, category mapping            |
| Transaction workspace       | Supported bounded filtering, duplicate candidates and loaded-row CSV         | Full-history export, atomic bulk editing, explicit transfer linking                       |
| Splits                      | Supported posted own SQL category splits; installed UI persistence proven    | Split transfers, line notes/payees and pending edits                                      |
| Categories/rules            | Partial existing categorization and merchant rules                           | Management/preview and ordinary-write concurrency                                         |
| Envelope budget/rollover    | Partial envelopes; reviewed currency, exact math and historical funding      | Ordinary-write concurrency, credit-card reserves, configurable carry                      |
| Flexible budget             | Missing                                                                      | Fixed/non-monthly/flex model without double counting                                      |
| Targets/goals               | Missing                                                                      | Monthly/date-bound targets, exact remaining funds                                         |
| Recurring bills             | Missing                                                                      | Cadence, occurrences and one-time import matching                                         |
| Cash flow/reports/net worth | Partial: currency-safe spending/cash flow/snapshots                          | Ledger valuations, drill-through, saved/custom views                                      |
| Household                   | Partial existing opt-in shared reads                                         | Explicit co-edit and joint-account policy; preserve private notes                         |
| Investments                 | Partial balances only                                                        | Provider-dependent holdings/performance; trading out of scope                             |
| Long-range forecasts        | Out of scope for initial roadmap                                             | Separate assumptions/uncertainty design                                                   |
| Platform page writes        | Implemented; actual installed Finance and synthetic-module proof passed      | Independent review, CI and release/deployment acceptance; Meals consumer remains separate |

Manual account/entry persistence is exercised through the installed app. The remaining
[manual-ledger design](../specs/2026-10-28-finance-manual-ledger.md) now includes completed bounded reconciliation. Explicit transfers and archive remain unimplemented.

## Currency/history verification checkpoint

- Focused Finance: **52 files / 549 tests passed**, `moss-finance-budget-stageb-final-unit.log`.
  Tests cover month/year/leap boundaries, owner timezone, funding scope, missing snapshots,
  future reservations, exact cancellation, legacy review and old-host/cancel states.
- Final installed storage: **20 tests passed**, `104001-VH6EZq`; install/backfill **3 files /
  11 tests passed**, `104008-UMmUm7`. Both base `4107c130`, dirty input `bddd55a57f49`, rc 0.
  There are 25 additive migrations and 12 owned tables. Setup preserves legacy cents, requires
  acknowledgement for an open untyped draft, rejects changing currency and admits only one of
  two competing setup choices. Removing only policy RLS failed as expected (`102735-X26V5V`,
  input `addbe7a53869`); it was restored before both later green database runs.
- Platform: **9 files / 78 tests passed**, `104020-YLv1yx`, same base/input, rc 0. This includes
  restored confirmation guards, read/write boundaries, authenticated locale forwarding and the
  existing authorization/rate-limit suites. The read-locale test uses one connection and distinct
  owner preferences; a caller-supplied timezone does not select the execution timezone.
- Installed app: **six flows passed**, `104013-rmkuQX`, same base/input, rc 0. Fresh USD setup
  cancel/confirm, another owner's legacy EUR review, preserved €20 assignment and €1,214.50 ready
  despite a separate large USD account, plus manual entry, reconciliation, CSV and splits. These
  are real signed-in production bundles, workers and installed SQL with synthetic records; no
  application responses were mocked. Light/dark screenshots at 320/390/768/1440 were inspected,
  including `finance-budget-setup-*`, `finance-budget-legacy-*` and `finance-budget-eur-*`.
- Removing only currency setup's `confirmWhenKeys` condition made both browser confirmation
  checks fail because no dialog appeared (`103731-1NHBUh`, base `4592edb5`, input `0d13bd7de5bb`,
  rc 1). The manifest was restored before the final six-flow green run. No removed guard remains.
- Aggregate static passed, including the final copy/draft-review follow-up, in
  `moss-finance-budget-stageb-final-static.log` (rc 0). This includes lint, format, all design and
  maintainability checks, root/tests/web/module TypeScript and app-map generation. Earlier attempts caught a fake KV delete return
  type and a test exceeding 1,000 lines; both were fixed. Browser attempts exposed the missing
  REST locale (fixed), then the actual host confirmation title and the second owner's onboarding
  setup (harness corrected). All four final integration containers were removed.

## Current budget-precision verification

- **50 Finance files / 538 tests passed**, `moss-finance-budget-precision-unit.log`, including large
  cancelling values, unsafe source/output values, carry across year gaps and manual cash funding.
- **4 installed flows passed**, `094830-liZK4k`, base `dbc5c6a3`, input `fe7434a8a696`, rc 0.
  The real budget tool and signed-in Budget page both show the exact ready-to-assign result including
  the synthetic manual cash account. Existing import/reconciliation/split/platform flows also passed.
- **Aggregate static passed** on committed `395c8ab9`, `moss-finance-budget-static-final.log`: lint, format, design tokens/classes/catalogue, file sizes, dependencies, migrations, root/test/web/module TypeScript and app-map generation. The next implementation
  is Stage B in the [budget correctness spec](../specs/2026-10-28-finance-budget-correctness.md):
  reviewed currency setup and historical funding, followed by atomic ordinary writes. Do not
  interpret this arithmetic fix as full envelope parity or a fix for mixed-currency budgets.

## Current import verification

- **65 files / 650 focused tests passed**, `moss-finance-import-focused-final.log`; additional final
  parser/form regressions **3 files / 40 tests passed**, `moss-finance-import-form-final.log`.
  Bounds, malformed CSV/UTF-8, explicit mapping, exact signs/dates, duplicate choices, stale
  previews and uncertain/cancelled writes are covered. The final frozen acceptance rerun is pending.
- **17 ledger/import DB tests passed after restoring the receipt RLS guard**,
  `moss_finance-20261028-092733-QRxinY.log`, base `f07bc0f5`, input `5c935221de0e`, rc 0.
  Atomic invalid-row/collision rollback, distinct and identical concurrent batches, original source
  row identities, later-revision replay and owner-scoped receipts use actual installed module SQL.
- Removing only import receipt RLS in a disposable setup caused the owner test to fail:
  `092551-q4SChE`, input `3bda86560e35`, rc 1, foreign replay returned `unchanged` rather than
  `conflict`. The protection was restored before the green run; no disabled guard remains.
- **Installed UI 4/4 broad flows passed**, `093434-deAgCS`, base `07ba50a5`, input `a35d8d3ad02f`,
  rc 0. Synthetic CSV upload → explicit mapping → duplicate review → atomic import → reload
  persisted exact cents and original row identities. A second preview flagged existing entries;
  cancel kept the ledger unchanged. Other-owner preview returned 422. Existing split/manual/
  reconciliation/host-confirmation flows also passed. No application responses were mocked.
- Light/dark 320/390/768/1440 screenshots `finance-import-map-*` and `finance-import-review-*`
  were inspected. Executable assertions check no horizontal overflow and heading/footer visibility.
  The shared dialog option is committed separately as `07ba50a5`; 17 lifecycle tests passed.
- Install/backfill **3 files / 11 tests passed**, `093027-XPiFGO`, input `9a669e856da0`, rc 0:
  24 additive migrations and 11 owner-scoped tables. All gate containers were removed.
- Initial SQL used escape-string literals rejected by the module query guard; the query now uses
  supported whitespace normalization without relaxing the guard. Manifest/migration expectation
  tests were updated. The manifest retains complete validation under a documented narrow line-count
  exemption. A pre-existing test rejects any uncommitted shared Dialog edit; it passes with the
  reviewed primitive committed. Static attempts found a missing test import extension and a format
  race while the test was edited. Those are corrected. On clean `209a4e72`, **17 DB tests**
  (`094011-EeMUul`), **11 install/backfill tests** (`094011-Bt5W2a`) and **4 installed flows**
  (`094011-qG9SMr`) all passed, input `e1658952c133`, rc 0 and container cleanup confirmed.
  Its separate frozen foundation `094009-rgShgW` completed with the same unrelated failures; see the aggregate section below.

## Earlier reconciliation verification

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

## Reviewed concurrent budgets and first-budget flow (Stage C)

All assignment/move commands now require the reviewed budget revision, an opaque ledger
fingerprint and explicit previous totals. The SQL policy update is the common gate for assignments,
activity, draft/category creation, draft status and undo marks. A failed gate leaves those rows
unchanged. Concurrent budget writers serialize through that policy row. Ledger changes committed
before the statement snapshot invalidate an old review; later ledger events can still change
funding. This is optimistic concurrency, not universal serializable bank synchronization.

Migration 0026 records the one-time authoritative category cutover. Existing KV custom ids/names
are copied, absent stale SQL copies are archived, and later migration replays preserve SQL edits.
Category archive and undo refuse to strand current/future assigned or available money. Archived
history remains visible. First-budget edits/start use awaited host tools; manual history can open
Getting started without credentials. Starting always requires host confirmation. Exact draft
arithmetic uses bigint intermediates. Budget and draft forms retain rejected typed amounts, show
only saved totals and require checking records after an ambiguous response.

Verification on local base `5ac7d98c`:

- **52 files / 552 unit tests pass**, including cancelled/stale/ambiguous UI state. Unit server
  fixtures are labeled stand-ins; concurrency is proved by real SQL tests below.
- **26 installed SQL tests pass**, `moss_finance-20261028-111538-hknuL7.log`, input
  `155dfc596f33`, rc 0. Competing assignments, changed entries/splits/snapshots/import/provider
  corrections, constraint rollback, shared draft/undo guard and draft edit/start race are covered.
- Negative control: removing only revision/fingerprint predicates caused **4 failures / 22 passes**,
  `moss_finance-20261028-111459-gNKrGk.log`, input `18e5abed3752`, rc 1. Competing assignments
  both wrote and stale changes applied; the fourth failure followed the deliberately started draft.
  Predicates were restored before the 26-test green run. No disabled guard remains.
- **3 files / 11 install/backfill tests pass**, `moss_finance-20261028-111540-XqjCxQ.log`, same
  `155dfc596f33` input, rc 0; all 26 migrations install and replay.
- **7 installed browser flows pass**, `moss_finance-20261028-111539-kGzzhI.log`, same input, rc 0.
  A second tab changes an amount while the first awaits confirmation; approving the old review
  rejects without overwriting the second tab. A separate manual-only owner builds, edits, cancels,
  confirms and reloads a first budget. Existing split/statement/CSV/platform flows still pass.
- Screenshot review covered 320/390/768/1440 widths, light/dark and Sage. It caught an amount-focus
  replacement bug, now fixed, plus clipped error wording and an inaccurate chat-edit label. The
  final polish rerun passed **7/7** (`moss_finance-20261028-111912-XkfMr4.log`, rc 0); updated
  phone/desktop screenshots were inspected again. Screenshots are synthetic, task-local artifacts.

Static verification passed (lint, formatting, design/layout, file sizes, dependencies, migrations,
all TypeScript programs and app-map build); final visual-only edits also passed scoped lint and
52 files / 552 unit tests. The next frozen foundation will retest the committed snapshot.

The previous platform confirmation/owner guard receipts remain recorded above; no platform guard
was bypassed for these Finance flows. Next: targets, recurring plans and flexible budget semantics
under the [planning spec](../specs/2026-10-28-finance-targets-bills-flex.md).

## Aggregate limitations and recoverable prerequisites

Latest **completed** frozen foundation: clean committed `5152c880`,
`moss_finance_verify-20261028-104418-lQ4O7G.log`, input `9d3149446bbb`, **rc 1**, ended
11:02:07 UTC and removed its container. Static passed. Unit phase: **1,604 files / 19,428 tests
passed, 21 files / 277 tests failed, 3 skipped**. This includes the committed currency/history
slice. All 277 failed test identifiers exactly match the prior clean `e6f831f4` receipt
(`moss_finance_verify-20261028-095917-1eDZFx.log`, input `42279264a260`): zero additions or removals.

Remaining failures are outside Finance: Computer ancestor ownership/IPC (including auth-session
fixture), unmappable native ACL IDs and the Sports bundled browser. The container maps only
UID/GID 1000; `/` appears owned by 65534 and ACL user 100001 is invalid. Changing the temp directory
cannot satisfy an ancestry check reaching `/`; guards were not weakened. The comparison establishes
no new aggregate failure across these tested slices, not an independently proven whole-main baseline.
Later foundation migration/UAT/full-integration phases did not run; separately listed narrow
integration gates did. CI remains unrun. No gate is hung.

**Recovered browser prerequisite:** `e6f831f4` lets the three parity-only browser suites use
`CHROMIUM_PATH`, retaining their bundled-browser default. All **3 files / 13 tests passed** with
installed Chromium (`moss-parity-system-chromium.log`), plus scoped lint/format and the frozen full
rerun above. This uses Playwright's [documented executable option](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path),
with actual execution and unchanged assertions. These existing fixture harnesses remain separate
from Finance's unmocked installed proof. The production Sports sidecar remains unchanged.

`getfacl` and `setfacl` have now been recovered from Debian's official signed package repository
into task-local tooling. Playwright's official Chromium download failed with HTTP 403 Domain
forbidden from its CDN; no mirror bypass was attempted. System Chromium works and supplies the
UI proof. Computer ancestor ownership constraints remain; no security check was weakened.

The first post-rebase static attempt exposed two upstream heartbeat mockup lint declarations,
fixed separately in `acdd4af9`. Adding the route took server.ts over 1,000 lines; existing auth
throttle helpers moved unchanged to a small file and their 17 integration tests passed. The final
full foundation must be rerun after the next substantive slice with available prerequisites.

## Next actions

1. Currency/history is committed as `5152c880`, locale forwarding as `7f147700`, and the
   concurrency plan as `4107c130`. The frozen foundation completed on clean `5152c880` with the limitations above
   (`moss_finance_verify-20261028-104418-lQ4O7G.log`); continue the [concurrent-write plan](2026-10-28-finance-budget-concurrency.md).
2. Preserve the tested concurrent-budget slice and finish its final visual/static receipts.
3. Implement monthly/date-bound targets, recurring bills and flexible budgeting as tested vertical
   slices, with the evidence matrix reflecting actual end-to-end capability.
4. Keep provider reconciliation, larger imports/statements, explicit transfers/archive and household
   co-edit gaps visible. Preserve all local commits; publication and deployment remain unauthorized.

Fresh GitHub reads at 09:02 UTC, with main/open-Finance-PR rechecked at 09:58 UTC: #3723/#3724 are open, unassigned **issues**, with no
matching open implementation PR; #3733 is merged. Main `b24780e3` is one documentation-only
commit ahead of branch base `66f8e4ef`, touching only the heartbeat build plan. No Finance PR is
open. Direct shell GitHub access is forbidden; the authorized GitHub connector supplied these
reads. Historical #3269 and #3349 remain merged, not pending dependencies.

Platform details and exact route contracts: [continuation plan](2026-10-28-finance-platform-integration.md)
and [module-author guide](../../module-page-actions.md). No provider-dependent holdings/import
completion is claimed; those need separately authorized configuration and agreements.

## Exact continuation point

The original checkout is clean. The isolated task checkout preserves the currency/history slice locally. Final static verification passed; the frozen full foundation completed on `5152c880`; all work is local. The previous full gate completed with the limitations
above. Installed harnesses close their API/browser instances and remove temporary bundles.
Continue Stage C of the budget correctness spec after preserving Stage B. The focused concurrency
plan describes the revision/fingerprint boundary and taxonomy cutover needed for atomic draft start.
Then continue targets, recurring bills and flexible planning through the authorized work window.

## October 29 resumption: category targets

Resumed from clean local `10cb932f`; the four untracked target scaffold files were preserved and
completed into storage, worker/API and Budget UI. The managed environment retained repository files
and synthetic screenshots but lost October 28 temporary tooling/logs. The attempted frozen gate on
`10cb932f` therefore has no recoverable terminal receipt; its result is unknown. Earlier receipts
above are historical records, not reruns in this environment. A task-local official pnpm 10.6.2
install restores the toolchain without replacing repository dependencies or accessing secrets.

Migration 0027 adds effective-month category targets. Monthly progress counts net assignments;
balance-by-date progress counts available category money, including spending/refunds/carry.
Exact bigint ceiling divides remaining cents over inclusive remaining months. Targets do not assign
money or create a second goal balance. A shared revision/fingerprint gate serializes target edits,
writes activity and rejects stale reviews. Removing a target ends guidance from the chosen month;
earlier months retain their version. The UI retains failed input and requires checking records after
an ambiguous save. Broader account-linked goals, automatic funding, investments and forecasts are
still missing. Recurring bills and flexible budgeting remain the next capability slices.

Observed checks so far:

- 53 unit files / 557 tests passed, including cent remainders, negative availability, monthly
  assignment semantics, due-date/year boundaries and overflow.
- 27 installed SQL tests passed: `moss_finance-20261029-175741-GYMDxg.log`, including competing
  target edits, owner-scoped reads, historical versions/removal and unchanged assignment amounts.
- Target RLS negative control: `moss_finance-20261029-175658-ofkPsC.log`, 1 expected failure /
  26 passes after disabling only the target table's RLS in a disposable DB. The other owner could
  then read the target. The temporary test mutation was restored before the 27-test green run.
- 3 files / 11 install/backfill tests passed: `moss_finance-20261029-175742-akXnDd.log`.
  Initial failure identified an outdated test-owned table list; it now declares the target table.
- 7 installed browser flows passed: `moss_finance-20261029-175621-oyRbaT.log`, including monthly
  target creation through the real host. Phone screenshot inspected. A follow-up exercises editing
  into a dated target and captures the editor in phone/dark and desktop/light.
- Final dated-target/phone-footer browser rerun: **7/7 pass**,
  `moss_finance-20261029-180028-760mhS.log`, rc 0. Monthly target creation and conversion to a
  dated goal run through actual host/worker/SQL; every editor button remains within phone bounds.
  Updated dark 320px and light 1440px editor screenshots were inspected. The first visual review
  caught a clipped Cancel button; wrapping the footer fixed it before the final green run.
- Static aggregate **passed rc 0**: lint, formatting, file size, design tokens/classes, dependency
  and migration checks, root/tests/web/module TypeScript and app-map build. Final visual-only
  edits also passed scoped lint. Final focused units remain **53 files / 557 tests passed**.
- No new foundation or CI completion is claimed. The former whole-repository failures are recorded
  above; a fresh full gate must establish the current environment baseline. All work remains local
  and synthetic. Narrow gates cleaned up their containers and installed browser/API instances.

Next concrete slice: recurring bill plans with anchored calendar recurrence, projected-versus-posted
states, explicit transaction matching and skip/stop history, following the committed targets/bills/flex
spec. Then implement flexible-pool conservation and mode transitions. No user decision blocks either
slice; no provider connection or live financial action is authorized.

## Remote branch and recurring-bill foundation

The user subsequently authorized pushing this task branch while keeping it unmerged. Normal git
push succeeded and `ls-remote` independently confirmed `affdbed3ab160a02355ca07f61d8d23fb100e54e`
on `refs/heads/task/finance-parity-20261028` in `motioneso/moss`. No PR or merge was performed.
This authorization supersedes the earlier publication restriction for branch pushes only.

Continued the recurring-bill slice with pure anchored recurrence calculations and six regression
cases: monthly end clamps without drift, leap years including 2100, DST boundaries, fortnightly
and inclusive stop dates, early years/long-lived schedules and invalid input/window bounds.
The engine projects bounded date windows and never posts transactions. This is infrastructure,
not completed recurring-bill capability; persistence, guarded edits, paid matching, skip history,
and the Upcoming UI still require implementation and installed acceptance. The matrix remains
Missing for recurring bills. Scoped lint and Finance TypeScript passed; the focused Finance
unit suite passed: 54 files / 563 tests. No DB or browser behavior changes in this foundation.

## Recurring-bill vertical slice

Migrations 0028/0029 add private bill plans and occurrence decisions. The Upcoming primary tab
supports one-time/weekly/fortnightly/monthly/yearly plans, expected amounts, explicit posted matching,
skip, undo review and stopping future dates while preserving reviewed history. Plans never post a
transaction or payment. Replacing a plan currently means stopping it and adding another; single
occurrence date/amount edits, calendar presentation, detection and bank Bill Sync remain missing.
The matrix says Partial rather than universal recurring-bill parity.

All writes share the reviewed policy revision/fingerprint gate with budgets and targets. Account,
category, currency, posted status and duplicate transaction matching are checked in SQL. A match
shows actual cents independently of its expected amount. Later provider corrections/deletions can
make a saved match need review; transaction removal is not blocked by a bill foreign key. Reviewed
occurrences must be undone before stopping earlier than their due dates. Metadata activity contains
ids and enums; bill names stay in the owner-scoped plan row. Ambiguous saves retain input and stop
further writes until the user checks saved records. Dialogs keep their captured review tokens.

Observed development verification:

- 8 installed bill SQL cases pass after fixing a pending-transaction fixture that incorrectly tried
  to change an immutable posted manual row. The corrected fixture uses a synthetic provider row.
  `moss_finance-20261030-012732-azJkGF.log`, rc 0.
- RLS negative control removed protection only on the two new tables in a disposable DB:
  `moss_finance-20261030-012656-VC7eVF.log`, exactly 2 owner-read failures / 6 passes. Restored
  before the green eight-case run. No disabled production or test guard remains.
- Existing ledger/currency/target tests: 27 pass (`012735-oHEeFm`); install/backfill: 3 files /
  11 pass (`012734-0N7HoB`). Both October 30 logs cleaned up their containers.
- Installed browser: 8 flows pass (`012821-0TlaSn`), including create/match/reload/undo/skip/stop.
  The first phone inspection found a long form hiding its footer. Shared scrollBody and close
  controls fixed it; the rerun asserts fixed header/footer and horizontal button bounds.
  Desktop/phone/light/dark/Sage screenshots were inspected.
- Static aggregate passed; focused core units passed 55 files / 567 tests. Three additional form
  tests now pass and cover explicit account/category selection, captured review, cancellation,
  ambiguous responses and sub-cent rejection. Early selector mistakes in those tests were fixed.

A committed snapshot rerun follows before pushing the slice. No merge/deployment/real bank action
is authorized. Flexible-pool budget semantics are next, including conservation across mode changes
and historical versions; do not claim a cosmetic grouping as flexible-budget parity.
