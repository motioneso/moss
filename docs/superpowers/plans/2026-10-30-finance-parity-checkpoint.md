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
