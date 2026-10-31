# Finance continuation checkpoint — October 30

Task branch: `task/finance-parity-20261028`. Commit and push are authorized; no merge, deployment,
real bank/credential/financial action, production data change or published PR. Use synthetic records.
See [the evidence-linked matrix](../specs/2026-10-28-finance-parity.md) and
[earlier staged receipts](2026-10-28-finance-parity-checkpoint.md). Broad parity remains partial.

## Completed vertical slices in this continuation

- Flexible budgeting, targets, recurring plans/bill matching, CSV import, statement reconciliation,
  confirmed platform page tools, atomic bulk categorization and exact report drill-through were
  already committed/pushed. Their detailed receipts are retained in the earlier checkpoint.
- Manual net worth: `ccb55946886d16d585b590b13b16690e35ea59db`, pushed and remote verified.
  Exact opening baselines plus owned posted manual entries; debts/refunds/transfers and local dates;
  provider snapshots retain their dated policy. Explicit sources, omissions and accessible point
  history. No FX/market estimates. Clean input `69e85089d890`: SQL six (`032028-o7J3Wj`), module
  install/parity 11 (`032030-QU3Lss`), installed browser 12 (`032021-GlTUIH`), full static
  (`032204-kAPbXb`) all passed. Focused units 61 files / 609 passed.
- Owned history export: `7558098fb4d1298b07972bf696cd669d349bc5ad`, pushed. One SQL snapshot
  across stored months, optional inclusive dates/account, exact parent/split cents and statement
  metadata. No notes/mirrors. At most 5,000 rows / 2 MiB; refusal never produces a truncated file.
  Explicit preparation, captured scope/count/time, actual download, scope-change invalidation,
  friendly retry and visible phone summary. Clean input `dae54373593c`: SQL four
  (`033210-oj4toZ`) and installed browser 13 (`033129-cj9bHW`) passed. Focused units 62 files /
  619 passed. Static passed in the full aggregate below. Desktop light and phone dark inspected
  after moving the prepared summary above the form and adding count/account beside the download.

## Captured category confirmation implementation

Design committed before implementation:
[atomic captured confirmation](../specs/2026-10-30-finance-confirm-review.md).

Installed SQL capability replaces the old queued Confirm all path with a captured review of up to
200 loaded owned posted unsplit needs-look rows with live categories. If more qualify, the interface
states the first-200 scope and remaining count. Capture includes names, dates, categories, exact
amounts/currencies and opaque revision references. The host confirmation remains mandatory.

One SQL statement locks rows in stable ID order, rechecks revisions/review state and share-locks live
categories, then commits confirmation/provenance plus metadata-only activity all or none. No amounts,
notes, dates, splits, reconciliation or balances are rewritten. Success is awaited before hiding rows.
Cancellation retains review. Stale/ambiguous failures keep captured choices and block resubmission
until an explicitly requested fresh successful register read; failed reads do not unlock the batch.
Individual/category/rule queues retain their existing behavior and remain a separate concurrency gap.

Read failures now have friendly copy and an explicit Retry register action, with filters retained and
the retry disabled until a new result arrives. No validation deadline or authorization check changed.
Old stores without the capability keep their existing legacy path; it is not called atomic.

Development verification on base `45741196`, before the final commit:

- Focused Finance: 63 files / 625 unit tests passed, including pending-success timing, duplicate-submit
  suppression, bounded captured references/labels, cancellation, stale/read-error recovery, malformed
  references, host-policy contract and actual read-only register retry.
- Installed SQL: five passed at `033834-RuU8XL`, input `f66489055c45`; restored five passed at
  `034458-0sCTDP`, input `5f42e7b7a377`. Includes replay/stale all-or-none, pending/split/null/missing/
  archived/foreign refusal, manual balance/clearing/statement preservation, and a deterministic
  competing lock changing the later row without partially confirming the earlier one.
- Row-lock negative: `034152-y131zS`, input `1ffcf543a0b3`, one failed / four passed. The disposable
  SQL fixture intercepted only this statement to remove its row lock. Stale confirmation returned
  true and the test failed. Production SQL was never changed; the fixture interception was restored.
- RLS negative: `034252-mWZhGy`, input `80fddabb88c2`, one failed / four passed. Disabling transaction
  RLS exposed the synthetic foreign row; it was re-enabled in finally and the fixture restored.
- Focused installed browser: `034456-HUG3aV`, input `5f42e7b7a377`, one passed / 13 unrelated flows
  skipped. Real cancel/confirm, stale competing owner categorization, failed refresh retaining the
  block, explicit fresh read, keyboard, reload and 320/390/768/1440 light/dark/Sage all exercised.
- Host-guard negative: `034817-bnZxlv`, input `0c5936e98dd4`, one failed / 13 skipped. A temporary
  synthetic manifest experiment switched only this tool to routine auto execution. The required host
  dialog did not appear; the screenshot showed the synthetic A/B rows actually confirmed. The
  always-confirm manifest, rows confirmation key and original family policy were restored.
- Initial full development browser `034058-vod4bI` failed six / passed eight after a read was rejected
  by the existing bounded pattern worker; the first split never happened and later fixture-dependent
  expectations cascaded. The new confirmation flow itself passed. Resource contention is a plausible
  cause given the 100 ms worker deadline and concurrent heavy foundation run; this is an inference.
  No security timeout was increased, no rejected write retried, and no failed test was counted green.
- Repeated after the heavy suite ended, full installed browser `035216-sTSGxF`, input `58101a5797ae`,
  passed all 14 flows. Source stayed frozen during that run. It includes explicit offline register
  retry, the restored host guard and all earlier Finance flows. Full static completed rc=0 during
  development. Root, test and module types plus scoped lint passed. Clean committed receipts are next.

Screenshot names `finance-confirm-review-<theme>-<width>.png`, `finance-history-export-*` and
`finance-ledger-net-worth-*` remain outside the checkout. All use synthetic data; nothing is deployed.

## Repository aggregate and limits

Clean `7558098f`, input `dae54373593c`, full foundation `033211-vxi3N1` ended rc=1:
1,614 unit files / 19,518 tests passed; 21 files / 277 tests failed; three skipped. Static passed.
All 277 normalized failure identifiers match clean `3868564e` / `025417-pHZUqY` exactly; both
identifier lists hash to `a89f959b717a129612f25446070b171f25174075fd6a5261e83d99178bab5125`.
None are Finance. Failures are Computer trusted-root/native/ownership/signing/auth fixtures, Sports'
unavailable bundled browser, and three vault ACL fixtures using an unmapped UID. Official ACL tools
and the supported system-Chromium override recovered earlier setup failures. Do not weaken guards or
substitute an unsigned browser path to manufacture green. The wrapper migrated its disposable server;
the aggregate's later migration/UAT/full-integration stages did not run after units failed. CI status is unverified.
This receipt predates captured confirmation and must not be reused as that change's aggregate proof.

Use official pnpm 10.6.2 and the system Chromium, with the recovered official ACL tools on task PATH.
DB-touching commands run only through the verify-gate skill and disposable run-gate containers. Each
run uses one sentinel-based wait-follow call; no process-name polling or piped gate exit codes.
Do not modify a checkout while its frozen gates are running.

## Next actions

1. Commit/push captured confirmation, run clean installed SQL/browser checks, then the repository
   aggregate on that frozen commit. Keep no removed guard or uncommitted test experiment.
2. Fix manual net-worth projection scale: the current daily-row SQL can exceed the platform's 5,000
   returned-row limit across long multi-account histories. Prove the failure with synthetic history,
   aggregate into month-sized projection records without increasing the row/byte/time caps, and keep
   exact daily source validation, owner isolation and the public daily-movement contract.
3. Manual account metadata/lifecycle and explicit linked manual transfers remain high-value gaps.
   Preserve reconciliation and owner/currency boundaries, and do not confuse recording a manual
   transfer with initiating a real bank transfer. Tracking/loan/FX semantics need separate design.
4. Canonical rule management / awaited individual-write and undo paths, credit-card payment reserves,
   recurring calendar/one-off edits, balance-history import and investment holdings remain incomplete.
   Provider/household capabilities require their actual agreements and privacy designs, not mocks.

## Captured confirmation: clean committed checkpoint

`3c620d58657b11d1c862d560e6e41626f9842315` is pushed, unmerged. Clean input `bf68260e49dc`:
installed browser 14/14 passed (`040051-Lp9u1E`) and installed SQL five passed (`040359-pcKxTO`).
Its full aggregate is running at `040401-c9zwQ0` on the frozen detached checkout; do not modify that
checkout, call it green, or substitute the earlier export receipt. Its existing sentinel wait is open.

## Manual net-worth history projection

Design: [month-sized history projection](../specs/2026-10-30-finance-history-projection.md).

A real 6,001-date manual ledger reproduced `row_cap_exceeded` with the old daily SQL projection:
`040537-fvWPMv`, input `45ad15d90355`, six passed / one failed. An earlier fixture attempt hit the
SQL literal prefilter; the synthetic digest was changed to a bound parameter before accepting the
row-cap reproduction. No classifier or platform cap was changed.

The SQL now aggregates exact daily numeric strings and validation flags inside account/month
records, each containing at most 31 daily movements. The store explicitly flattens date, string cents
and validity into the same domain API; names/notes never enter it. Lifetime carry and all original
dates remain, with no balance substitution, new cache, migration, tool or provider-policy change.
The 5,000-row, 5 MiB and execution-time limits remain active; extreme histories can still exceed
these bounds and are not claimed unlimited.

Development results: seven installed SQL cases first passed (`040631-Ss3pdo`, input `0f0f094f4a9e`),
then an eighth exact-cent case passed with all eight (`041451-we2MKQ`, input `763df9aa4d05`). That
case carries the odd string `18014398509481981` through real monthly JSON aggregation and produces
the correct safe signed balance; it would lose a cent if encoded as a JS number. The long-history
case preserves all 6,001 movements, leap day and the exact pre-window/current 93,999-cent total.
Owner RLS negative `040821-9pt7xR`, input `2288a11dfbef`, failed one / passed six as expected:
without transaction RLS the synthetic 1,000-cent owned movement became 5,000. The guard was
re-enabled in finally and the fixture restored. No removed guard remains.

Focused Finance: 63 files / 625 unit tests passed. Full static, root/test/module types and scoped lint
passed during development. A focused installed net-worth flow (`040820-nq0HyS`) passed with 13
unrelated flows skipped. The manual-only owner now has an offsetting posted expense/refund pair,
so its real monthly projection is nonempty while the expected EUR total stays unchanged. The final
UI helper also checks those owned posted records explicitly. Final committed SQL/UI receipts are
next; do not reuse a development fingerprint as the final one.

Next implementation: reviewed manual account rename/close/reopen, retaining financial history,
opening/currency/type immutability, safe zero/reconciled closure and concurrent-entry protection.
Explicit transfer links and the rule/individual-write gaps remain separate work.

## Manual account lifecycle continuation

Design: [reviewed manual-account lifecycle](../specs/2026-10-30-finance-manual-account-lifecycle.md).
Own manual ledgers now have captured rename/close/reopen with mandatory host confirmation. Closing
requires stored and reconstructed zero, valid original entries, no future entries, today's statement
or a pristine zero opening, and no future bill references. Original amounts, opening/type/currency,
statement locks, monetary ledger revision and balance observation time are retained. Closed rows
keep history/export/report access and reopening. Provider/shared accounts have no manual controls.

Bill attachment locks the account and advances its MVCC dependency version without changing money
or its observation date; this prevents closing against a snapshot that missed a concurrently attached
plan. An ending plan may stop sooner without discarding recorded occurrence decisions. Upcoming
shows linked accounts and distinguishes future stops from already stopped plans.

History links initialize validated month/account filters with an explicit own-only register scope.
Cancellation keeps the captured account and rename draft. Stale/ambiguous saves block resubmission
until an explicit fresh successful read; no financial adjustment or silent write retry is invented.

Development evidence on design base `03403a56` (final committed verification still pending):

- 64 focused unit files / 638 passed: handlers, host date boundaries, invalid input, stale status,
  strict manifest/always-confirm contract and owner-only history filters.
- Root test types and Finance module types passed. Initial broad `test:unit finance` incorrectly
  selected integration suites as well: DB gate guards refused before database access. It is a failed
  invocation, not a Finance pass. The explicit `tests/unit/finance-` and
  `tests/unit/external-module-finance-` filters above are the corrected run.
- SQL lifecycle eight passed: `044323-2dGo8V`, input `9d4b6dc395ee`; bill regression eight passed:
  `044650-9cLZ4G`, input `c1423272b26f`. Exact metadata preservation, pristine/current-statement
  closure, stale/replay, history, reopen locks, future/corrupt ledger refusal, provider/foreign/admin
  refusal and held-lock entry/plan races are covered.
- Installed browser one passed / 14 unrelated flows skipped: `044619-RUxnJj`, input `c1423272b26f`.
  Actual blocked nonzero closure, cancel/save rename, close/reopen, stale other-tab rejection,
  draft-preserving fresh review and own history navigation. Screenshots cover 320/390/768/1440
  in light/dark/Sage. The first browser run failed on a mistaken test-only disclosure label;
  the corrected test passes. No application response mocks or live bank data are involved.
- Dependency-version negative: `044704-vdmbOJ`, input `dd5729768bbc`, two failed / six passed.
  The disposable fixture intercepted only bill creation SQL to omit its no-op account touch.
  The held plan race then wrongly closed the account. Production SQL was never changed; fixture
  restored. This establishes why a row lock alone is insufficient for an old statement snapshot.
- Ownership negative: `044740-66ZCET`, input `178eb3952b95`, foreign review became visible with
  account RLS temporarily disabled inside the disposable fixture. RLS re-enabled before teardown;
  fixture restored. One failed / seven passed; restored final receipts are still required.
- A development static run was invalidated by a temporary negative-control fixture formatting
  warning; final restored lint/format/static checks must be rerun, never counted as green.

Previous clean aggregate `040401-c9zwQ0` on `3c620d58`, input `bf68260e49dc`, completed rc=1:
1,615 files / 19,526 tests passed, 21 files / 277 tests failed, three skipped. The complete normalized
failure identifiers match the preceding `033211-vxi3N1` exactly (comparison of sorted unique FAIL
lines SHA256 `5e9142647bef82ce34f207f569a547f05e62875a239f6dcb0e5d5e8315f80f1f`).
These remain the recorded Computer ownership/native prerequisites, Sports bundled browser and
unmapped-UID ACL baseline. No Finance failure appears. Later aggregate stages and CI e2e remain
unrun; this receipt predates lifecycle and is not its final aggregate proof. Monthly-history clean
static `042553-4cR8xV` completed rc=0 on `ccb8a8b3`.

Next: restore and prove the account confirmation guard, finish static and installed verification,
commit/push this bounded slice, then address explicit linked transfers and awaited individual/rule
writes. Credit-card reserve budgeting, investment holdings and provider-dependent coverage remain
separate gaps; do not label the overall product as universal parity.

Host-confirmation negative `044753-RKJqQf`, input `093174ac3cc8`: one failed / 14 skipped. A
synthetic manifest temporarily allowed routine auto execution for only account-update. The host
dialog never appeared and the debug screenshot showed the renamed account, proving the metadata
write had auto-executed. Mandatory confirmation, operation keys and original family policy restored.
Phone inspection prompted tighter dialog spacing with unchanged semantic typography/colors.

Further implementation and current gate status: [linked-transfer checkpoint](2026-10-30-finance-linked-transfers-checkpoint.md).
Manual lifecycle implementation was committed/pushed as `6ee3d8db`; design and diagnostic/fixture
follow-ups through `1e5a9a98` are also pushed. Its clean SQL eight passed at `045043-dgiF4C`,
input `02876b121391`. The later root-type fixture mutation was fixed without weakening readonly
ports. Full-browser rate-limit diagnostics and the pending clean aggregate are detailed above.
