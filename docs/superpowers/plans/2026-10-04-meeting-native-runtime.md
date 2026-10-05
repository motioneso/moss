# Meeting native runtime checkpoint (#2981)

Approved product design: [meeting companion](../specs/2026-10-03-meeting-companion.md).
This is an internal native implementation checkpoint, not an enabled recording feature.

## Scope and ownership

Add a Meetings-owned native subsystem under `apps/trail-marker/TrailMarker/Meetings/`,
with synthetic tests under `apps/trail-marker/TrailMarkerTests/`. Keep it separate from
Backtrack's Debug-only screen-text pipeline and from screenshot capture. No runtime is
created from the app entrypoint in this checkpoint. No audio is recorded during development
or automated tests; tests inject device services and generated sample buffers.

Implement concrete Core Audio output and selected-microphone adapters behind injected
resource interfaces. Add a serial orchestrator, deterministic session rules and bounded
transient audio handling. Adapters are inert until explicitly started by their caller.

## Files and responsibilities

- `MeetingAudioTypes.swift`: explicit capture selection, source identity, epoch, clock and
  sample contracts; source labels never imply speaker identity.
- `MeetingAudioBuffer.swift`: bounded per-source transient queues; sample/time boundaries,
  sequence identity, overflow and expiry outcomes; no filesystem or network access.
- `MeetingCaptureRuntime.swift`: explicit Start/Pause/Resume/Stop, generation fencing,
  two-track startup rollback, deterministic cutoff and finalization/send eligibility.
- `CoreAudioMeetingOutput.swift`: macOS 14.2 guarded process taps, private aggregate device,
  IOProc, explicit process object membership and reverse-order cleanup.
- `MeetingMicrophoneCapture.swift`: AUHAL input bound to the selected AudioDeviceID,
  without changing system-default devices; callback and teardown management.
- `MeetingCaptureTests.swift`, `MeetingAudioBufferTests.swift`, and adapter resource tests:
  generated frames and injected services only, never live microphone or system audio.

## Capture and timing rules

Keep the host's macOS 14.0 target. Guard output taps at macOS 14.2; unsupported versions
return an explicit unavailable outcome. Microphone-only starts no output resources.
Selected-app capture requires a nonempty explicitly resolved set of Core Audio process
object IDs. The caller must validate membership against the selected app instance and
helpers; this checkpoint does not claim a PID alone identifies a Teams/Zoom process tree.
Computer mode requires explicit process exclusions, including the host and its helpers.
Never fall back from selected-app to computer capture.

Tap creation uses CATapDescription and AudioHardwareCreateProcessTap; a private aggregate
provides the input stream. Do not mute normal meeting playback. Each successful acquisition
has a matching release; partial startup failure rolls back in reverse order. Microphone
uses AUHAL with input enabled, output disabled and the explicitly selected current device.

Both tracks preserve host-time timestamps relative to one session origin. Callbacks never
perform network or file work. Copy owned samples before returning; do not retain pointers
owned by Core Audio. Bounded callback storage and later conversion prevent an unbounded
queue of asynchronous sample-processing tasks. Format or clock discontinuities stop the
route and require a new epoch, rather than silently reinterpreting samples.

## Lifecycle and transient buffering

Start is explicit and fails if either required source cannot start. Pause closes capture
and send admission before device teardown, and invalidates late callback generations.
Resume requires explicit source selection and permission to send retained pre-pause audio;
it starts a new epoch. No reconnect, restart or generic host Resume All restarts recording.

Stop fixes one immutable monotonic cutoff. It closes capture admission, releases devices,
and allows only retained samples ending at or before that cutoff to be finalized. A final
partial chunk is retained; post-cutoff samples cannot be sent. Duplicate Stop does not
extend its deadline. Finalization is bounded to at most 60 seconds and distinguishes drained
from deadline-expired. Already submitted work is separate from a new send.

Raw audio is memory-only in this checkpoint. Bound queue duration and bytes per source.
The duration cap is 60 seconds with a warning at 30, but the separate default limit of
1,048,576 samples fills after about 21.8 seconds at 48 kHz. The first exhausted limit wins;
this is not a promise of 60 seconds of backlog. Overflow/expiry must return a
visible gap/failure outcome rather than silently dropping audio or allocating indefinitely.
No optional recovery buffer or disk export is implemented.

## Dependencies before enabling recording

A later coordinated host slice must provide capture-focused controls, visible recording
indicators, source health and permission remedies. It must integrate Pause All, logout,
account switches and application termination with teardown barriers before changing identity
or exiting. Backtrack indicators must coexist without inheriting its consent.

That slice must add microphone/system-audio usage descriptions and review the release
microphone entitlement. Read-only preflight must never start a tap-containing aggregate as a
permission test. Apple documents that first recording from such an aggregate prompts for
system-audio permission. No permission prompts or changes are performed by this checkpoint.

Separate meeting-device approval, scoped credentials, revocation, server owner/session
binding and bounded audio ingest are prerequisites to submission. Existing `tm1_` companion
authorization remains unchanged. The server authorization checkpoint is planned separately.
Adapters do not access existing companion credentials or infer approval to send audio.

Connecting capture to configured timestamp-aware ASR, independent speaker processing,
server lifecycle/transcript persistence, and approved UI remains necessary for a useful
vertical path. No dead adapter checkpoint is represented as a finished recorder.

## Verification and release boundary

Run available static/source checks locally without recording, OS permission changes,
credentials or system settings. The current Linux development environment lacks Swift and
Xcode, so it cannot validate native compilation. After review, the existing macos-15 CI job
can compile real adapters and run injected synthetic XCTest cases. No workflow permission
expansion is required. Add a Release compile-only check with code signing disabled to catch
configuration-specific errors; it creates no distribution artifact and activates no capture.

Synthetic coverage includes every startup failure and cleanup order, mic-only no-output,
source-scope rejection, repeated Stop, Pause/send races, late callback rejection, exact
cutoff trimming, retained-audio consent, numeric/time boundaries, buffer limits and expiry.

Mac CI is not native capture proof. Real approved tests on macOS must later establish
actual permission behavior, Teams/Zoom process membership and isolation, output-device
coverage, synchronization, microphone/headset changes, app restarts, Moss playback exclusion,
and device release. Signed distribution and live UI acceptance remain separate gates.
No Windows host decision is made here. No merge or deployment is authorized by this plan.

## Primary API references

- [Apple Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- [Apple AUHAL input and device selection](https://developer.apple.com/library/archive/documentation/MusicAudio/Conceptual/CoreAudioOverview/ARoadmaptoCommonTasks/ARoadmaptoCommonTasks.html)
- [Apple microphone authorization](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos)
- [Apple PID-to-process-object property](https://developer.apple.com/documentation/coreaudio/kaudiohardwarepropertytranslatepidtoprocessobject)

## First native compile checkpoint — deb403c7

[Mac CI](https://github.com/motioneso/moss/actions/runs/37186127734) passed on
`deb403c796583f8a04cacc5f481c519ba4425234`: unsigned Release build, Debug build, all 54 new generated-
sample/fake-device tests, 308 existing unit tests and five UI tests. No capture hardware was opened
by the new tests, and the host still creates no meeting runtime.

The compiler exposed two new pointer-bridging warnings despite passing tests. The follow-up reads
caller-owned tap UID values into explicit unmanaged storage before retained transfer to ARC, and
replaces an unconstrained AUHAL generic setter with seven concrete C payload writes. Four new
synthetic UID tests bring the meeting count to 58. A bounded read-only Mac CI diagnostic checks the
ownership paragraph in the installed Apple SDK; it does not infer hardware behavior from a mock.
These follow-up builds/tests and warning clearance require a new Mac CI result before verification.
