# Finance parity implementation checkpoint

Date: 2026-10-28. Branch: `task/finance-parity-20261028`. Base:
`e41aa10f551f9a13a1c2f8b53d356b7186245e4f`. Work remains local and unpublished.
Implementation commits: `f989ba06` and `a419911d`.
Use the isolated Finance worktree, not the original checkout. Repository paths below are
relative to `~/Jarv1s`. No bank was connected, no credentials created, and no production
data, deployment, account settings or financial transactions were changed.

The [audit, official sources and acceptance matrix](../specs/2026-10-28-finance-parity.md)
remain the scope contract. Historical PRs #3269 and #3349 are merged. This checkpoint
implements three slices; it does not establish YNAB/Monarch parity or live acceptance.

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

The UI uses current Park Press/Park Pass foundations: Archivo, shipped semantic tokens and
SDK primitives, warm paper surfaces, labeled controls and tabular amounts. Module CSS adds
layout only. The manifest version is `0.7.0`; the app map describes the bounded features and
their limitations. External-module app-map schema supports descriptions, not separate error
or remediation arrays; prerequisite/conflict behavior is described in those entries.

## Verification and evidence

- Finance unit tests: **46 files / 451 tests passed**, using exact `tests/unit/*finance*.test.*`
  paths plus the cross-cutting typography/empty-state audit. A separate Park Press integration
  audit passed all 13 tests. Initial regressions and the currency-conflict regression were
  observed failing before their fixes.
- Isolated Finance integration gate: **3 files / 10 tests passed**. It installs the module
  migrations, exercises storage migration and owner-scoped RPC, races two split editors,
  rejects stale/foreign-owner writes, verifies one activity event, and preserves allocations
  during a stale provider upsert. Receipt: `moss_finance-20261028-061016.log`, rc 0,
  input fingerprint `a74a8530db84`, Node 24.19.0 / pnpm 10.6.2. This rerun includes currency
  comparison in the atomic save. The subsequent manifest-test expectation change is test-only.
- Repository static checks: lint, Prettier, file-size, design tokens, UI classes, migrated
  sections, UI catalogue, ambient-date/password/package/migration checks, root/test/web/module
  TypeScript and app-map build passed. The full foundation gate is being recorded below.
- Actual production-built Finance browser fixture: **11 scenarios passed** at 320, 390, 768
  and 1440 pixels, light/dark; filters, exact split total, no horizontal overflow, Escape/focus
  restoration, empty/loading/error views and no page exceptions. Screenshots were inspected.
  All financial records are synthetic. This is not an installed live end-to-end acceptance run.
- Initial integration attempts failed because a fresh checkout lacked the generated app map,
  then because the queue expectation omitted the new split queue. Both were fixed and the
  isolated gate reran successfully. A broad unit filename filter inadvertently matched
  integration files; the database guard blocked that path (and connections were refused).
  The exact unit-path rerun passed. Do not use the broad `finance` substring as a unit selector.

Full foundation receipt: `moss_finance-20261028-055443.log`, **rc 1**. The unit phase
reported **1,588 files / 19,263 tests passed**, **26 files / 281 tests failed**, and 16 tests
skipped. It completed and removed its database container. Reported failures included Computer
ancestor ownership/IPC checks, missing `getfacl`/`setfacl`, and an absent Playwright bundled
browser. A focused diagnostic reproduced `Unsafe Computer ancestor`: this sandbox's filesystem
ancestors have UID 65534 rather than an accepted root/current-user owner. No security checks
were weakened to make the gate pass.

Two relevant failures in that broader run were stale search-label and Finance-version
expectations in typography/Park Press tests. Both were updated and their 19 combined tests
passed. The earlier gate receipt is not a green final-commit receipt: currency-save protection
was completed afterward and rechecked by the focused unit/database/browser and full static
runs above. `verify:static` passed again after the currency changes. The remaining broad
failures were not repaired as part of Finance. Post-unit UAT-seed/full integration phases did
not execute; the separate Finance integration gate did. CI, repository e2e, and installed
live-UI acceptance have not run. No PR or live-proof claim is made.

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
`split-390-light.png`, `split-1440-dark.png`, the three state images and `inspection.json`.
Gate databases use throwaway containers and the script removes them at completion.

## Remaining scope and next action

The next implementation should start with **currency-safe summaries and a manual ledger**:

1. Keep accounts and reports separated by currency until a deliberate FX policy exists.
   Existing budget/report aggregates can still mix currencies; historical ready-to-assign
   still uses current balances. These are existing correctness gaps, not completed work.
   Also audit safe-integer accumulation across entire reports, not only individual values.
2. Add a source distinction for manual accounts and transactions without weakening owner RLS.
   Define opening balance, asset/liability sign, posted versus cleared/reconciled, account
   archival, immutable import identity and audit behavior before deriving a ledger balance.
   Preserve existing provider IDs, balance snapshots and KV backfill. Allocate the next
   migration after checking current main and open PRs again.
3. Build CSV preview/mapping and a validated atomic import batch over that ledger. Parse dates
   without timezone shifts, show sign/currency explicitly, identify exact re-imports, and let
   the user review possible duplicates. Synthetic data only; no bank or provider setup needed.
4. Reconcile against an explicit statement amount/as-of date using cleared posted entries;
   adjustment preview must show its ledger impact. Do not rename snapshot equality as
   reconciliation. Then proceed to targets/goals, recurring obligations and flexible budgets.

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
workspace.** Filter and export your loaded transactions, review possible duplicates, and
divide posted purchases between categories with exact totals and confirmed saves.
