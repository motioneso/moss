# Reviewed bill entry: implementation checkpoint

Date: 2026-10-30. Branch: task/finance-parity-20261028. No merge, deployment or PR publication.
Spec f5a16b2f precedes implementation. Code commits: 7677f2d2 (vertical slice), 29ff6802
(blocked-preview clarity and valid confirmation control), a6a17c7b (visible stale recovery and
explicit native read backoff). Source paths are relative to ~/Jarv1s.

## Delivered capability and financial contract

Upcoming offers Record bill entry for a due, unreviewed occurrence on an active manual account
in the working currency with an active expense category. The user reviews the actual date,
exact amount and cleared state. Bill name/account/category stay pinned to the saved plan in
this first version. The preview distinguishes cash balances from debt owed, labels currency,
and checks opening/reconciled-date boundaries, ledger validity, safe cents and existing records.

One dependent SQL CTE statement adds one expense, changes the account balance/revision once,
attaches the match to the original occurrence identity and logs metadata-only activity. Every
effect depends on the captured budget revision/fingerprint and eligible account/plan/category
state. It rechecks schedule membership, effective due date, statement/date/currency/precision,
duplicate and occurrence guards. Existing owner/module ordering precedes the statement snapshot.
A forced failure at the matching trigger leaves no orphan, balance change, activity or policy bump.

Exact completed operations replay unchanged, including with stale review tokens. Changed intent,
removed matches and invalidated links conflict rather than recreate or repair a financial entry.
Concurrent different operation IDs for one occurrence produce one entry/movement/match/activity.
No new schema migration is needed: the existing 23 owned tables and 41 module migrations suffice.
Applied migrations are unchanged. The transient rollback-proof trigger/function exists only in
the disposable test database and is removed by the fixture.

Posted same-account/currency/amount expenses within seven calendar days block convenience
recording, even if already matched. Candidate facts omit private notes and show at most twenty,
with a total/truncation disclosure. This deliberately produces some false positives for genuinely
separate equal expenses; use explicit manual entry in Accounts, then review matching. Matching
still has its documented monthly candidate-window bounds and excludes already-claimed expenses.
There is no automatic deletion, matching, entry, future posting or bank instruction.

Cancel preserves the review and changes nothing. A mandatory host confirmation binds the write.
Stale or uncertain saves preserve captured input, block further writes and require an explicit
saved-state read. Both duplicate and stale messages are visible before the financial facts on a
phone; disabled controls retain an explanation. Shared Dialog owns scrolling, focus and footer.

## Verified receipts

Full Finance at **clean a6a17c7b passed all 223 tests in 19 files**, including all 23 native UI
flows and the new nineteen bill-entry SQL/handler cases. Receipt 220429-zIHHi9, fingerprint
1ec108b81a571ac1c9479bb9677fc171f4fc2d7c8375f930dc1348a269ecb50e.
Node 24.19.0, pnpm 10.6.2, disposable PostgreSQL 17.11 (Debian 17.11-1.pgdg12+2).
The installed flow proves cancellation/no movement before host approval, one recorded expense,
reload, real duplicate refusal, real independent-ledger staleness and explicit recovery. Original
[phone/desktop light/dark evidence](../evidence/finance-record-bill-entry-2026-10-30/README.md) is preserved.
Provider/credential ports are the shared synthetic stand-ins. Actual provider HTTP is unrun.

Earlier focused SQL/module-RPC receipt 214233-G3fiPi passed forty cases in three files at
f5a16b2f with fifteen dirty implementation files, fingerprint
f919991b758166b7445a11586a39dbdfb5aace6c9b33be7b5e4ef4ce9555c64c.
It includes exact replay/conflict, competing identities, late rollback, effective adjustments,
stale captures, duplicate/date/statement/overflow checks, debt signs and generic RPC ordering.
It is historical development evidence; the current full Finance receipt above supersedes it.

Ownership negative receipt 214514-y9WxGo at clean 7677f2d2 intentionally disabled RLS on only
the fixture's transactions and occurrence tables. Exactly the foreign/admin tests failed (two
failed, seventeen passed), observing private replay lookup leakage. No negative mode ships
enabled. The later normal full run passes both owner-boundary tests with the protection restored.

Confirmation negative receipt 215014-NxP1xE at clean 29ff6802 uses only a disposable installed
manifest copy, sets a valid trusted-auto family and removes the mandatory confirmation policy.
The action ran before approval: cash changed 100000→89901, one entry/match appeared and the
policy revision advanced. The exact no-money-before-approval assertion failed (one failed,
one passed, twenty-one intentionally skipped). The production manifest never changed; the
subsequent full run passes host confirmation/cancellation and no-pre-approval-movement checks.
An initial invalid negative fixture (214722-OEvb1X) was rejected before discovery: one suite
failed and all 23 tests skipped. That is not a valid confirmation-removal control.

Initial SQL receipt 214006-xDfX4Z failed one statement fixture (35 passed): statement date and
baseline balance must be supplied together. The fixture now satisfies the existing constraint.
Initial typecheck found two optional/null annotations, now corrected. Neither fix weakened a
runtime guard. First full receipt 215313-zr4bhV at clean 29ff6802 passed 222 and failed the older
flexible-budget flow when its read received HTTP 429. Screenshot inspection confirmed the
production wait/retry screen. The harness now waits the rendered bounded server interval and
explicitly clicks Check saved records. No limit was raised and no financial write is retried.
The passing full run also observed and honored a real budget-read backoff.

Repository-wide verify:foundation is **currently running** at frozen clean a6a17c7b in the
separate verification checkout, with the same 1ec108b81a57… input fingerprint and installed
Chromium configured. Receipt 221307-g9u8mD. All static categories/typechecks have completed;
the full unit stage is active. Final aggregate verdict, comparison with the recorded unrelated
failure baseline, and later chained-stage status must be recorded before calling that gate done.
CI e2e and live provider/bank acceptance remain unrun. Later evidence/docs commits do not
constitute an additional production-code gate.

## Remaining parity and next implementation

Recurring obligations remain Partial. Early future-occurrence entry, automatic detection/posting,
whole-series metadata edits, calendar view, provider Bill Sync and loan-payment workflows remain
gaps. Recording an expense is not recording a card/loan payment; the existing supported linked
transfer workflow has its own endpoint limits. Custom name/category changes and notes are not
part of this convenience form. See the [evidence-linked matrix](../specs/2026-10-28-finance-parity.md).

Next independent capability: captured private transaction-note editing without changing money,
classification, posting/statement state, splits or links. Audit the existing metadata and sync
handoff paths first. Explicit empty notes must preserve clear intent through provider updates;
notes stay owner-only and out of household mirrors, exports, automatic categorization inputs,
activity params/Undo and job payloads. Existing metadata category writes must not be reused in a
way that confirms categories or drops splits. Design/spec and real RLS/stale/clear/sync tests
precede a native editor. Do not claim global note privacy from UI hiding alone.

## Synthetic manual check and continuation commands

Use a fresh synthetic manual USD checking account with 1,000.00 opening cash before the bill
expense. Plan a due Utilities bill for 100.01. Record an already-occurred 100.99 expense, review,
then cancel host approval: no entry or balance change. Confirm it explicitly: expect one expense,
one posted bill match and 899.01 cash. Reload. A second due plan for the same account/date/amount
must show an existing-expense warning and keep confirmation disabled. No real bank is needed.

Use the verify-gate skill for all DB-touching commands. Useful narrowed gates:

- test:integration:finance-bill-entry (new SQL plus existing bills and module RPC)
- test:integration:finance-bill-entry-live (two selected native flows; twenty-one skipped)
- test:integration:finance-complete (all Finance cases with native execution enabled)

Run each through scripts/run-gate.sh start --gate followed by one wait --follow for its log.
Set an installed CHROMIUM_PATH and task-specific synthetic chat/XDG directories for native runs.
Clear MOSS_CHAT_HOME and every negative/live flag for verify:foundation. Never aim tests at the
dev/production database or disable safety checks for a passing result. Keep changes isolated,
commit/push reviewable checkpoints and do not merge, deploy or publish a PR without authorization.

Release note draft: Added — Record an expense from a due bill. Review actual amounts and account
effects, then confirm one ledger entry and its bill match together without sending a bank payment.
