# Vocci resumable long recordings implementation plan

Status: planned; implementation has not started. Implements section 3 of the approved [companion spec](../specs/2026-10-20-vocci-companion-meetings-chat.md). Tracking: task #3553, draft PR #3554. Each step must be implemented and verified before claiming support for long recordings.

## Boundaries

- Meetings owns immutable source reservation, binary chunks, completion validation and transcript-window checkpoints. Chat continues through its public admission boundary.
- Vault filesystem access remains inside VaultContext. Add bounded immutable byte publication and bounded reads/capacity operations there; never raw filesystem in Meetings.
- Android retrieval writes temporary files, restarts BLE reads from zero, then streams MediaCodec output into canonical 16 kHz mono WAV. HTTP resumes independently.
- A two-hour recording may have 32 MiB packets, 256 KiB sidecar and 256 MiB WAV; chunks <= 1 MiB. Validate exact hashes, packet continuity, sidecar completion and WAV geometry before transcription. Supplied WAV is evidence, not hardware attestation.

## Server approach to validate before coding

1. Reserve immutable manifest and source identity under the same owner/source advisory lock as existing imports. Keep version 1 behavior immutable. Durable reservation precedes any vault writes. New transport is explicit; reject conflicting destinations/bytes.
2. Keep fixed indexed immutable binary chunk files; do not assemble/base64 the entire source. Persist received positions and SHA256 checks in owner-scoped upload records. Publish bytes before acknowledging database progress; exact replay repairs a lost acknowledgement, changed bytes return 409. Bounds cap metadata size.
3. Reserve disk space before acceptance, including active reservations; statfs alone does not reserve capacity and can overbook concurrent owners. A portable bounded physical-reservation file is an option; define crash recovery and expiry before implementation.
4. Finalize after complete coverage and incremental whole-file hashes. Validate packets across chunk edges using <= 257 byte carry; validate canonical 44 byte WAV header and aligned duration; sidecar bound 256 KiB and duration field must accept seven digits for 7,200,000 ms.
5. Transcribe one bounded non-overlapping PCM window per job. Offset segment times, use stable window/segment IDs, and atomically commit transcript and next-window checkpoint. Reset attempts per window. Job expiry of 120 seconds means one whole two-hour provider call is invalid. Schedule the next job transactionally and summarize only after the last window.
6. Maintain import/meeting row lock order during dispatch, deletion and commits. Define user transcript editing during in-progress import; never overwrite external revisions silently. Protect retained-window hashes on reads.
7. Add scoped grants/RLS, module deletion/export declarations and fixtures, expired-partial cleanup, API delegated-access guards and truthful app-map entries. Verify guards with actual negative controls.

## Android approach

1. Replace RingProtocol.Transfer byte accumulation with a file sink retaining exact expected sizes/end frames; publish only complete reads. Keep short tests supported without a second protocol implementation.
2. Decode retained packets incrementally. Use bounded MediaCodec input/output, downsample 48 to 16 kHz with carry across output buffers, write WAV header after successful completion, and atomically publish. Do not keep original PCM or full WAV in memory.
3. Reserve enough local storage for sources and derived audio plus free reserve. Current 100 MiB queue capacity cannot hold a two-hour recording. Expand bounded retention deliberately; failed/queued recordings remain preserved.
4. Persist immutable manifest/source/destination before first HTTP reserve. Query server progress on restart and send missing chunks from files. Handle lost responses, owner/source mismatch, duplicate/conflicting chunks, expiry and processing status. Do not silently send existing evidence as a new voice command.

## Validation

- Packet/WAV/sidecar parser boundary tests: split headers and packets at every chunk boundary; malformed sequence, hashes, sizes, timestamps, and 2h + 1ms rejection.
- Actual scoped upload integration: new owner, restart/progress, concurrent identical reserve, duplicate/changing chunk, lost ack, incomplete finalize, finalization replay, owner isolation, expiry and deletion. Observe RLS/delegation negative controls.
- Window integration: crash before/after checkpoint, stale attempt, retry exhaustion per window, empty windows, clipped/out-of-bounds timestamps, stable segment IDs, one final summary. Check transcript read/output budgets accommodate 2h.
- Android host framing tests, APK build and installed MediaCodec/instrumentation. Device proof needs an attached authorized ring/phone.
- Live UI: real meeting longer than 2 minutes, then the 2h boundary; retain bookmarks, transcript and summary/action review. Separate generated stress fixtures from hardware claims.

## Open implementation facts

- Current RecordingImportService has a 35 second whole-file timeout and 500 segments; current job expiry of 120 seconds.
- Existing Vault public reads load whole files; range/chunk operations do not exist.
- Current Android 100 MiB retention, whole-source Transfer and full PCM/WAV buffers must change together.
- Verify source export/delete paths and meeting output transcript budgets before choosing final schema. Do not infer graph snippets are current: this index returned stale line-based source for RecordingImportService.process; bounded source reads verified actual behavior.
