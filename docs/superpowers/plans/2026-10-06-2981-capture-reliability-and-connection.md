# Meeting capture reliability and shared connection repair (#2981)

Approved product direction: 6 October 2026. Implementation issue: [#2981](https://github.com/motioneso/moss/issues/2981).
Continue draft [PR #3056](https://github.com/motioneso/moss/pull/3056) from
`28a5a6beb4bfb728566682fb59885ddc1686528e`; do not merge or deploy.
The [specification](../specs/2026-10-03-meeting-companion.md) governs this repair.
The [6 October review](https://github.com/motioneso/moss/pull/3056#issuecomment-6014073490)
clarifies that account-scoped versioned notice belongs in #3056, before the minimal-screen redesign.

## Outcome and scope

Connect the companion once, shared by its connection UI, Backtrack and Meetings. Thereafter:
New meeting → remembered named device/microphone/source → Start meeting. Change is available,
but Prepare and per-meeting device approval are removed. The recording notice is shown once per
account, stored on the server against its text-policy version, and checked before Start and record/Resume, including command replays. New meetings
and browsers reuse it; only a notice-version change asks again. The recording grant binds that
version. Pause, Stop and cancellation never depend on notice acknowledgement. An optional
title must not delay Start or lose typing. Connection completes in the existing browser tab.

Keep recording through ordinary jitter, unchanged format notifications, brief network gaps and
individual transcription failures. Display capture, connectivity and transcription separately.
Keep local Pause/Stop and a persistent browser recording control available during navigation.
Remember only explicitly selected sources; missing sources never authorize a broader fallback.

Moss may remain on a remote/headless server; the chosen client owns the audio hardware. Windows
native capture and diarization remain separate unfinished work. No real credentials, OS grants,
provider use, workplace recording, persistent DB changes, merge or deployment are performed here.

## Baseline evidence and unresolved symptoms

The published branch and this cloud checkout were unchanged at diagnosis. The owner's additional
reason logging is not published; preserve that local patch and compare it before the owner pulls.
Do not claim its bytes were reviewed or overwrite it with a checkout/reset.

Confirmed against unchanged source with bounded synthetic probes:

1. Fastify's default AJV `removeAdditional` mutates the `oneOf` selection while trying the
   microphone-only branch. The exact route schema accepts mic-only and rejects both output modes.
   Use a non-mutating discriminated contract; do not loosen global validation.
2. Every microphone format notification is fatal without verifying a changed format. A host-time
   difference above two samples and one transient try-lock miss also permanently fail capture.
   Existing tests assert these brittle policies and must be replaced with realistic regressions.
3. Flooring chunk start but separately ceiling duration manufactures a 1 ms overlap from perfectly
   contiguous samples. One realistic initial phase accepts two chunks and rejects the third with
   HTTP 409. Use consistent sample-based cumulative boundaries and preserve strict Stop cutoffs.
4. A terminal failed ASR receipt pauses both native tracks. Provider rejection, timestamp overrun,
   route mismatch and transcript persistence failure collapse to the same processing-failed code.
   Separate processing outcome from capture lifecycle and add safe stage-specific reasons.
5. Stop leaves an active grant that blocks new redemption, while native teardown discards the
   credential. Model finalization explicitly and release the recorder slot without manual revoke.
6. React Query's deferred notifications roll a controlled title input back between rapid DOM
   events. Use synchronous editing state with separately persisted signed-in recovery state.
7. The display timer is grant age, including idle/paused/failed time. Add acknowledged recording
   duration; keep the transport clock as a separate quantity.
8. Polling continues after Stop and after a 429 with Retry-After. Uncertain commands can disable
   Pause/Stop indefinitely. Bound requests, honor server backoff and prioritize Stop.

Do not overstate these findings:

- The owner's actual third ASR processing-failure reason is still unknown. The proven timestamp
  conflict happens before ASR and is a different response.
- A 6-second successful status request exceeds the current 5-second watchdog, while its request
  timeout is 8 seconds. The source does not serialize status behind ASR; the precise observed
  delay still needs bounded request/startup-stage evidence.
- Roughly 210 scheduled control/read requests per minute is excessive, but does not identify the
  owner's actual rate limiter. Test total traffic and Retry-After behavior rather than guessing.
- Recording → History works in the published React DOM probe. Preserve that navigation and add
  persistent controls; do not claim a route lock was reproduced. Local differences remain unknown.
- A measured 75 ms Stop is within the existing one-second target by itself.

## Design and authorization contract

### One connection, explicit recording capability

Auth owns a versioned owner/device `meeting-recording` capability with consent time, expiry and
revocation. Fresh supported pairing presents that capability as part of the single connection
approval. Already paired devices start unapproved and receive a clear one-time connection upgrade.
No background migration grants recording access; Backtrack's existing consent and buffer policy
remain unchanged. Keep independent native-held recording-capability proof in the Keychain, granted
inside that same approval, so a stolen legacy connection credential alone cannot impersonate a new
recording connection. The server stores only its hash or public verification material.

The companion credential remains identity-only. Readiness and command-bootstrap operations also
require the separate capability and independent proof. They cannot read arbitrary meetings or audio. The browser's one
Start authenticates owner/session, exact device and current connection generation, source choice,
processing availability and expected readiness revision. It creates only a bounded Start command
and short-lived exact meeting/device authority. A connection alone cannot create that command.

The current connection is bound to a native-generated ephemeral verifier, not a client-supplied
connection ID alone. The client claims only a fresh command for that connection. It keeps one
per-Start bearer secret locally and binds its hash exactly once; retrying a lost claim recovers
activation metadata for the same authority without starting twice or retaining plaintext credentials
in the DB. Changed hashes conflict.
Restart/reconnection fences old commands. Derived authority is invalid after device/capability,
owner-account or approving browser-session revocation. Existing `tm1_` cannot call audio,
transcript or capture-control routes. Verify the whole issuance/claim/upload path with negative
controls rather than relying on token prefixes alone.

Use new migrations only; 0284 has been used in owner testing. Auth exposes a public capability
port; Meetings owns readiness, command/session state and transcript processing through that port.
Do not query another module's private tables or extend `AccessContext`.

Capability approval/upgrade uses cookie-only authentication, rejects Authorization headers, checks
trusted Origin and fresh owner/session, and binds the server-known device and displayed policy
revision. Re-approval advances the capability revision; old meeting grants never revive. Serialize
Start per device connection, not only per meeting, so two tabs cannot start two hardware sessions.

Stop during an uncertain Start atomically cancels that original request identity, even if Start
has not reached the server. Retain a cancellation tombstone under the same device/meeting locks;
a late original request cannot resurrect it. Stop must never retry Start as a reconciliation
strategy. A command stopped before native claim receives a truthful stopped-before-capture
acknowledgement. Pause before claim likewise acknowledges no inputs opened, and explicit Resume
can requeue the same bounded authority. Existing successful Start retries resolve their original
result before testing readiness for a new Start.

### Runtime and retention

Source identity is microphone UID plus stable app identity, resolved to the current process scope
before explicit Start. App restart during capture still pauses for explicit Resume. Device loss,
real format discontinuity, revoked authority or exhausted bounds remain visible stop/pause causes.
Do not equate a notification, host-clock jitter, brief callback contention or one ASR failure with
those conditions. Avoid blocking allocation/locks on audio callbacks.

Use sample-based continuity with a measured monotonic host-clock mapping. Wire boundaries must
remain consistent over long runs, both sources and fractional milliseconds. A tolerance must not
permit post-cutoff audio or silently relabel missing samples as captured.

Retain bounded transient memory only, no new disk spool. Preserve the existing maximum 60-second
age and explicit sample/byte/process limits or reduce them, report the effective shorter capacity
at high rates, warn before exhaustion, and visibly pause when no safe capacity remains. Keep
fair per-source scheduling. Retry transient processing/network failures with the same chunk key,
configured route and bounded backoff; terminal failures release only that chunk and record a gap.
Do not promise recovery after discarded audio, a crash or arbitrary offline duration.

Capture and finalization ownership are distinct. Stop closes inputs within the target, fixes the
cutoff and drains only pre-cutoff audio for at most 60 seconds. Acknowledged cleanup releases the
recording slot; finalization acknowledgement/deadline retires its grant. New meetings cannot reuse
the old transcript/clock or leave the UI permanently busy. Pending finalization remains visible.

Choose coordinated request deadlines and a finite offline/lease budget that tolerates brief gaps;
the watchdog must not expire before a normal request can finish. Reconnection resumes transport
only while the same acknowledged capture remains within that budget; a paused/expired capture
requires explicit Resume. Local Pause/Stop must work even when a web command or ASR request hangs.

### UI and state distribution

Use the existing design system and shared controls: a concise source summary, optional Change,
one Start, and persistent Recording/Paused/Stopped controls. Show Transcription delayed separately
from actual capture. Freeze the recording duration on acknowledged pause/error or stale status;
show zero before successful Start. Do not turn authorization age into a recording timer.

Centralize capture state/revision delivery. Prefer bounded long-poll/conditional snapshots or an
existing event seam over independent interval loops. Test control-plane request volume, eliminate
duplicate subscriptions, stop terminal polling, and honor Retry-After and hidden-page behavior.
Fetch transcript only when its revision changes. Reads should not repeatedly rewrite unchanged
state. Keep bounded same-key retry/reconciliation behind the UI with a Stop-priority path.

Keep active input state synchronous. Persist recovery separately with owner/session identity guards
so sign-out/navigation and late responses cannot restore another user's edits. Verify real DOM
typing, not only test-renderer callbacks with an `act` flush between every keystroke.

## Implementation sequence and ownership

1. Commit this design checkpoint before source lanes start. Freeze the shared wire contract and
   obtain independent authorization-design review before implementing grant changes.
2. Server/auth lane: new capability migration and connection approval, public auth port, readiness/
   Start/claim/finalization contracts, non-mutating schemas, safe ASR reasons/retry classification,
   bounded status/revision delivery and database isolation tests.
3. Native lane: shared connection claim loop, generation fences and one-time permissions; robust
   audio admission/timestamps and fair queues; independent processing outcomes, local lifecycle
   barriers, no automatic browser launch, and safe diagnostics outside realtime callbacks.
4. Web lane: connection upgrade integrated with existing connect UI, remembered sources and single
   Start, persistent controls, synchronous title/notes edits, acknowledged duration and bounded
   query/retry behavior. Keep the app map truthful in the same change.
5. Integrate and independently review the full path. Publish new commits without overwriting the
   owner's unpublished diagnostic patch. Update PR #3056 with exact-head evidence and limitations.

## Required regression and acceptance evidence

- Real Fastify validation plus emitted native-envelope fixtures for all three source modes.
- Unchanged format notice, valid sample progression with realistic host jitter/drift, true sample
  gaps, callback contention without false full-buffer, capacity exhaustion and device unplug.
- Thousands of contiguous fractional-ms chunks, exact idempotent retries, two-source fairness,
  immutable Stop cutoff and protection-removal failures proving no late-audio admission.
- Slow status alongside slow ASR; a single 429/5xx/parser/persistence failure; backoff; pending vs
  processed receipts; recovery within memory bounds; explicit gaps/paused state after exhaustion.
- Start retries/lost claim, wrong device/owner/admin, old connection generation, revoked capability,
  legacy device without consent, expired session, and one-time upgrade. No auto-start on connect.
- Stop → finalized → New → Start, plus new meeting while prior bounded processing is finishing,
  if supported. No hidden active grant or permanently disabled Stop.
- Real DOM rapid typing, transient failures, repeated clicks, tab/list navigation, browser stayed
  in place, persistent controls, accurate duration and measured request counts/Retry-After.
- Root/test/native type/build checks, lint/format/file-size/app-map gates, isolated DB integration,
  generated-audio browser/API UAT and Mac XCTest on the exact published head. Re-run meaningful
  negative controls after changing the corresponding guards.

Docker and Xcode are unavailable in this Linux workspace; use the existing supported isolated
GitHub-hosted gates. Never use a shared DB or real provider login as a shortcut. New synthetic
passes are not proof of the reported Mac failure being fixed. Owner-run hardware/permissions,
chosen-app isolation, latency and real-provider acceptance remain required before release.

## Comparison principles

Meetily is a source reference, not a reliability guarantee. Its manual-start flow and separation
of capture/processing are useful; permission false-success, discarded processing failures and
unbounded paths must not be copied. Granola's first-use permission then deliberate meeting-start
flow is the UX reference. Keep Moss's provider routing, remote-server architecture, privacy limits
and visible gaps. No external source code is copied as part of this design checkpoint.

References: [Meetily source](https://github.com/Zackriya-Solutions/meetily/tree/a2cb62e827da7ef59f65064c97233efb2313878e),
[Granola manual-start policy](https://www.granola.ai/security), and
[Granola first-use setup](https://www.granola.ai/blog/how-to-use-granola-with-zoom).
