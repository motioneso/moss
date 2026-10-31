# Finance legacy target repair checkpoint

Authorized continuation of #1144/#1148; isolated branch may be committed/pushed, without PR
publication, merge, deployment or real financial actions. Design:
[legacy target repair](../specs/2026-10-30-finance-target-repair.md).

## Implemented boundary

Old targets on archived or flexible-pool member categories retain their owned category names and
open a read-only review. Remove target remains available; new/edit funding stays disabled.
The reusable section excludes the synthetic flexible pool defensively; the actual Budget screen
already filtered that choice before this change. Do not report a previously exposed pool editor.

The metadata handler permits removal without applying a funding-only guard. Existing SQL owner,
category-existence and captured budget revision/fingerprint checks still apply. Earlier target
versions remain visible in earlier months; assignments, accounts and transaction history do not
change. Valid new flexible-mode transitions already reject conflicting targets. The browser's old
pooled target is an explicitly labeled synthetic legacy fixture saved through the owned SQL store,
not a state claimed to arise from a valid new mode transition.

## Verification

Node 24.19.0 / pnpm 10.6.2, disposable gate databases, synthetic data only:

- Corrected unit fixture observed the original unconditional funding guard fail on removal of a
  pooled target. Restored implementation passed the guard test and native review test. Complete
  Finance unit suite passed 74 files / 711 tests. Scoped lint, module/root-test types, formatting,
  file-size and UI-class checks passed.
- Real SQL `110749-r4LYit`, base `ae05d1d6`, input `f4479c5cae2a`, passed four files / 22 tests,
  exit 0. The expanded pooled-target case preserves a September target, removes October metadata,
  preserves all financial records and refuses reusing the stale removal review.
- Focused installed `111001-VOSXd1` passed two / failed one after actual legacy removal, because
  a follow-up read was rate limited and the fixture waited for a category field. The fixture now
  honors the response's bounded Retry-After and uses the real Check saved records action. There
  is no automatic write retry or production rate-limit change.
- Focused `111425-DQ2fR9` passed two / failed one after successful removal/recovery: the flexible
  exit fixture assumed a preceding split-only case had run. Corrected expectations derive the
  required returned assignment from the original assigned/available values and exact requested
  availability, rather than hardcoding the unscheduled split's effect.
- Restored focused `111815-LMgiKi`, base `ae05d1d6`, input `b46baa89ae1c`, passed all three selected
  currency/bill/flexible cases, with 18 unrelated cases skipped, exit 0. Actual native removal,
  canonical state, unchanged accounts/transactions/category money and exact envelope return pass.

Screenshots `finance-legacy-target-dark-320.png` and `finance-legacy-target-light-1440.png` remain
outside the repository. Both actual dialogs were inspected; executable bounds cover scrolling,
control width and visible footer. Disabled ordinary edit controls and actionable removal fit the
phone. This is target repair within the current category-target model, not broader goals parity.

## Clean target-funding verification and roadmap

The preceding committed target-funding implementation `ea6be307`, clean input `b259dbfcd75f`,
passed all 21 installed browser flows (`105937-wGKmFb`) and four SQL files / 22 tests
(`105944-ajyqpi`). Its aggregate `110750-jED2Pr` passed all static checks, then passed
1,626 files / 19,626 unit tests, failed 21 files / 277 tests, and skipped three tests. All 277
normalized failure identities exactly match clean baseline `3c620d58` (`040401-c9zwQ0`), with
zero additions/removals. Aggregate exit 1; later database stages did not run. This is not an
overall gate pass or a claim that unrelated Computer/Sports/environment failures are fixed.

Next: honor the existing host assistant refresh signal, preserve typed budget review identity
through read refreshes and explicit failure recovery, then audited linked-transfer corrections.
Broader goals/refill/weekly types, payment reserves, provider convergence, household co-editing
and investment holdings remain partial or missing as recorded in the matrix. No credentials or
provider agreements are fabricated to claim completion.

A full-browser launch `112345-0UaLuE` exited 254 because the requested script name did not exist;
no browser assertions ran. The corrected command is `test:integration:finance-live`, not
`test:integration:finance-page-live`. Its separate receipt is recorded below.

Full installed `112421-QYkvGW`, same base/input, passed 20 / failed one, exit 1. Target repair and
flexible return passed; the report drill-through's competing page timed out locating the manual
market's selection checkbox. The reporting dialog itself contained the expected manual record.
The competing page needs bounded response/DOM evidence to distinguish a busy read from another
failure; this is unresolved, not an asserted pre-existing baseline failure. Preserve this tested
repair and investigate that acceptance blocker next; do not report the full browser suite green.
