# Reviewed metadata checkpoint — October 30

Branch `task/finance-parity-20261028`; commit and push authorized. No PR publication, merge,
deployment, real credentials, bank connection, production data change or live financial action.
All database tests used disposable gate servers and synthetic financial records.

Design: [reviewed metadata](../specs/2026-10-30-finance-reviewed-metadata.md).
Broad status: [parity matrix](../specs/2026-10-28-finance-parity.md).
Previous committed proof: [linked transfers](2026-10-30-finance-linked-transfers-checkpoint.md).

## Implemented boundary

SQL category/chat/legacy job handlers read captured transaction versions and apply one metadata-only
batch, with identifier-only activity, for one to 200 owned unsplit unlinked records. Category-only
edits preserve the current note; explicit empty notes clear it. Financial, date, posting, clearing,
statement and balance fields are never rewritten. Stale, missing, split, linked, foreign, duplicate
or unavailable-category requests save nothing. Pending metadata keeps its existing compatibility
behavior. SQL-only revision reads do not change ordinary transaction persistence or household DTOs.

Category Undo restores the earlier category, reversal activity and original undone mark together.
It preserves notes and money, supports restoring uncategorized/needs-review state, and rejects stale,
repeated or foreign changes. The native single-row bulk writer retains per-record category undo data.
Existing KV compatibility and merchant-rule Undo remain on their old paths.

Provider-window persistence preserves the saved user category/provenance and current notes while
accepting legitimate same-ID bank financial corrections. Changed amount/currency requests review.
Manual rows are not rewritten by provider-window persistence. Existing split protections remain.
Different-ID pending replacement and concurrent sync pages have separate convergence acceptance;
this does not prove live provider coverage.

Owned posted unsplit individual edits to non-transfer categories use a captured native review and
the existing mandatory-confirmation atomic category tool. Success waits for persistence. Cancellation
keeps the review; stale/ambiguous outcomes block submission until explicit successful fresh reads.
Immediate duplicate submission is suppressed. The category picker follows fresh saved values.
Pending/KV and merchant-rule UI queues remain asynchronous; queue acceptance is not persistence.
Rule-plus-category writes remain separate and canonical rule management is still missing.

## Development verification

Receipts below use base `f5954dce`, with dirty fingerprints explicitly distinguished from clean
committed proof. Node 24.19.0, pnpm 10.6.2 and system Chromium were used.

- Same-ID provider regression first failed at `054232-B3p2Za`, input `90776781e2c7`: a stale sync
  erased the newer user category and note. Preservation was then implemented; subsequent runs pass.
- Metadata SQL grew from six to eight to eleven cases. Final expanded `060036-whS48r`, input
  `ca6efa808693`: fourteen passed, exit 0. Includes exact field preservation, note semantics,
  all-or-none stale batches, bounds/duplicates, owner/admin refusal, archive/split/linked refusal,
  pending compatibility, manual exclusion, held-lock financial corrections, atomic Undo including
  null restoration, native writer undo data and actual SQL-backed chat/job/Undo handlers.
- Apply-guard negative `055043-Sv2QSW`, input `181a6ae9a4e0`: two failed / seven passed. Fixture-only
  SQL interception removed the revision predicate; stale batches and the held-lock edit wrongly
  succeeded. Production SQL never changed. Restored nine-case SQL passed at `055131-s2OEJV`.
- Initial Undo negative `055854-0yly7V` was an invalid experiment: removing its only `$2` use caused
  a PostgreSQL parameter-type error. It is not behavioral proof. Corrected fixture interception
  retained `$2::text` typing while removing the comparison. `055955-S79Rmm`, input `b2928a1e94c6`:
  one failed / thirteen passed because stale Undo wrongly succeeded. The fixture was restored;
  final fourteen-case SQL above passes. All temporary negative controls are removed.
- Full installed browser `060038-jjbZsh`, input `ca6efa808693`: seventeen passed, exit 0. Actual
  auth/API/installed worker/RLS with no application response mocks. Individual review covers real
  host cancel/save, reload, competing financial correction, stale refusal and explicit fresh recovery.
  All earlier budget, bill, flex, import, ledger, reconciliation, export, account, transfer and report
  workflows remain in that complete run. The first focused run failed on the fixture's incorrect
  “Dining” label; the shipped category is “Dining & coffee.” The assertion was corrected.
- Focused Finance unit suite: 67 files / 661 passed. Includes captured single-row labels/references,
  cancellation, immediate duplicate suppression and uncertain/stale blocking. Scoped lint and module/
  root-test type checks passed again after the final SQL/handler additions. Final modal hardening
  captures the previous label and prevents immediate dismissal during submission; its affected
  two-file / seven-test suite also passed. Full committed verification remains the next step.
- `verify:static` passed on the eleven-case stage, including lint, format, invariant checks, all
  typechecks and app-map generation. Subsequent additions require final committed static/aggregate
  verification; do not reuse that earlier full-static receipt as an unchanged final input.
- An initially overbroad unit-file filter also selected integration files. The database guard
  blocked them before access. The corrected `tests/unit/finance-` and `tests/unit/external-module-finance-`
  filters produced the focused unit pass above; the failed overbroad run is not counted green.

Screenshot basenames `finance-individual-review-<theme>-<width>.png` cover light/dark/Sage at
320/390/768/1440. Phone dark and desktop light were visually inspected. Files remain outside the
repository; shared Park Press primitives/tokens provide the styling.

## Next checkpoint

1. Commit and push this bounded slice; freeze its committed source for full static/foundation and
   installed-browser confirmation. Keep receipts tied to their actual commit/fingerprint.
2. Verify native fresh-user startup through the existing approved-user reconciliation and actual
   migration worker, without preseeded financial records or a fabricated migrated marker. Approval
   already calls the platform's user-job reconciliation hook; reuse that contract.
3. Implement reviewed canonical merchant-rule list/edit/disable/preview while preserving legacy
   rules, category history, confirmation, user overrides and metadata-only queues. The latest official
   [Monarch rules guide](https://help.monarch.com/hc/en-us/articles/360048393372-Transaction-Rules)
   also covers criteria/actions/order and optional retroactive application; exact normalized-payee
   management alone must remain partial relative to that broader capability.
4. Continue the matrix: credit-card reserves, broader goals, existing-record transfer matching,
   household co-editing and investment/provider coverage have separate acceptance or access needs.
   No universal parity, live-bank coverage or production deployment is implied.

The clean transfer aggregate `053648-Oahav4` finished exit 1 with exactly the earlier 277 failure
identifiers and no Finance additions. It passed static checks and 19,562 tests; later aggregate DB
stages were unrun after the unit failure. Current metadata source needs its own frozen aggregate.
