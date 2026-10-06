# Meetings Mac link: Part B (#2981)

Status: approved implementation, draft pull request only. No merge or deployment.

## Source and branch

Build from repaired, published Part A, PR #3079 at `1b1e459c4d0ea87e3e13d11b1093e4f853b58673`,
tree `a0f3403b0de7f5d72d69efab60d67be036dd3c13`. The branch is
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

## Implementation boundaries

Per-grant live operations, provider admission and later persistence acquire the existing
device/meeting locks before an auth-owned row fence, and release that fence only after the
application transaction commits or rolls back. Start, connection registration and command
polling retain their separate authorization prechecks. Auth row
contention fails temporarily, rather than falsely revoking a grant. Provider dispatch is admitted
inside this fence; its result is awaited after release. Work already admitted to a provider can
continue after revocation, while a fresh authorization fence protects later persistence. This is
not a claim that revocation cancels a provider's accepted request.

A metadata-only maintenance queue rechecks grants without another browser or native request.
Start and its first job commit together. Each sequence advance and successor job also commit
together; a repeated delivery cannot fork the chain. The API consumes these jobs through the
existing auth and owner-scoped application ports. The existing worker remains the sole queue
supervisor. No worker access to auth secrets or new database role is introduced.

Maintenance owns and closes its database transports on cancellation, including a stalled
connection handshake, query or idle teardown. Its configured single-crash recovery budget includes
the recurrence and polling time before a crash. That budget assumes the API, database and queue
supervisor can run within their deadlines. A prolonged process/database outage cannot guarantee
a persisted update within 30 seconds; the native lease remains a separate recording stop bound.
The hosted no-traffic, active-job crash, rollback and replay tests must execute before this becomes
a verified timing claim.

Native logout deletes only the row matching the presented credential's canonical digest, and
returns 204 after deletion or confirmed absence. This lets a retained credential finish Unlink
after a lost response or earlier Settings deletion. Malformed credentials and cookies still fail;
ordinary device authentication is unchanged. Native cleanup still requires a confirmed 204.

Migration 0295 stores bounded Start timestamps per owner. Its account lock spans every API
instance, with the database clock read after acquiring that lock. Failed requests and replays
consume admission capacity. Export grants contain only the owner ID and timestamps; deletion
cascades from the owning user.

The T1/T2 negative proofs have two complementary forms: end-to-end tests disable each actual
device deletion, while isolated binding tests remove the device check. Device deletion also
cascades its capability, so removing only one redundant liveness check does not make an unlinked
device valid. T6 additionally removes owner RLS inside a rollback-only transaction and rechecks
owner denial after restoration. T11 temporarily grants forbidden export columns, then verifies
denial after rollback. These are authored database proofs, not local execution claims.

The [recording-pill concept](../mockups/meetings-mac-link/recording-pill-concept.png) is a design
mockup, not an installed-app screenshot or evidence of real capture. Hardware binding remains
deferred at the credential storage/server verifier boundary.

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

## Initial local verification and remaining gates

The initial Part B unit/component group passed 83 suites and 1,065 tests. Root, tests, web,
finance, job-search and food TypeScript configurations passed, as did full ESLint and Prettier,
file-size, design-token, UI-class, migrated-section, catalogue, ambient-date, password-source,
package-dependency, migration-number and app-map checks. The production web bundle built;
its large-chunk advisory remains an advisory.

The initial server database-free negative runner observed ten named failures followed by restored
passes: missing device, capability and browser session; the post-fence deadline; each account
rate limit; logger redaction; and owned-transport connect settlement, forced idle close and query
abort. Five owned-client tests use the installed pg client with a synthetic protocol transport,
including transaction cancellation. They are not real database or live TLS tests. The Settings
lane also observed seven stale-response, identity and repeated-action protections fail with
their guard removed and pass after restoration.

Portable production C checks and seven negative cases passed, including captured amplitude,
silence, stale levels, clock rollback, queue publication/capacity and sample ordering. The native
negative runners' anchors and harness self-tests passed, and the existing Backtrack source checker
caught all seven planted violations. These checks do not compile Swift or execute XCTest.

At the initial handoff, the canonical database gate had exited before launch because Docker is
unavailable. Real-auth integration, migration, owner export/cascade, RLS/column-grant mutations,
no-traffic timing and crash recovery were authored for hosted execution. Browser acceptance was
not run here; the executor had also rejected Chromium's socket operation. Native Release/XCTest,
its 12 new T12/T13 mutations, installed Apple SDK checks, live TLS and the owner-controlled
linked-Mac T14 path had not yet executed. Subsequent hosted results are recorded below; no real
audio or provider recording occurred in this executor.

Independent source review found no remaining blocking source issue after the cancellation and
crash-recovery corrections. This is code-complete, unverified until the exact published candidate
passes its hosted checks and the assembled owner-run live path is recorded on the draft PR.

## PR #3082 review and first hosted execution

The owner published the initial tree `b2dffd46ed83f1867c114604a44019f7ff036a63` at branch head
`40f87fd37c81e472a24899319b3973a54aa2cd32`. GitHub's CI merge snapshot
`20f7111baefc08a5e49fb53afd00d70a86762380` has that same tree; it is not the feature-branch head.
Repairs are based on the published branch, and their patch is checked against both equivalent
source trees. Migration 0292 belongs to the stacked Part A and remains unchanged.

The first real-auth gate on PostgreSQL 17.11 passed 41 of 42 tests, including the active-job
crash path. The abort case observed one server backend immediately after the local transport
closed. PostgreSQL can still be waiting on the blocked query until its statement deadline;
local socket completion does not acknowledge server process exit. The corrected tests identify
both in-flight backend PIDs and require their count to reach exactly zero within five seconds,
across all backend states and while the blocker remains held. They retain the active grant,
unchanged sequence, shutdown deadline and successful retry assertions. Healthy idle pooled
connections are intentionally retained and are not mistaken for cancelled leases.

Review also identified excessive connection creation and global queue checks. Maintenance now
borrows from bounded, role-specific pools. Clean completed transactions may be reused; failed,
cancelled or unfinished transactions destroy their transport, and shutdown waits for actual
transport closure. Fast supervision names only the capture-maintenance queue. Ordinary global
supervision retains its existing cadence. The auth fence keeps SHARE locks because KEY SHARE
would permit non-key changes to account status, expiry or capability revision during persistence.

Moving the consumer to the worker is unavailable through the existing least-privilege interfaces:
the worker cannot read the required Better Auth/device/capability rows or mutate capture grants,
and the app queue role cannot claim or complete jobs. No suitable existing worker-callable auth
status port was found. A safe relocation would need a separately designed facade; distributing
general app/auth credentials to the worker is not the chosen repair. Under the owner's explicit
fallback, the API retains the consumer and development Compose supplies its missing worker-role
URL. Production Compose, its env example/setup generator and its smoke builder already provide
that URL; their requirement is documented and checked. This changes deployment source only.

The account-export collector already normalizes timestamp arrays to JSON ISO strings. Its
independent database fixture only handled scalar dates, producing incorrect expectations for
`startedAt`. A regression exposed that mismatch; fixture array normalization fixes it without
changing the collector, column allowlists or grants.

The hosted Mac Release build and installed SDK check passed, but XCTest exposed a queued control
request creating a task after URLSession invalidation. The repair serializes request admission
with close, owns and cancels control tasks, and checks their generation before dispatch. The
late-permission and explicit-Resume tests join their actual tasks while preserving expiry and
no-capture assertions. The repaired native tests still require hosted execution.

Settings statuses now wrap beneath the Mac name, with controls in a separate column that stacks
at narrow widths. The owner explicitly requested screenshots. The supported cloud browser
rejected both file URLs and the loopback preview, so no screenshot or visual pass is claimed.
Self-contained normal/narrow, light/dark fixtures render the real component with fictional data;
they are included in the handoff for owner-side viewing, not represented as live-product proof.

Repair verification: the broad 83-suite group passed 1,077 tests, and the separate deployment
configuration suite passed its three tests, for 84 suites and 1,080 tests total. All six TypeScript
configurations, full lint/format, the required static checks and the production web build passed.
The independent export-oracle regression failed on the original Date-array mismatch and passed
after correction. All 15 server guard-removal checks failed their intended named assertions and
passed after restoration. Both native negative-runner anchor/harness checks passed; those are
not native XCTest execution. Independent backend and native source reviews found no remaining
blocking issue. Repaired real-PostgreSQL, Compose, browser, native XCTest and live TLS/hardware
proof still require hosted or owner execution. The known stacked 0292 collision report is not
addressed by renumbering Part A.

## Publication

Use explicit-path local commits and preserve a clean worktree. Publish only the new feature
branch additively and open a draft stacked PR. A publication refusal or failure stops further
attempts; supply the complete base-to-HEAD format-patch series as a ZIP attachment, with hashes
and an independent fresh-base apply proving the final tree. Do not try an alternate publication
route after a rejection.

The product PR includes its own release note and accurate control/test status. No PR merge,
production change, device-permission action, credential operation or real recording is authorized.
