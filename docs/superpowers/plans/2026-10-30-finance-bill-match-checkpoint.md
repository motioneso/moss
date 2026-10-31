# Bill matching across month boundaries: checkpoint

Later continuation: [reviewed bill-entry checkpoint](2026-10-30-finance-record-bill-entry-checkpoint.md)
implements the formerly missing record-from-bill slice and supersedes that next-action note below.
Earlier receipts retain their exact tested inputs.

Date: 2026-10-30. Branch: task/finance-parity-20261028. Date-window implementation: 170dc61f; review refinement: c788fb17; final test compatibility: e8a10979.
All work is isolated and pushed; no merge, deployment, PR publication or live bank action.
Repository paths below are relative to ~/Jarv1s.

## Delivered

Upcoming now offers existing posted expenses from seven calendar days before and after the
selected month, with the exact candidate dates visible in the match review. A payment posted
September 30 can match an October 1 bill. Projection dates and recurrence anchors do not move.
Nothing is automatically selected, saved or created. Existing account matching, captured-review
and host-confirmation contracts remain in force. Currency, pending, refund, transfer and claimed-
transaction filters and the 1,000-candidate limit remain. UTC calendar arithmetic covers leap
and year boundaries and clamps to supported years. Original and boundary month partitions are
queried even when the transaction month index is empty.

This fixes a bounded matching gap; recurring obligations remain Partial. Creating a manual entry
from a due occurrence is still missing. Bank Bill Sync, real credentials/provider acceptance,
investment holdings/performance and the other recorded gaps are not established by this slice.

## Date-window verification (170dc61f)

- Eighteen focused recurrence/handler cases pass. The empty-index regression was observed failing
  before preserving the original month partitions, then passing after the correction. Receipt:
  /tmp/finance-bill-window-index-red.log; restored receipt /tmp/finance-bill-window-units.log.
- Final installed app gate at clean 170dc61f passed both selected flows, twenty intentionally
  skipped. Receipt 202327-hBUnIp; fingerprint
  87668b7d790a9e0618b3b2c3c46caea534f53dc5ce6594a0d3371baf90248f5e.
  Node 24.19.0, pnpm 10.6.2, disposable PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2).
  Phone/desktop date-range and cross-month selection, persisted actual amount after reload,
  Undo/skip/stop and unchanged ledger responses in both months passed.
- Repository-wide pnpm verify:static passed: lint, format, file size, semantic tokens/UI classes,
  migrated sections/catalogue, ambient dates, development-password/dependency/migration checks,
  all root/test/web/external-module typechecks and app-map build. Receipt:
  /tmp/finance-bill-window-static.log. Final handler/recurrence test edits also passed scoped
  ESLint after the empty-index correction (/tmp/finance-bill-window-final-lint.log). The final
  documentation additions are separately formatted; they are not another production gate.
- The first native development run passed two selected cases, twenty intentionally skipped, at
  fb024467 with nine dirty files, fingerprint
  238e61b80e0dced929341db2841d89b780f0a964ac53ce8065e3e2861a1b77bb,
  receipt 202017-hMNVbE. It preceded the empty-index correction and final test tuple annotation.
  It is superseded by the final clean native receipt, not reused as final-head evidence.
- An initial test fixture used the old timezone property; the fixture now supplies localTimezone.
  Initial typecheck also found a test tuple inferred with optional elements; an explicit readonly
  tuple fixes it. No runtime guard was weakened for either correction.
- The full Finance suite and verify:foundation were not rerun for this bounded continuation.
  Earlier 203-case Finance acceptance and aggregate failures belong to the exact earlier inputs
  in the [card-reserve checkpoint](2026-10-30-finance-card-reserves-checkpoint.md), not this commit.
  CI e2e and actual bank/provider HTTP acceptance remain unrun.

The installed test deliberately moves one synthetic fixture expense to the preceding month
through owner-scoped module SQL, then restores it in finally. The user workflow matches that
existing expense through the real UI/host/API/worker/SQL path, checks reload/Undo/skip/stop, and
compares both months' ledger responses before and after. Provider/credential ports remain the
shared fixture's disclosed synthetic stand-ins; no real bank is contacted. The disposable gate
server and browser close on completion.

[Original inspected phone/desktop screenshots](../evidence/finance-bill-match-2026-10-30/README.md).
[Evidence-linked parity matrix and accepted scope](../specs/2026-10-28-finance-parity.md).

## Explicit candidate review refinement

Implementation c788fb17 keeps every same-account candidate and orders by nearest effective
planned date, then exact expected-amount distance, then date/identity for deterministic ties.
Adjusted dates participate. Nothing is automatically chosen. The review explains the ordering
and keeps variable actual amounts available. No-candidate reads show a practical Transactions /
Check saved bills recovery path, disable the select and Save, and keep Cancel available. Save
also requires the selected identity to remain in the current candidate list. These presentation
changes do not implement automatic matching or create ledger entries.

Verification for this continuation:

- All 38 focused cases in finance-bill-match-candidates, external-module-finance-web-format,
  finance-recurrence and finance-bill-handlers pass. They cover immutable/stable account-scoped
  ordering, adjusted dates, exact one-cent distinctions at safe integer limits, leap/DST dates,
  invalid data rejection, calendar windows and the existing precise money formatting.
  Receipt /tmp/finance-bill-review-units.log. The formatter was already exact and was not changed.
- The native gate at clean d5215bee passed both selected installed flows, twenty intentionally
  skipped. Receipt 203254-Z9aprb, fingerprint
  f0a3e1e07b4774e5e6aae9ad31ce67bbbbe35b97d092568107141d5a29563438;
  Node 24.19.0, pnpm 10.6.2, disposable PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2).
  It exercises an actual empty candidate read after a controlled synthetic pending flip,
  disabled Save/select, cancellation, restoration, explicit choice and the original match /
  reload / Undo / skip / stop workflow. Phone dark and desktop light originals were inspected.
- Initial native receipt 203028-WCJB0H at clean c788fb17 failed one final assertion, one flow
  passed and twenty skipped: changing a fixture row's pending state changes its xmin-based
  review version even after restoring the field. d5215bee now asserts the expected token
  change and exact preservation of every other response field, then keeps the refreshed full
  response as the baseline. The actual matching workflow must preserve that full response,
  including its new version. No financial assertion or runtime guard was removed.
- Initial static checking failed only on the test's toReversed API being newer than the target
  TypeScript library. e8a10979 changes that one test expression to a copied-array reversal;
  all 38 cases pass again. Production code is unchanged after c788fb17; native helper code is
  unchanged after d5215bee. The native receipt is not a gate of e8a10979 or the later docs commit.
- The fresh full pnpm verify:static passes after e8a10979, including lint, formatting, all
  policy checks, root/test/web/external-module typechecks and app-map generation. Receipt
  /tmp/finance-bill-review-final-static.log. The final evidence/handoff additions are separately
  formatted; they do not constitute a new native or full Finance acceptance gate.
- Full Finance acceptance, verify:foundation, CI e2e and actual provider HTTP were not rerun for
  this review-only refinement. Earlier complete Finance/aggregate receipts retain their own
  tested commits; this narrower result does not certify them anew or establish universal parity.

The native fixture restores its pending flag and date in finally; the disposable server and
browser close after the run. No actual bank, credential, production data or financial instruction
was used. Existing account, captured-review and host-confirmation write contracts are unchanged.

[Original review/empty-state screenshots](../evidence/finance-bill-match-2026-10-30/README.md).
Optional synthetic check: open Match posted on an account with no posted expenses; verify the
explanation and disabled controls, then Cancel. Record an already-occurred synthetic manual
expense from Accounts, return and Check saved bills. Reopen: nothing should be preselected;
choose the expense explicitly, confirm, reload and check the ledger still contains it once.

This is a bounded usability improvement. Recurring obligations remain Partial, and the larger
reviewed manual bill-entry flow below remains the next implementation action.

## Manual continuation

Pull task/finance-parity-20261028. Keep the existing additive migrations and do not edit applied
SQL. Use the repository verify-gate skill for every DB-touching command. Node 24.19.0 and pnpm
10.6.2 were used here. Native tests need an installed Chromium via CHROMIUM_PATH; use task-specific
synthetic chat/XDG directories, never production data. Remove MOSS_CHAT_HOME for a foundation run.

Useful commands: pnpm verify:static; pnpm test:unit tests/unit/finance-recurrence.test.ts
tests/unit/finance-bill-handlers.test.ts; scripts/run-gate.sh start --gate
test:integration:finance-bills-live followed by scripts/run-gate.sh wait --follow using that log.
The native gate selects two flows; twenty skipped tests are not twenty additional passes.

Next larger slice: write the reviewed “Record bill entry” spec against #1148 first. Reuse bill
occurrences and adjustments, owned manual accounts/statement boundaries, captured budget/account
reviews and mandatory host confirmation. Create the ledger entry and match decision atomically,
with an idempotent identity and actual SQL replay/stale/concurrent tests. Offer existing candidates
before another entry; never call this “Pay”, post future expenses or send a bank instruction.
Keep new tests and changes isolated, then rerun native cancellation/reload and static checks.

## Optional synthetic user check

Use a synthetic account only. Record a posted expense on September 30, plan an October 1 bill on
that account, open October in Upcoming and choose Match posted. Check the visible September 24–
November 7 candidate window. Cancel first; then reopen, explicitly choose the expense and confirm.
Reload: the bill should show the actual amount and the expense should still exist exactly once.
No real payment or bank connection is needed.

Release note draft: Fixed — Bill matches across month boundaries. Review posted expenses from the
week before or after a bill's month without creating another transaction.
