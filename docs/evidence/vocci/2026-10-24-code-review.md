# Vocci independent code review — 2026-10-24

Ben requested a fresh independent `code-review` audit of the completed Vocci,
Meeting preferences, provider and production-repair work, followed by the same
review-and-resolution cycle for each succeeding slice.

## Immutable coverage

Each comparison used `git diff BASE...HEAD` and `git log BASE..HEAD --oneline`,
with the actual PR base/head pinned below. File counts were checked against the
PR metadata. The reviews examined source and immediate consumers; they did not
rerun historical runtime tests or make device/production changes.

| PR    | Base                                       | Head                                       | Files |
| ----- | ------------------------------------------ | ------------------------------------------ | ----- |
| #3566 | `65fc78250fbca425b56e9a9bc9cc2325ce17a804` | `f1177b3e189518f4553f594c39d11296f552752d` | 56    |
| #3576 | `ae571bd9ebf9e17b4ecb072224ed3585dbad28c2` | `26667ae45bd4d78f529a1a119f1b5d1f597cc314` | 32    |
| #3586 | `f97b17001edf1134ea4b054b929d39bcd749c8ec` | `61a2aa17471445537fb75469c4ead9890535d3a1` | 21    |
| #3592 | `282d4e34d545da88c911c61a51e570e0908b673e` | `a3d9744e1d80dd1236fbde570c5d27fdcf2b442d` | 14    |
| #3594 | `ba5cb964a65cadccad60c371e7a01d18e5c9cbf4` | `11163f1893f2bdd5a381c0663852d9c2b710f5de` | 36    |
| #3602 | `6780160bb49ccbe3c59eb8514f4eba49758ca56c` | `891a3d004a6128373c9055f1e32c2bb006742d0b` | 18    |
| #3608 | `12cb62b0cd466b3e6ea42721e54a7b6d429bfdbb` | `560d6a4d7701c0440747579fba3d33812dfa36ec` | 7     |
| #3610 | `5f8a1f9e533223646e056be407947639c26f890d` | `0e19c6eaa37ffa687d67edeb7e9c25afb241c80a` | 6     |
| #3613 | `9d0eb099bfa0d230a8907e150e35769c909f1284` | `54d7e0a7dc0fadfb8c22e91a7378d934bb5c5319` | 5     |
| #3615 | `967bee00b1aa2119bc8ea55aa4b402f48898a6ff` | `af32ea209e0a660e37945db1fe22aee0db51e940` | 2     |
| #3620 | `076fc397e665c31c9f750d96e44bec8b18cb650c` | `0cfa61be0e9e6a5be083e594705f31ba728b03c4` | 2     |

## Standards

Two independent reviewers covered the native PRs (#3566, #3586, #3592) and the
remaining server, UI and documentation PRs, respectively. Both reported **zero
actionable findings** under AGENTS.md, CLAUDE.md, DEVELOPMENT_STANDARDS.md,
relevant design-system rules and the code-review Fowler smell baseline.

They checked setup atomicity and identity, retained credentials and journals,
serialized hardware operations, observation timestamps, provider routing,
owner-scoped preference access, transcription boundaries, app-map accuracy and
public evidence disclosure. These are source-review results, not new physical
acceptance claims.

## Spec

The server/UI reviewer reported **zero findings** against the originating specs
and plans for provider summaries, shared language, instance transcription
selection, promoted Codex support, bounded window timestamps, shorter helper
copy and physical acceptance documentation.

The independent native reviewer reported **one P2 finding** in #3592:
`retry-transcription` could call the server for a failed retryable hold import
after its source had been excluded. Delivery details still offered that retry.
The recording-management plan promises that no later delivery operation starts
after exclusion commits; there is no re-include action in this slice.

Correction: `6c174d80b84001a42cd3145a80ea2f73769bb738`, planned in
`263681aec`. The service checks the identity-bound durable exclusion immediately
before the retry call, and the activity uses the same eligibility condition when
rendering the control. A stale control/intent cannot authorize an excluded retry.
The correction also updates the app map.

Both independent reviewers re-reviewed the correction against fixed base
`0cfa61be0e9e6a5be083e594705f31ba728b03c4`: **Standards 0 findings; Spec
0 findings; original P2 resolved in source**. A test-only amendment replaced the
generated retry response with the real `queued` state; both final verdicts pin
the full correction SHA above.

## Correction execution

- `apps/vocci-delivery/test.sh`: exit 0, host suites and development APK build.
- Focused app-map unit suites: 3 files, 23 tests passed. Scoped ESLint and Prettier
  checks passed.
- Installed disposable APK SHA-256:
  `6e3abf74372c89e94739d33453c866cabe0db95e03eacb9be7fcdf1e95ae7d61`.
  The actual production Java sources were built under a separate disposable app
  identity. Generated failed hold-import records were created with the production
  store/ledger methods; no server responses were intercepted. Installed
  RecordingChecks passed: an excluded retry made zero retry-port calls and kept
  its entry unchanged; an eligible retry called once and saved the returned status.
- With the phone unlocked, actual DeliveryActivity rendering showed Retry
  transcription before exclusion and omitted it after durable exclusion. The
  generated local data and counted port prove the local restriction only; this
  is not a real account, ring, ASR or production hold acceptance claim.
- Removing the exclusion guard in a private source copy made the installed
  service-contract regression fail. A separate installed UI control then failed
  specifically because the excluded source still exposed Retry transcription.
  Both negative runs exited 1 and remain failed receipts; both removed only their
  newly owned disposable package.

The disposable package was removed and absence confirmed. The production
companion identity/configuration/queue were not replaced by this proof. The
original two-minute screen timeout was restored after the check. Final static/CI
results are recorded on the correction PR. Merge does not install a new production companion APK.

## Acceptance limits and next slice

The real normal-recording path has retained pending-source persistence, manual
Start recovery, a visible timestamped transcript and a fresh automatic summary.
See `docs/superpowers/plans/2026-10-24-vocci-production-acceptance.md`.
Automatic package-replacement/reboot recovery, interrupted-chunk/byte-offset
resume, offline/out-of-range behavior and production hold remain separate
unproved acceptance. #3565 remains open; #3584 retains the remaining approved
Hardware capabilities. A clean code review does not close those gaps.

Full private review reports and execution receipts are retained outside git.
The committed successor handoff carries the bounded continuation cycle and
requires independent Standards and Spec review before every merge.
