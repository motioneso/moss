> Current design authority: the [minimal Meetings spec](../specs/2026-10-06-meetings-minimal-design.md) and its [canonical corrected screens in #3087](https://github.com/motioneso/moss/tree/c6d4f08a052a2fc714c794e645aa6ad994a59601/docs/superpowers/specs/meetings-setup-wizard), including the owner's latest linking and native-control corrections. The #3087/#3089 screen approvals were given in owner chat on 2026-10-06. Historical R/T identifiers below remain traceability labels.

# Meetings Mac link: Part B (#2981)

Status: approved implementation, draft pull request only. No merge or deployment.

## Source and branch

Historical starting point: repaired, published Part A, PR #3079 at `1b1e459c4d0ea87e3e13d11b1093e4f853b58673`,
tree `a0f3403b0de7f5d72d69efab60d67be036dd3c13`. The branch is
`feat/2981-meetings-mac-link`, with intended PR base `feat/2981-meetings-minimal`.

Current builds follow the local approved controls and test matrix in
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md`. Its source and owner corrections
are recorded in that spec and its own mockup folder. Do not build against an earlier pinned
#3077 snapshot or the superseded recording-pill concept. Preserve published branch history and
integrate the current reviewed stack additively; the baseline above is provenance, not a reset target.
The later execution sections below are historical verification records, not current build instructions.

Use the existing browser pairing approval, companion logout, browser-session and capture-grant
flows. The single initial owner approval also grants the exact Mac's recording capability with
its independent native-held proof and policy revision. There is no separate Approve recording /
Deny recording card or recording-disclosure paragraph after linking. Retired capability
attempt/decide mutations return **410 to authenticated callers** after their existing credential,
owner/session and origin checks; retirement does not make those endpoints anonymous.

Already linked Macs lacking authoritative recording approval, and Macs with revoked recording
access, must use the real normal relink flow: explicitly sign out the device under Settings →
Active sessions, then relink through Trail Marker and approve the new link. Do not silently
upgrade a legacy device or revive revoked grants. Read-only recovery may restore only an exact
previously approved candidate whose owner, device, policy, proof and revision still match live
authority; it cannot create an approval attempt or new authority.

Every initial Start remains a deliberate browser action. Creating, opening, linking and
reconnecting must never start recording. Linking grants app capability, not OS microphone or
system-audio permission. Preserve the meaning of those OS permissions and independent Backtrack
consent, toggles and buffer policy. The native first screen's Moss address input remains part of
the existing linking flow and is explicitly out of scope. The browser's not-linked Meetings
screen still omits the Moss address and copy control.

The current approved design requires a draggable native **222 × 32 pure-white capsule**, including
in dark appearance, above windows on every Space. It contains exactly **three red bars** driven by
actual captured audio, a circular Pause control with a grey ring, and a solid semantic-red Stop
control with a filled white square (`stop.fill`). No zigzag waveform, visible text, elapsed timer,
or meeting name. The always-visible X only hides the pill; the red Meeting menu retains Pause/Stop
and Show recording pill, and the next recording shows the pill again. Silence, absent/stale input, Pause and terminal states flatten all
three bars. Keep the menu-bar red dot through Pause until every terminal path clears it. No system
notification or browser audio-level transport is added.

The paused capsule's explicit play-button click may Resume only the existing **paused, claimed**
grant. Retain its exact source selection, owner, device, connection, starting browser session,
recording capability, current generation and expiry bounds. Native Resume creates neither an
initial Start nor fresh authority, cannot change sources, and cannot revive terminal or expired
authority. Keep normal server authorization/status application on this path; do not open capture
hardware or resume uploads until authoritative server acknowledgment and status permit it.
A known rejection or a newer Pause/Stop cancels the queued Resume. Known rejection requires a new
explicit click. An uncertain transport result may retry only the same request identity under its
existing bounds; it cannot create a replacement grant or extend expiry. Browser Resume remains
available. The native microphone/system-audio menu changes only the current recording through
an explicit generation/epoch-checked source command. Paused changes stay paused; both-off is
rejected before disturbing capture. Current grant proof and expiry remain unchanged.

The recording capability has no independent expiry; it ends on Unlink, revoke or device expiry.
Device expiry remains 90 days of inactivity and a 365-day absolute bound. Hardware-bound
credentials remain deferred: document a narrow future integration point, without implementing a
new secret or authentication flow.

## Control mapping

| Control | Required implementation and review scope                                                                                                                                           | Proof                                |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| R1      | Settings Unlink uses the canonical owner device deletion transaction; subsequent native credentials fail and post-commit audio is refused                                          | T1                                   |
| R2      | Mac Unlink confirms logout before deleting both Keychain items; failed logout retains credentials and visible retry state                                                          | T2, T13                              |
| R3      | Meetings settles invalid bindings as revoked, discards unsent native audio, and exposes the unlink/revoke reason within one lease                                                  | T1–T3                                |
| R4      | Preserve claim, lease, hard-cap and session/device/connection bounds on every live capture operation                                                                               | T5                                   |
| R5      | Preserve the starting browser session binding through local and everywhere-else sign-out                                                                                           | T4                                   |
| R6      | Each accepted Start shows the floating pill and menu-bar red dot; actual captured levels drive three red bars on a white capsule, and every stop path clears both; no notification | T12, T14                             |
| R7      | Single initial linking approval includes recording capability; no second card/disclosure, no record-on-link, and no initial native Start                                           | T12, T14                             |
| R9      | Capability remains valid without a Start for more than 90 days when the device remains valid; Unlink, revoke and device expiry still end it                                        | T9                                   |
| R10     | Preserve per-IP limits; add shared per-account Start limits of 10/minute and 60/hour with Retry-After                                                                              | T10                                  |
| R11     | Trace bearer/proof/verifier/grant secrets through logger, queues, export, AI and response consumers; add authorization-header redaction                                            | T11                                  |
| R12     | Settings offers device Unlink; existing recording-capability revoke stays enforced; Mac offers truthful Unlink                                                                     | T1–T3, T13                           |
| R13     | Preserve exact saved-source selection, inventory checks and source-unavailable refusal; native Resume retains the paused claimed grant without widening authority                  | T6, T7 plus saved-source regressions |

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

The earlier recording-pill concept is superseded. Use the approved #3087 recording state linked
from the updated minimal Meetings spec: 222 × 32 pure white, three red level bars, grey-ring Pause
and filled-square Stop. Direct native Resume is bounded as above. Neither mockup is installed-app
or live-capture proof. Hardware binding remains deferred at the
credential storage/server verifier boundary.

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

The original Part B allocation reserved 0295 for Meetings account rate-limit state; PR #3071
owned 0289, 0291, 0293 and 0294, and Part A owned 0292. Treat that allocation inventory as
historical and verify current claims before any future migration. This linking/control correction
adds no migration and leaves all existing SQL unchanged. Never edit applied SQL. Any separately
authorized future table or migration must update the foundation schema catalog and affected
export, deletion and role fixtures.

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

## CI follow-up on the published review repair

The owner published the first review repair at
`7fea89d7469d265e90d8ceddc6fc692384d37063`, tree
`997b1f5ba65b135a50979878adbfc00e448c2077`. The next patch contains only the four subsequently
reported CI corrections and is based on that published head. Compose smoke passed on that
baseline; the deployment fallback and SQL migrations are unchanged in this follow-up.

`OwnedPgClient` previously extended `pg.Client` during module evaluation, breaking unrelated
database/auth imports whose pg mock only provided Pool. Both the client subclass and the
underlying maintenance pool now initialize on first use. An unused pool can be closed without
constructing either, and close remains terminal. The original Pool-only mock is preserved.

Maintenance also attempted to start a producer it borrowed, breaking notification-digest's
send-only injected queue clients. The API composition root now starts and awaits only the
producer it owns. Maintenance borrows the send port and still starts, registers and drains its
own consumer. Producer failure blocks consumer startup; consumer failure still blocks readiness.
This restores lifecycle ownership rather than skipping a required production startup step.

The hosted real-auth positive gate passed all 47 tests, then the hourly guard-removal proof
stopped because Vitest rendered the expected rejection mismatch as an Error wrapper. Removing
the hour guard reaches the independent SQL cardinality constraint, whose database error lacks
the required HTTP 429 contract. The test now checks that contract with a named scalar assertion,
and the runner requires both its marker and exact failure shape. The unchanged SQL CHECK stays
enabled throughout. A portable regression feeds the installed Vitest assertion into the actual
recognizer; the old matcher failed and the corrected matcher passed. Raw database, setup and
unrelated failures remain rejected. The repaired hosted red/restored-green loop remains pending.

The Mac positive XCTest suite and existing audio negative controls passed. The new captured-level
mutation correctly produced zero instead of the actual 0.75 peak, and the restored test passed.
Its runner incorrectly expected `XCTAssertEqual failed` instead of XCTest's
`XCTAssertEqualWithAccuracy failed`. Only that control's matcher and its portable regression
fixtures change. Production Swift, captured-level publication, clocks and waveform assertions
are byte-unchanged. The real report is now recognized while unrelated assertions, setup/crash,
empty runs and wrong exits remain rejected. No new local Mac execution is claimed.

Independent backend and native-harness reviews found no blocking source issue. Four lifecycle
guard removals and both proof-recognition regressions were observed failing before restoration
and passing afterward. The seven notification-digest database cases and the corrected hosted
database/Mac proof runners still require reruns; unit lifecycle and parser checks do not replace
them. This follow-up makes no additional Part B changes and does not renumber the stacked 0292.

Final local follow-up verification passed 87 relevant suites and 1,089 tests, all six TypeScript
configurations, full lint/format and required static checks. All 15 database-free server negative
controls again produced their intended failures and restored passes. The native runner's 12
anchors and portable recognition self-tests also passed. No local real-database or new native
execution is claimed for this candidate.

An additional API bundle attempt stopped before bundling: the executor's pnpm wrapper tried to
bootstrap into an unavailable directory. The app-map generator passed directly, but a standard
API bundle is not claimed and remains a hosted check.

## Live-recording follow-up on 387caf4ad

Three issues found during an owner-run recording are repaired together. A genuine native paused
report that causes the server's automatic Pause now acknowledges that exact new generation.
Older reports cannot regress it; error-only and unrelated Pause requests still require a real
acknowledgement. The Mac also acknowledges a newer Pause while already safely paused, without
reopening devices. At that historical baseline, Resume was browser-only; the current explicit
native Resume contract in Source and branch above supersedes that restriction.

Provider segment ends may overshoot the admitted clip by at most 100ms, inclusive, and are clamped
before persistence. A 101ms overshoot, invalid start, nonfinite value, reversed or empty interval
still fails. Native wire boundaries use the same upward rounding of cumulative sample time at
both ends, avoiding truncated cumulative coverage without creating overlaps or accumulating drift.
The integer wire representation still has less than 1ms of per-clip quantization; PCM duration
validation and conservative Stop bounds remain in place.

Native terminal failure reports reuse the upload request key, exact wire interval and server gap
reason. Expiry reconciliation uses the same receipt identity, and a processing failure returns a
receipt finalized by reconciliation instead of adding a conflicting gap. The transcript collapses
exact duplicate source/epoch/interval/reason reports while retaining raw diagnostics and distinct
gaps. Older near-overlapping reports are not merged speculatively.

Regression checks exercise real service and Fastify route code with repository fixtures, plus web
components with unit transports; these are not live database/browser proof. Native XCTest covers
sample boundaries, the already-paused acknowledgement and terminal receipt identity. This Linux
executor has no Swift/Xcode or Docker, so native execution and isolated database proof remain hosted
or owner checks. The repaired live-recording path must still be exercised on the linked Mac.

Local verification passed 1,010 tests across 71 relevant files, all six TypeScript configurations,
full lint/format and required static checks. The pause, duplicate-gap, expiry-order and rounding
regressions were observed failing before correction and passing afterward. Removing the 100ms
limit made the 101ms rejection test fail, then pass after restoration. Independent review found
and verified fixes for two conflicting-gap edge cases and ended with no remaining source blocker.
Native source/anchor self-checks and portable sample-clock arithmetic passed; they do not replace
the new XCTest cases or the owner's real-recording rerun.

## Publication

Use explicit-path local commits and preserve a clean worktree. Publish corrections additively to
the existing draft feature branch, checking the expected remote head before a fast-forward update.
Preserve the tested tree exactly. Do not overwrite a newly advanced branch or bypass an access
denial. If a patch handoff is needed, include the complete base-to-HEAD series, hashes and an
independent fresh-base apply proving the final tree.

The product PR includes its own release note and accurate control/test status. No PR merge,
production change, device-permission action, credential operation or real recording is authorized.
