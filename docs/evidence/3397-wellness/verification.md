# Wellness audit repair evidence

Task: [#3397](https://github.com/motioneso/moss/issues/3397).
Status: **code-complete, unverified**. Final serialized TypeScript and independent
review remain pending. No merge or deployment.

## Scope and base

This lane is an isolated stack on the active Lifestyle visual-owner base #3348,
`f3e6c057b621e76b79eab5e86b4c147edd30bb5e`. Its renderer and visual acceptance
artifacts are unchanged. Finance, Food, Job Search and Workshop are excluded.
The AI-consent race #3260, stopped-medication insight population #3236 and
local-calendar-day export contract #771 remain separate work.

The repairs retain existing product contracts:

- Stable check-in keyset pages preserve PostgreSQL microseconds and timestamp ties,
  and continue without looking up a deleted boundary row. Routes still use the
  normal actor data context for each page.
- History traverses older pages independently of complete-window summary and trend
  reads. A failed window page rejects the entire read; loaded history stays available
  with explicit retry feedback. Older entries remain editable.
- Mood covers fourteen completed local days. The existing check-in streak ends
  yesterday and is capped at ninety days. Today's reflection is labeled saved.
- Scheduled doses distinguish Pending, Taken and Skipped, always retain the formatted
  clock and explain that Mark skipped replaces Taken. Rejected scheduled writes retry
  the same slot/status. Uncertain as-needed saves retain the optional reason and offer
  a saved-dose recheck before another insert; that recheck does not itself repeat a write.
- Selective export discloses UTC boundaries and validates the existing 366-inclusive-day
  limit. Conflict, failed-status and expired/unavailable-job recovery retain selection.
  Account-keyed query cache and session metadata retain dates, categories and job identity;
  acknowledgment and health content are not persisted by this draft helper. A response
  arriving after route navigation still saves its submitted selection/job. Returning
  while that request is pending blocks a duplicate start and observes the later response.

## Observed regression evidence

At the visual-owner baseline, the nine initial dose/export component cases failed
on their intended assertions. After implementation they pass.

Additional negative controls were run and restored:

- Replacing the selected-window chart input with its first 500 records makes the
  620-observation regression fail: the rendered mean becomes `1` instead of `-0.2`.
- Replacing account-specific session storage keys with one shared key makes the
  account re-entry regression fail: the next account resumes the prior job.
- Restoring the original history component makes the older-filter traversal
  regression fail because the loaded-only empty wording and continuation are absent.

These are synthetic unit/component checks, not installed-path or real-backend proof.

## Verification

- Relevant Wellness unit suites: 25 files / 264 tests passed.
- Focused suites cover precise cursors, complete-window client failure atomicity,
  620-observation chart statistics, older edits/filter traversal, dose retries and
  export Close/re-entry/late-response/conflict/expiry/status recovery.
- Scoped ESLint and Prettier: passed.
- Design-token, UI-class, migrated-section, UI-catalogue, ambient-date and file-size
  checks: passed. The app map generated successfully after metadata validation.
- Tests and web TypeScript passed before the final regression additions; final
  serialized checks are pending. The initial root TypeScript attempt exhausted the
  default Node heap and provides no correctness verdict.
- `scripts/run-gate.sh start --gate test:wellness`: exit 4,
  `docker not found — cannot launch the gate database server`.

## Not run / remaining gates

The database regression suite and authored real UI/API/worker UAT have not run.
The isolated integration test covers 620 tied microsecond records, deleted anchors,
new arrivals, cursor validation, date-filter binding and per-page owner scope.
The UAT journey uses real fictional records and actual browser offline mode,
with no response interception; it covers old-entry correction, dose retry,
selective report download and hard-navigation re-entry. No screenshots constitute
acceptance evidence.

Native dependency lifecycle scripts were skipped during offline installation. No
signed-Mac or other native claim is made. CI, independent review and installed live
acceptance remain required before merge readiness or marking the issue Done.

## Draft release note

Category: Fixed
Title: Recover Wellness history, doses and exports
Description: Older check-ins stay reachable, date-window summaries include all entries,
and interrupted dose logs and clinician exports provide clearer recovery.

## Independent-review corrections

Review identified two interrupted-flow defects at `93d017406`:

1. An unrelated scheduled-dose mutation erased the latest ambiguous as-needed failure,
   and route re-entry lost its reason and guard. The unresolved outcome now has its own
   account-keyed, in-memory query state. Other dose writes cannot clear it. A successful
   explicit saved-dose read is required to clear the guard; failed reads retain it and
   the optional reason. Nothing in this state is written to session storage. Ordinary
   route re-entry restores the draft even while the schedule cache remains fresh.
2. A ready export could retain a Download link after its server-provided expiry time,
   before background cleanup changed the stored status. The dialog now treats a ready
   job past `expiresAt` as expired and schedules an open-dialog deadline update. Existing
   selected dates/categories and the acknowledgment requirement are retained.

Four lasting regressions were observed red against `93d017406` (exit 1, all four
failed), then green after restoring the fixes. They cover another medication write
followed by quick route re-entry; account separation and failed/successful saved-dose
reads; already-expired ready status; and the expiry deadline crossing while the dialog
stays open. These remain component evidence, not real-backend acceptance. Final serialized
TypeScript and independent re-review remain coordinator gates.

## Pending-dose navigation correction

A further bounded review repro at `df789d20` found that route re-entry before an
as-needed response completed could lose the component's pending guard and submit
another insert. Pending dose mutations now have account-keyed in-memory observation.
Re-entry restores the optional as-needed reason, shows Saving, and disables another
write until the pending outcome settles. A late uncertain failure transitions into
the independently retained saved-dose-recheck guard for the original account.

The two permanent success/failure cases were observed red at `df789d20`: each submitted
two API writes instead of one after re-entry. With the correction, both pass, including
account separation, late outcomes, unchanged reason and absence of session-storage health
content. The failure case also verifies that settling while a different account is shown
leaves that account unchanged and restores the original account's uncertainty on return.
Final serialized TypeScript and independent re-review remain coordinator gates.

## Live verification and review follow-up (2026-10-11)

- Provisioned real-UI UAT `tests/uat/specs/audit-wellness.uat.spec.ts` passed on head
  7f4cecacc (1 passed, 43.9s) in an isolated instance. It stops the isolated app service
  for the dose failure, because browser offline mode pauses the write instead of failing
  it. This supersedes the "not run" UAT status above; the earlier entries record the
  blocked attempts at the time.
- Codex re-review follow-up: a scheduled rejection that lands after leaving Today is kept
  in account-scoped query cache and retried with the same slot and status. The new
  regression was observed failing before the fix. Remaining export and dose copy was
  trimmed to status and recovery controls.
- Required CI remains the merge gate.
