# Linked transfers checkpoint — October 30

Branch `task/finance-parity-20261028`; commit and push authorized, no merge/deploy/PR publication,
real credentials, bank connection, production data change or live financial action. All data below
is synthetic and every database run used the repository's disposable gate wrapper.

Design: [linked manual transfers](../specs/2026-10-30-finance-linked-manual-transfers.md).
Broad acceptance: [parity matrix](../specs/2026-10-28-finance-parity.md). Earlier receipts:
[lifecycle continuation](2026-10-30-finance-parity-checkpoint.md).

## Implementation boundary

A reviewed movement between two owned active manual cash/card ledgers in the same supported currency
creates one immutable event, two durable linked entries and both balance changes atomically. New
module migrations 0031/0032 add owner foreign keys, deferred pair-existence checks and protected
transfer-leg constraints; previous migrations are unchanged. Stable operation identity and financial
payload digest make identical retries harmless and conflicting reuse explicit. Account versions,
ordered row locks, date/opening/statement/archive/source/currency and exact safe-cent checks guard
the write. A card payment lowers cash and amount owed; inverse movements use the same sign rule.

No bank instruction is sent. Loan, asset, provider, shared-owner and FX endpoints, matching existing
entries, editing/reversal and credit-card reserve budgeting remain separate gaps. Generic leg names
avoid putting an unshared counterparty account's name into a shared transaction. Activity contains
identifiers. History and both CSV exports retain the durable link; amounts and report/funding math
use the original signed ledger. Category/split controls cannot turn a linked leg into spending.

A linked leg never participates in legacy heuristic pairing. Otherwise an unrelated equal purchase
could be mistaken for its counterpart. The link is retained in opted-in household projections, with
notes still omitted, so the same arithmetic rule applies there. Existing unlinked inference remains.

Accounts has Record transfer, currency-scoped endpoints, exact amount/date, clearing choice and a
captured review of both named ledgers and resulting balances. Host confirmation is mandatory.
Cancellation retains the captured operation. Stale/ambiguous results retain inputs, block submission
and require fresh reads; a fresh read preserves the operation identity for a safe explicit retry.
Installed screenshots cover light/dark/Sage at 320/390/768/1440; phone dark was inspected.

## Verification and negative controls

These are development receipts on base `1e5a9a98` with dirty input fingerprints, not substituted
clean-commit receipts. Final committed verification remains necessary.

- Final focused Finance unit suite: 66 files / 657 passed. The authoritative-link regression was
  separately observed red (one failed / 15 passed), then green (16 passed), including its shared
  projection. The full focused run includes that correction.
- SQL nine passed at `050517-hF8AbV`. Expanded SQL eleven passed at `051302-mRImoc`, input
  `f1e04b75bb7d`; twelve passed at `051749-mjRunG` after adding inverse card movement. Includes
  maximum safe cents, no-half-pair overflow, replay/conflicting reuse, category/split protection,
  foreign/admin refusal, same UUID under separate owners, deterministic opposite transfers and
  held-lock close/reconciliation conflicts. The held-query observer matches the initial CTE because
  PostgreSQL truncates long activity query text; changing that observer fixed a fixture failure.
- Installer/backfill/parity: three files / eleven passed at `051348-wVW3H9`, including 32 module
  migrations and FORCE RLS on the declared transfer table. Migration files each contain one SQL
  statement, as required by the existing module wire contract.
- Initial lock negative `050609-0COK1d`, input `eebf712a3540`: one failed / eight passed. Fixture
  interception removed only the transfer statement's row lock; both stale opposite writes succeeded.
  Expanded negative `052046-4fdtUD`, input `f920bf4edea6`: three failed / nine passed. It also wrongly
  accepted a transfer after a competing close or completed statement. Production SQL never changed;
  the fixture was restored after each experiment. Restored final SQL twelve passed at
  `052355-GjEwk6`, input `ca3d7ee87c38`.
- Transfer-event RLS negative `050649-kiY4wc`, input `2a4c74147cc0`: one failed / eight passed.
  Disabling only that table's RLS made the second owner's same UUID see the first owner's event and
  return conflict. The fixture re-enabled RLS before teardown and was restored afterward.
- Focused installed browser `050807-1XqVs3`, input `898fa1676566`: one passed / fifteen unrelated
  flows skipped. Actual cancel/save, currency exclusion, cash/card movements, stale competing entry,
  fresh review, persistence, protected register legs and linked CSV were exercised. No response mocks.
- Host-guard negative `050937-tl0jKi`, input `134a03036c36`: one failed / fifteen skipped. A temporary
  synthetic manifest allowed routine auto execution for only transfer-create. The guard did not
  appear; its debug screenshot showed cash 87.66 and savings 12.34 after auto execution. Original
  confirmation policy, endpoint/amount keys and original family policy were restored.
- Scoped lint passed. Root test types exposed overly narrow fixture literals and a Promise tuple
  annotation; those were corrected, and the direct test-type run completed rc=0 afterward. The
  earlier full static run passed lint/format/invariants but stopped on those fixture type errors;
  it is a failed run, not a static pass. Final static/aggregate checks remain required.

## Full-browser diagnosis

The original fixture gained two legitimate owned net-worth entries. Its old empty-member assertion
was corrected to require exactly those entries, not weakened to accept arbitrary rows. New lifecycle
and transfer workflow actors are isolated. Their synthetic SQL migration markers follow existing
fixture setup; this does not establish native migration/onboarding or live bank coverage. Existing
reconcile-job migration contracts are preserved.

A complete 15-flow run on clean `1e5a9a98` (`045911-d44L1o`) reported one failed / fourteen passed.
Captured diagnostics proved a normal 429 on account-review with Retry-After 17. No rate limit was
raised. Busy read feedback now reports the server wait; account/transfer retry buttons wait without
automatically issuing requests or retrying writes. Two unit tests prove the wait and explicit retry.

Expanded 16-flow `051305-qEs6tX` passed fourteen / failed two on fixture assumptions: immediate
closed-action counting raced the refresh, and a default household feed legitimately included a
shared row. The test now awaits disappearance and requests ownOnly for the owned ledger assertion.

Expanded `051748-SdlQM4` passed thirteen / failed three during the concurrent heavy foundation run.
Flex's read explicitly returned 400 “Pattern matching failed and was rejected”; manual creation
failed and a later report test depended on that missing manual row. New lifecycle and transfer flows
passed. The existing external validation worker has a 100 ms invocation deadline including startup.
Contention is a plausible explanation, not proven for every failure. No timeout/trust guard changed,
no rejected write was automatically retried, and failures are not counted green. Run the restored
full browser serially after heavy checks end, with source frozen and diagnostics preserved.

## Pending checkpoint actions

1. Prove restored final SQL, complete focused units/static and commit/push this bounded slice.
2. Freeze the committed source for full installed browser, relevant regressions and aggregate checks;
   distinguish exact commits, fingerprints, passes/failures and unrun CI stages.
3. Existing lifecycle aggregate `050444-DT3I8N` is running on clean `1e5a9a98` in the separate
   lifecycle verification checkout. Never edit that checkout while its gate is active. Diagnose its
   terminal failure identifiers against the earlier 277-case baseline before calling them unchanged.
4. Continue awaited individual/category/rule workflows and the remaining staged matrix. Broad
   transfer capability, credit-card reserves, investment holdings and provider agreements are not
   complete merely because this bounded manual movement works.

Screenshot basenames: `finance-transfer-review-<theme>-<width>.png`, `finance-account-close-*`.
They remain outside the repository; no real financial data or credentials are involved.

The final test-type run after correcting the fixture tuple/literal annotations completed rc=0.
Source is ready for a reviewable implementation commit; final committed static, browser and
aggregate receipts are the next step, with no merge or deployment implied.
