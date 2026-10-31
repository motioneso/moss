# Finance one-off bill adjustments checkpoint

Authorized continuation of #1144/#1148, following the committed
[design](../specs/2026-10-30-finance-bill-occurrence-adjustments.md).
Commit and push the isolated task branch; no PR publication, merge, deployment,
production data, live banks, credentials or financial actions.

## Implemented capability

Upcoming changes one unreviewed projection's expected date/amount, or resets it to
its original plan. Original occurrence identity, anchor and cadence remain intact.
Incoming/outgoing month/year moves appear once, while subsequent month-end/leap-year
occurrences retain their schedule. Multiple original occurrences may share a new date.
Matched actuals remain distinct; Undo review is required before changing reviewed
projections. Closed-account projection changes are read only. No ledger entry or
payment is created, no money is reserved, and existing transactions stay unchanged.

Owned SQL migrations 0034 and 0035 add the table and owner/date index separately,
following the one-statement module wire contract. The installer supplies FORCE RLS.
Captured revision/fingerprint checks include adjustments; configuration and
identifier/date/cent-only activity commit atomically. SQL independently validates
original recurrence membership, active account/currency and absence of a review.
An account MVCC update preserves monetary values, ledger revision and observation
date while invalidating waiting close reviews. Closure recognizes moved future
occurrences of past one-time plans. Stop refuses to erase later adjusted/reviewed
history. Reset/Undo review provide the explicit remedy.

Reads find moved decisions by original identity and exclude globally claimed
transactions from match candidates, including claims outside the visible window.
Existing one-year read, 500-plan/occurrence and 1,000-candidate limits remain.
Calendar dates span years 0001–9999; individual moves have no arbitrary day-offset cap.

Native edit captures the original view and an immutable before/after review. The
actual host confirms both save and reset; cancellation retains captured values.
Stale or uncertain saves block until an explicit successful saved-bills check.
Immediate submission/dismissal refs suppress duplicate writes before React paints.
Inputs, native dialogs and row indexes use the authored Park Press system.

## Verification and corrected findings

Development receipts on base `9bb07ca7`, Node 24.19.0 / pnpm 10.6.2:

- Initial `080801-OmAbMn` failed migration packaging: two statements in one file.
  Splitting table/index into additive 0034/0035 fixed the contract. `081101-kmPUsA`
  passed 29 / failed three because the test read port lacked owner timezone; the
  resulting earlier assertion left a synthetic match claimed. Supplying the real
  UTC clock seam restored `100938-v0mOhU`: five files / 32 passed, exit 0.
- Fixture-only CAS negative `101138-88crfH` failed two / passed 30 when revision and
  fingerprint comparisons were removed. It exposes overlapping and stale reviews.
- Fixture-only account-version negative `101312-9HGoNv` failed one / passed 31:
  a close waiting on its account incorrectly succeeded without the MVCC touch.
- Fixture-only RLS negative `101438-BZy2na` failed one / passed 31: disabling the new
  table policy exposed another owner's adjustment. The fixture restores ENABLE and
  FORCE RLS in finally. Production protections were never removed for these controls.
- Restored `101613-Ucpx4Q`, input `8e4be199421f`, passed all 32. Latest restored
  `101747-2LwyiB`, input `7939a2afecd6`, again passed 32 across five files, exit 0.
  These include both held-lock account-close orderings, exact cents, migration/RLS,
  concurrent/stale writes, reset, stop, stable dates and global single-match exclusion.
- Full Finance units passed 70 files / 693 tests. Root, root-test and Finance module
  type checks and scoped lint passed. After final confirmation wiring, the relevant
  manifest/native-dialog pair passed all 24 tests. Whole-repository format, file-size
  and UI-class checks passed. Aggregate checks on this new slice remain pending.
- Browser `101136-sXRLeU` and `101310-PdMuww` failed setup on manifest app-map length
  and entry limits. The existing Upcoming declaration now carries the new behavior;
  the limits were preserved. Neither run established browser acceptance.
- Browser `101436-2zvAcv` passed currency setup but failed the new bill case: its
  synthetic projection saved without the expected host dialog. Inspection followed
  the native route and external-tool adapter: executionPolicy governs assistant
  policy; native confirmation also needs synthesized confirmWhenKeys. Both new tools
  now declare their required original-identity keys and a manifest assertion pins
  that hook. Existing bill tools retain their existing policy. The failing browser
  assertion directly detects omission of this hook; no safeguard was bypassed.
- Restored installed browser `101745-hFqVuG`, input `7939a2afecd6`, passed two / skipped
  eighteen, exit 0. Through the real installed UI/API/worker/SQL, it proves working
  currency, host cancel/save, unchanged records before approval, cross-month reload,
  stable next occurrence, a second actual page winning reset, stale first-review
  refusal, explicit read recovery, reset cancellation/save and unchanged accounts
  and transaction history. Complete twenty-flow acceptance remains the next check.

Screenshots `finance-bill-change-{editor,review,list}-<theme>-<width>.png` cover
light/dark/Sage at 320/390/768/1440. Actual dark phone editor, light desktop review,
dark phone list and light tablet list were inspected. Per-control horizontal bounds
are asserted in addition to page/dialog widths. Editor spacing was tightened after
inspection; final browser proof uses that revision. Artifacts are outside the repo
and contain synthetic data only. List captures are expanded to full page for the
next complete run, so moved rows can also be inspected below the fold.

## Next

Commit/push this slice and freeze that source for the complete installed browser
suite and aggregate checks. Keep exact outcomes separate from existing baseline
failures: clean canonical-rule commit `3eb33c49` passed all static but its foundation
run failed the same 277 normalized baseline tests, with no added or removed failures;
its later aggregate DB stages were unrun. No overall green gate is claimed.

Continue the evidence-linked parity matrix after preservation. Credit-card payment
reserves need a separately designed versioned transition from conservative net-debt
funding. Broader targets/funding assistance, existing-record transfer matching and
reversal, provider convergence, household co-editing and investment holdings remain
separate capabilities. Bill detection/calendar/series editing/provider Bill Sync/
automatic posting/payments are not complete from this bounded slice.

## Clean committed verification

`5b5b3db7acb3e51a7dcb21e44e2ffe5a54f81491` was committed and pushed. Clean input
`b47759043b80` passed all twenty installed browser flows (`102123-cJ7BZY`) and all
thirty-two SQL/migration/lifecycle cases (`102131-KQOXMz`). The full-page moved-row
captures were inspected at dark 320px and light 1440px as well as the earlier dialog
views. Foundation `102634-XvpNGa` passed every static check, then passed 1,623 files /
19,608 tests and failed 21 files / 277 tests, with three skipped. Failure identifiers
exactly match the clean `3c620d58` baseline (zero added or removed); later aggregate
database stages were unrun. This is not an overall green gate. Target funding now
continues through its separate design and checkpoint.
