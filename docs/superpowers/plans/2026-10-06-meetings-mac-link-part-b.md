# Meetings Mac link: Part B (#2981)

Status: approved implementation, draft pull request only. No merge or deployment.

## Source and branch

Build from repaired, published Part A, PR #3079 at `5cd2550eba229820dd14fe404e84ced79f7b83a2`,
tree `f2feda36e7b6c63bf59c8a6703947233bb8aa9eb`. The branch is
`feat/2981-meetings-mac-link`, with intended PR base `feat/2981-meetings-minimal`.

The approved controls and test matrix are the Link design sign-off in
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md`. Its current source is PR #3077
at `687fd2bc45e48f6a8a75068302bc332ce3e86c06`, which supersedes the original R6/R9 defaults
and T9/T12/T14 checks before implementation began. The copied spec also corrects its stale
lifetime sentence to match R9 and identifies the pill as required work rather than old baseline.
The source's historical baseline is context, not a claim about this build's current behavior.

Use the existing pairing, capability-attempt/decide, companion logout, browser session and
capture-grant flows. Every Start remains a deliberate browser action. Creating, opening, linking,
reconnecting and acknowledging the notice must never start recording.

The owner's latest ruling requires a draggable small floating pill above other windows on every
Space, showing recording/paused/no-audio/reconnecting state, elapsed time and a waveform driven
only by the audio actually captured. Silence or missing audio must make it flat; no decorative
animation. Close hides the pill until the next Start and does not stop recording. Keep the menu
bar red dot from Start until Stop and clear both surfaces on every stop path. Do not post system
notifications. Include a simple design mockup image in the Part B PR, labeled as a mockup rather
than live proof.

The recording capability has no independent expiry; it ends on Unlink, revoke or device expiry.
Device expiry remains 90 days of inactivity and a 365-day absolute bound. Hardware-bound
credentials remain deferred: document a narrow future integration point, without implementing a
new secret or authentication flow.

## Control mapping

| Control | Required implementation and review scope                                                                                                                                                 | Proof                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| R1      | Settings Unlink uses the canonical owner device deletion transaction; subsequent native credentials fail and post-commit audio is refused                                                | T1                                   |
| R2      | Mac Unlink confirms logout before deleting both Keychain items; failed logout retains credentials and visible retry state                                                                | T2, T13                              |
| R3      | Meetings settles invalid bindings as revoked, discards unsent native audio, and exposes the unlink/revoke reason within one lease                                                        | T1–T3                                |
| R4      | Preserve claim, lease, hard-cap and session/device/connection bounds on every live capture operation                                                                                     | T5                                   |
| R5      | Preserve the starting browser session binding through local and everywhere-else sign-out                                                                                                 | T4                                   |
| R6      | Each accepted Start shows the floating pill and menu-bar red dot; actual captured levels drive the waveform, close only hides the pill, and every stop path clears both; no notification | T12, T14                             |
| R7      | No additional Mac confirmation and no record-on-link behavior                                                                                                                            | T12, T14                             |
| R8      | Preserve the canonical account notice service and grant-bound current version                                                                                                            | T8                                   |
| R9      | Capability remains valid without a Start for more than 90 days when the device remains valid; Unlink, revoke and device expiry still end it                                              | T9                                   |
| R10     | Preserve per-IP limits; add shared per-account Start limits of 10/minute and 60/hour with Retry-After                                                                                    | T10                                  |
| R11     | Trace bearer/proof/verifier/grant secrets through logger, queues, export, AI and response consumers; add authorization-header redaction                                                  | T11                                  |
| R12     | Settings offers device Unlink and recording-only revoke; Mac offers truthful Unlink                                                                                                      | T1–T3, T13                           |
| R13     | Preserve exact saved-source selection, current inventory validation and refusal of unavailable sources                                                                                   | T6, T7 plus saved-source regressions |

Every T1–T13 guard-removal check needs an observed failing execution, then a restored passing
execution. Author the real-service integration cases without substituting the old reapprove fake.
Record separately which checks ran locally, which are authored for hosted execution, and which
require owner-controlled hardware. T14 is the live linked-Mac path and cannot be claimed by a mock,
portable source check or CI unit test.

## Work and integration lanes

1. Auth/capture server: preserve capability lifetime, durable account rate limits, revocation settlement,
   request boundaries and real-service integration/negative tests. Preserve module ownership;
   auth must not write Meetings tables.
2. Native Mac: floating pill, actual capture levels, red dot and every stop path, persistent Stop, truthful logout retry and
   Keychain ordering, portable tests plus native unit coverage. No real credentials, OS permission
   changes, actual recording or provider activation during this build.
3. Browser Settings: existing canonical revoke/logout surfaces, exact device targeting, pending
   and failure states, authentication-reset fencing, app-map and component/acceptance coverage.
4. Independent security review: trace every control and last secret consumer; reconcile the final
   matrix and inspect all expiry/revoke/concurrency boundaries before publication.

Part A review findings take priority when forwarded. Preserve its published base and keep fixes
attributed to their proper stack; do not silently rewrite or publish another branch.

## Migration and verification boundaries

A fresh inventory of all seven open PRs leaves 0295 free; reserve it for the Meetings account
rate-limit state if a migration is needed. No capability-expiry migration is planned. PR #3071 owns 0289, 0291, 0293,
0294; Part A owns 0292. Never edit applied SQL. Update the foundation schema catalog and affected
export, deletion and role fixtures for every new table or migration.

Use the repository verify-gate procedure for any database test. This executor has no Docker,
Swift or Xcode and Chromium previously failed its socket operation before assertions. Do not
replace isolated database checks with a live/dev database or represent portable inspection as a
Mac build. Author the hosted checks and report that limit plainly.

Run appropriate unit/component and portable checks, six TypeScript configurations, full lint and
format, file-size, design-token, UI-class, catalogue, date, password-source, dependency, migration
and app-map checks against the final tree. Retain exact negative-proof records. Security and live
claims remain unverified where their required execution has not happened.

## Publication

Use explicit-path local commits and preserve a clean worktree. Publish only the new feature
branch additively and open a draft stacked PR. A publication refusal or failure stops further
attempts; supply the complete base-to-HEAD format-patch series as a ZIP attachment, with hashes
and an independent fresh-base apply proving the final tree. Do not try an alternate publication
route after a rejection.

The product PR includes its own release note and accurate control/test status. No PR merge,
production change, device-permission action, credential operation or real recording is authorized.
