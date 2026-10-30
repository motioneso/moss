# Private transaction notes: continuation checkpoint

2026-10-30. Branch task/finance-parity-20261028. Paths are relative to ~/Jarv1s.
Commit/push authorized; no merge, deployment, production data or PR publication.

## Current capability and acceptance boundary

Spec a9c3c4fa precedes implementation 6eda0f62. Production follow-ups 14e45a3f and d660d466
preserve oversized drafts and distinguish reading/saving. Native helper c14ead37 honors
rendered read backoff with an explicit saved-state read, never a write retry.

Transaction details now offers an owned private-note editor on current SQL storage and the
host bridge. One exact account/id/month read captures the current note and row version. A
separate SQL compare-and-set updates only notes and adds metadata-only activity in the same
statement. It does not reuse category confirmation, alter financial fields, create rules or
change splits, links or reconciliation. Empty strings preserve explicit clear intent. Fresh
unchanged notes are a no-op; an old captured version conflicts, including after a completed save.
No migration was added or changed.

The existing shared Dialog stays mounted while its title/body/footer switch to editing, keeping
its original focus-return target and shared modal lifecycle. Cancellation keeps the draft.
Conflicts/uncertain responses block writes until Check saved note succeeds. The retained draft
and currently saved note are then both available for an intentional overwrite. Read 429 waits
are honored; no automatic write retry is introduced. Text is not trimmed or shortened, including
oversized ASCII or Unicode drafts. Save rejects more than 4,000 UTF-8 bytes, NUL and malformed
surrogates. Shared rows and old host/storage versions remain read only with an upgrade hint.

**Native UI acceptance is pending. Do not call this slice verified or universal editing parity.**
The installed test covers initial loading, oversize preservation, host cancellation, save/reload,
clear, a real intervening SQL write, conflict and explicit recovery, plus light/dark desktop/phone
screenshots and focus/overflow/footer assertions. It has not yet run at this checkpoint.

## Evidence so far

All thirteen focused SQL/handler tests passed at clean 6eda0f62, receipt 224509-Dup6ss:
/tmp/jarv1s-gate/moss_finance-20261030-224509-Dup6ss.log.
Fingerprint af9ba5b0f5167db64820149ec8e1b0b08801a1ceeae2bad06793bbc883ae4fca;
Node 24.19.0, pnpm 10.6.2, disposable PostgreSQL 17.11. Tests include exact Unicode/clear
preservation, no-op/stale/concurrent writes, wrong/missing targets, byte/invalid-text limits,
activity redaction, unchanged split/review fields, a reconciled linked transfer with unchanged
account/statement state, same-ID provider refresh and actual synthetic-feed pending-to-posted
convergence. Later UI/test-helper commits do not replace that exact clean-backend receipt.

Removing RLS only from the disposable fixture's transactions table produced the intended four
foreign/admin read/write failures (nine passed), receipt 224428-I83wZc at the same clean commit
and fingerprint. Foreign/admin reads returned private note facts; writes returned saved instead
of stale with the actual revision. Restoring the normal setup passed all thirteen above. Runtime
RLS source was never weakened. Both gate containers were removed by the runner.

The first development SQL run passed nine and failed the handoff case because its fixture had
not created the required provider item. The existing FK was retained and the fixture corrected.
An expanded thirteen-case development run then passed (224219-aVOLwt). Initial type/lint errors
were a copied unused import, literal actor inference and the read-result generic constraint;
those were corrected. Focused lint, module types and sixteen manifest unit cases subsequently
passed. Full root typecheck also passed; these plain development logs lack gate fingerprints
and do not substitute for the pending clean aggregate.

The new note tools are direct read/confirmed-write handlers, with no new queue declaration.
The host page route passes inputs directly and persists summarizeAssistantToolInput's key/count
summary, not values. The note activity statement contains IDs and notesChanged, not text or Undo.
Existing shared projection and loaded/owned CSV implementations use explicit allowlists; the
automatic categorization batch contains only id/payee/amount/date. These are scoped source traces,
not a claim that notes never reach the owner's assistant. A broader privacy/runtime assertion
must retain its existing negative-control and installed-path evidence.

## Gates in flight and next exact action

The bill-entry aggregate correction is still running in the frozen verification checkout at
clean 4475cb87: /tmp/jarv1s-gate/moss_finance_transfers_verify-20261030-223645-1HZuKL.log.
Static checks passed and units are active. Its predecessor had the known 277 baseline failures
plus the now-fixed manifest-list regression. Normalize ANSI and compare complete FAIL identity
sets to 143017-SaB79F before classifying the outcome. The baseline's sorted newline-joined set
SHA-256 is dd40a5d54c5f4a990654eb4039f9055a3ecad8a99ada3088d76336ede12a0ba9.

Repository static checks for notes are also running; do not overlap native acceptance with
these CPU-heavy checks or the full unit stage. The worker's fail-closed pattern validation has
a tight existing budget; never increase it for a test pass. Recover existing wait sessions or
use run-gate.sh status --log on the exact log; do not infer liveness with process searches.

After the current checks finish:

1. Record aggregate verdict and exact baseline delta, fix task regressions, preserve/push result.
2. Through scripts/run-gate.sh, run test:integration:finance-notes-live with installed Chromium
   and synthetic chat/XDG/artifact directories. Diagnose actual UI errors and inspect originals.
3. Run test:integration:finance-notes-confirm-negative. The disposable manifest becomes valid
   trusted-auto and removes confirmation; storage equality must fail after a completed write,
   not from timeout/discovery failure. Restore normal installed acceptance afterward.
4. Run test:integration:finance-complete and the latest-source canonical verify:foundation.
   Keep each tested checkout's inputs frozen. Record unrun chained stages after any failure.
5. Archive selected original screenshots in repository evidence, update this checkpoint/matrix
   from actual results and verify pushed HEAD plus a clean worktree. CI e2e/provider HTTP remain
   separate unless actually exercised.

No real credentials, accounts or bank instructions are needed. Native tests create synthetic
manual accounts; provider tests use only inert provider/credential ports with real SQL paths.
Broader merchant/date editing, bulk notes, attachments and tags remain missing. This slice does
not change other Partial classifications in the [parity matrix](../specs/2026-10-28-finance-parity.md).

Release note draft: Added — Edit private transaction notes. Save or clear a note from transaction
details with confirmation, while preserving transaction amounts, categories and reconciliation.
