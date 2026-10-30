# Finance monthly refill target checkpoint

Authorized continuation of #1144/#1148. Design: [monthly refill targets](../specs/2026-10-30-finance-monthly-refill-targets.md).
The isolated Finance parity branch may be committed/pushed; no merge, PR publication, deployment,
production financial data, live bank action or credential creation.

## Implemented boundary

Monthly refill is explicitly selected, never a conversion of an old monthly contribution target.
It counts positive prior carry plus net current assignments. Current spending/refunds do not
change that contribution plan; ordinary available money and next-period carry still reflect them.
Future carry is provisional. BigInt intermediates and exact safe-number results refuse overflow;
negative assignments, absent envelopes and excess balances retain the existing ledger semantics.
No automatic funding, excess withdrawal, bank transfer or new account/receipt is created.

Additive migration 0038 extends target kind/shape constraints; 38 migrations / 20 owned tables.
Refill requires positive money, no date and no weekday. Other kinds retain their constraints.
Historical versions stay intact. Existing revision/fingerprint saves, category/archive/pool rules,
current-month selection, ready money, overspending priority, assignment bounds and mandatory host
confirmation remain. Funding changes assignments/activity atomically through the existing writer.

Park Press Add/Edit retains the explicit kind on reload and explains carry, spending/refunds and
provisional future guidance. Rows and selection describe the basis. Eligible suggestions now
precede reached/unavailable targets, preserving their reasons while keeping actionable amounts
visible on phones. Existing primitives and compact paragraph layout; no new color/control/CSS.
The app map describes refill within its existing sixteen features and thousand-character limits.

## Verification so far

Node 24.19.0 / pnpm 10.6.2; disposable gates and synthetic data only:

- Red domain run: six failed / three passed before refill support. Restored target domain batch:
  3 files / 33 passed. Distinguishes carry/assigned from spending, refunds and dated balance;
  checks negative assignments, excess balances, absence and unsafe combined totals.
- Initial full Finance units: 770 passed / 2 manifest failures. A seventeenth app-map feature
  exceeded the existing ABI limit. Folded the facts into existing budget declarations; did not
  raise the limit or remove any existing capability. Restored manifest units: all 16 passed.
- Final Finance units: 80 files / 772 passed. Native editor pins kind retention, no date/weekday,
  clear carry/refund copy, metadata-only packet and rejected invalid shapes before storage.
- Full repository lint, typecheck, formatting, file-size and UI-class checks passed. The only
  change after the first static launch was the metadata-only app-map folding; its manifest
  contract, final units, formatting and actual native installation passed afterward.
- SQL 124942-FJfdKY, input 5a3074a080f8, passed 4 suites / 26 cases. A real envelope with carry
  9500, assigned 500 and spending 1200 asks exactly 2501 toward a 12501 refill. Funding preserves
  accounts, receipts, target history and prior ledger. A refund of 500 leaves the current plan
  met and produces a 700 next-month suggestion. All 38 migrations, historical compatibility and
  invalid refill date/weekday/zero shapes pass. This run preceded the manifest-only ABI fix.
- Installed browser 125155-59W7c2, input ea5758173db2, passed 4 selected flows / 17 skipped,
  exit 0. Actual approved/open signup/onboarding/migration, merchant setup and selected funding
  include refill create/reload, no metadata assignment, eligible-first order, cancellation and
  real host-confirmed exact assignment. Canonical account/transaction comparisons stay exact.
  No response/storage mocks establish this native flow.
- Inspected dark 320px editor and light 320px selection screenshots. Automated bounds cover
  light/dark/Sage at 320/390/768/1440 for editor, selection and review. The eligible Utilities
  amount/basis is above reached targets. Artifacts: finance-target-funding-refill-{editor,
  selection,review}-{theme}-{width}.png.

The clean prior weekly 6b7a3573 passed 761 Finance units, complete 153 backend cases and all
21 installed flows, plus all static checks. Its separate detached aggregate 124315-sSpn8n is
pending; no result from it establishes this refill commit. The prior clean transfer aggregate
failed with exactly the earlier 277 baseline identities and no additions. Aggregate failure
must remain explicit; later chained DB stages were unrun when units failed.

## Next actions

Commit/push this checkpoint, then run complete refill backend/native regressions on the clean
commit. Retain their own receipts. Continue with pending-replacement review correctness: the
synthetic reducer reproduction shows that a purported pending link can consume a posted source,
and a changed-amount pending replacement can remain confirmed. Official provider docs additionally
allow pending removal and posted addition on separate pages. Design and test that boundary before
claiming provider convergence. Larger atomic/concurrent provider changes, credit payment reserves,
account-linked/debt/custom-period goals, household writes, richer reporting and investment holdings
remain separately staged. Keep the [parity matrix](../specs/2026-10-28-finance-parity.md) Partial.

Clean refill e13fb5b0 / decedc828d1d: complete backend 125645-atWZXh passed all
154 cases in 16 suites (opt-in browser skipped separately). Full installed browser
125935-1xHcOA passed all 21 flows, exit 0, including weekly/refill create, reload,
eligible-first selection, cancel and confirmed funding. No application code changed
after these runs. The next committed design addresses durable pending handoffs.
