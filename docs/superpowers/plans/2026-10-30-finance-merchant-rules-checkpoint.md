# Merchant rules checkpoint — October 30

Branch `task/finance-parity-20261028`; commit/push authorized, no PR publication, merge, deployment,
production changes, real credentials, banks or live financial actions. All records are synthetic.

Design: [reviewed merchant rules](../specs/2026-10-30-finance-merchant-rule-management.md).
Broad status: [parity matrix](../specs/2026-10-28-finance-parity.md).

## Implemented boundary

Additive module migration 0033 creates owned canonical merchant rules. The normal per-owner storage
migration, including its already-migrated path, copies the newest valid legacy rule per normalized
payee without deleting KV. Canonical rows win on replay; disabled tombstones prevent an older KV
rule returning. A separate upgrade marker lands only after successful copy. Malformed/unavailable
legacy data refuses partial upgrade and stays intact. Ledger migration and financial facts remain
separate. All current SQL chat/queue rule writers and rule Undo use the canonical capability;
KV-only hosts retain compatibility, and concurrent older hosts remain a separate boundary.

Captured rule writes lock and recheck revisions/absence and live categories, then commit configuration
and identifier-only activity together. Concurrent/stale changes save nothing. Disabling a current
archived destination is allowed; enabling requires a live category. Undo restores configuration,
reversal activity and the original undone mark atomically; new-rule Undo keeps a disabled tombstone.
The categorizer now ignores missing/archived rule destinations and preserves existing user categories.

Finance settings offers normalized search, exact matching counts and bounded Show more. Add/edit,
disable and re-enable require a read-only monthly preview and captured native review, then the actual
host confirmation. Preview shows at most twenty owned examples without notes or household mirrors;
it never edits history. The saved rule applies to future uncategorized arrivals. Normalization is
shown explicitly: matching ignores case, digits, punctuation and repeated spaces. Changing a match
creates a separate rule. Cancellation retains the review; stale/ambiguous results require an explicit
successful saved-rule read. Busy reads honor the server wait without automatic requests or writes.

This remains a bounded single normalized payee/category engine. Multiple criteria, ordered actions,
tags, automatic splits and retroactive rule application are not implemented. Legacy rule-plus-row
category jobs remain separate. Native Undo still uses the existing queued Settings workflow; the new
atomic backend Undo is tested separately, not claimed as a newly awaited native Undo flow.

## Verification and limits

Development receipts on base `805ef3ec`, Node 24.19.0 / pnpm 10.6.2:

- Initial real SQL/migration/install `071644-VV8Kx2`, input `19741d1d0bd5`: fourteen passed across
  three files. Fixture-only CAS negative `071740-7w67So` failed four / passed ten: stale/absence,
  simultaneous updates, stale same-category Undo and held-lock conflict. Fixture-only RLS negative
  `071841-Y0ZXBa` failed one / passed thirteen because another owner/admin could see the rule.
  Production SQL/authorization was never removed. Restored `071932-07T1Wp` passed all fourteen.
- Expanded `073005-trkQ5r`, input `dec6c8889fee`, passed seventeen. Added malformed/unavailable
  legacy refusal, unavailable Undo destination and read/list/preview/update acceptance. Restored
  current-source `074425-l1UObE`, input `43d83c321293`, passed all seventeen, exit 0.
- Future categorization acceptance uses the production engine with real stored rules and synthetic
  arrival objects, not a live provider or a provider-worker integration. Existing history, notes,
  ledger balances and user allocations remain unchanged.
- Categorizer archived-destination regression was observed red (one failed / fifteen passed), then
  restored with the related five-file / 97-test legacy pass. Full Finance unit suite now passes
  68 files / 674 tests, including eight new native rule tests. A stale 32-file migration expectation
  was updated to 33; its earlier one-failure run is not a pass.
- Installed focused `074132-KQJIaB`, input `16bc9d8c20a1`: three passed / seventeen skipped, exit 0.
  Actual signup/migration, signed-in settings, readonly preview, host cancel/save, reload, disable,
  keyboard control, competing SQL edit/stale rejection, explicit read recovery, re-enable, search
  and second-owner isolation were exercised. No response mocks or fabricated migration marker.
- Earlier browser `073007-zUbyNu` and `073831-CtCP4N` each passed two / failed one on fixture control
  assumptions: the shared Switch is a checkbox with a visually hidden input. Acceptance now clicks
  its visible label and separately proves Tab/Space operation, without forcing a hidden click or
  changing the authored control. Actual screenshot inspection also found a clipped phone preview
  button. Controls now stack and acceptance checks each control's horizontal bounds, not only the
  page scroll width. The section uses the existing compact spacing and responsive filter grid.
- Scoped lint, Finance module types and root-test types passed. Complete twenty-flow installed run
  `074423-w5rLnJ`, current input `43d83c321293`, passed all twenty, exit 0. Final clean combined
  static/foundation and CI e2e remain separate requirements. A final formatter check found only a
  wrapped method-chain layout; it was formatted before commit, with no behavioral change.

Screenshots `finance-rule-{preview,review,list}-<theme>-<width>.png` cover light/dark/Sage and
320/390/768/1440. Phone dark preview/list, phone narrow review and desktop light preview/review were
visually inspected. Dialog actions remain inside 900px height; individual controls fit horizontally.
Artifacts remain outside the repository and contain synthetic data only.

The previous clean initialization commit `61052249`, input `78897dfea6e3`, completed foundation
`070254-PFAraS`: all static passed, 1,620 files / 19,570 tests passed, 21 files / 277 tests failed,
three skipped. Its normalized failure identifiers exactly match the earlier clean `3c620d58` baseline
(added zero, removed zero). Computer trust/native/session, Sports browser and unmapped-UID ACL
prerequisites remain; later aggregate DB stages were unrun. This is not an overall gate pass and
predates the individual-confirmation and canonical-rule implementations.

## Continue

Record the complete twenty-flow verdict, commit/push this coherent slice, and freeze the combined
commit for full checks. Continue the matrix after preservation. Audit credit-card reserves against
Moss's current signed-card/net-debt funding semantics before a versioned policy change; do not
silently reinterpret existing allocations. One-off bill date/amount overrides, broader goals,
existing-record transfer matching, provider convergence and household/investment coverage remain
separate acceptance work. No universal parity or live bank coverage is implied.

## Clean committed preservation

Implementation was committed and pushed as `3eb33c492a72d91c970fab1fefa55ad7ac5668ca`.
The independent verification checkout is clean with input `aa09e2a3ec7d`. Its installed complete
browser `075030-QqSw1t` passed all twenty flows; real rule/migration/install SQL `075031-As2Dcj`
passed seventeen across three files, both exit 0. The combined foundation check follows on that
frozen source. Main continues the separately specified one-off bill changes; credit-card payment
reserve policy is deliberately left unchanged pending its own reviewed transition.

The clean `3eb33c49` foundation run `075541-I17Lb9`, input `aa09e2a3ec7d`, finished
with exit 1: all static checks passed; 1,621 files / 19,585 tests passed, 21 files /
277 tests failed, three skipped. Normalized failure identifiers exactly match the
clean `3c620d58` baseline (zero added or removed). Later aggregate database stages
were unrun. This is not an overall pass. One-off bill work continues separately.
