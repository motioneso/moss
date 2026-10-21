# Vocci resumable long recordings implementation plan

Status: file-backed Android retrieval/decoding, bounded Vault I/O and incremental source-validation prerequisites implemented. Durable upload admission, resumable HTTP transport, expanded retention and windowed transcription are not implemented. Implements section 3 of the approved [companion spec](../specs/2026-10-20-vocci-companion-meetings-chat.md). Tracking: task #3553, draft PR #3554. Each step must be implemented and verified before claiming support for long recordings.

## Boundaries

- Meetings owns immutable source reservation, binary chunks, completion validation and transcript-window checkpoints. Chat continues through its public admission boundary.
- Vault filesystem access remains inside VaultContext. Immutable byte publication, exact range reads capped at 1 MiB, and an available-space snapshot now exist there. The snapshot is not a reservation; upload admission still needs concurrency-safe capacity accounting. Never raw filesystem in Meetings.
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

1. Implemented prerequisite: RingProtocol.Transfer writes to a caller-owned stream, and production retrieval publishes through an atomic file only after exact sizes/end frames. PacketReader shares framing between files and host fixtures. BLE resume remains unverified and reads restart at zero.
2. Implemented prerequisite: file-backed MediaCodec decode feeds a bounded PCM writer, carries 48-to-16 kHz sample groups across buffers and finalizes the WAV header before atomic publication. Production remains capped at 120 seconds. Host checks generate a two-hour PCM file with a 32 MiB heap; installed MediaCodec and file/journal checks pass. Fresh short normal and hold recordings were retrieved, decoded and accepted by the server through the installed proof companion on October 21; the native processing wait expired before completion. This does not verify long ring retrieval. Frozen short JSON bundles still allocate/base64 their bounded files.
3. Reserve enough local storage for sources and derived audio plus free reserve. Current 100 MiB queue capacity cannot hold a two-hour recording. Expand bounded retention deliberately; failed/queued recordings remain preserved.
4. Persist immutable manifest/source/destination before first HTTP reserve. Query server progress on restart and send missing chunks from files. Handle lost responses, owner/source mismatch, duplicate/conflicting chunks, expiry and processing status. Do not silently send existing evidence as a new voice command.

## Validation

- Packet/WAV/sidecar parser boundary tests: split headers and packets at every chunk boundary; malformed sequence, hashes, sizes, timestamps, and 2h + 1ms rejection.
- Actual scoped upload integration: new owner, restart/progress, concurrent identical reserve, duplicate/changing chunk, lost ack, incomplete finalize, finalization replay, owner isolation, expiry and deletion. Observe RLS/delegation negative controls.
- Window integration: crash before/after checkpoint, stale attempt, retry exhaustion per window, empty windows, clipped/out-of-bounds timestamps, stable segment IDs, one final summary. Check transcript read/output budgets accommodate 2h.
- Android host framing tests, APK build and installed MediaCodec/instrumentation. Device proof needs an attached authorized ring/phone.
- Live UI: real meeting longer than 2 minutes, then the 2h boundary; retain bookmarks, transcript and summary/action review. Separate generated stress fixtures from hardware claims.

### Storage/source prerequisite evidence (October 21)

- Focused unit suites: 81 tests in five files passed, including split WAV headers, UTF8 sidecars, packet sequence wrap and maximum-length payload splits, whole-file hash/size changes, incomplete metadata, two-hour generated source and two-hour-plus-1-ms refusal. Generated zero PCM is a parser fixture, not hardware or ASR proof.
- WAV tag regression: six named tests failed before replacing Node's high-bit-stripping ASCII tag decode with a literal byte-preserving comparison; all pass after correction. Both legacy bundles and the internal long-source validator now reject non-ASCII RIFF/format/data tags even when file hashes match. Valid version-1 evidence, limits and delivery intent are unchanged; this deliberately corrects acceptance of malformed WAV tags.
- Shared Vault binary publication covers concurrent creation, partial writes, file/directory sync failures and exact replay after a lost acknowledgement. Range reads include invalid bounds, early EOF and a sparse two-hour-sized file. Removing the symlink-containment guard made both named binary-read/publication assertions fail; restoring source returned both green.
- Isolated canonical `test:voice-requests` gate `083451`: exit 0, 230 tests in ten files, tested at `b8eba6ced` with dirty-input fingerprint `c2f36e8c9bdb`. Covers existing import/voice behavior, Chat admission, account export/deletion and schema regressions. Root TypeScript, scoped ESLint, Prettier and file-size checks also passed. This is scoped prerequisite evidence, not a full foundation or live long-upload verdict.

## Open implementation facts

- Current RecordingImportService has a 35 second whole-file timeout and 500 segments; current job expiry of 120 seconds.
- Vault now exposes `createVaultFileBytes`, `readVaultFileRange` and `getVaultAvailableBytes`. Immutable string and byte publication share temporary-file/link publication, file sync and directory ancestry sync. Lost directory-sync acknowledgement is replayable; callers still have to compare existing bytes and record durable progress before acknowledging a chunk. Temporary files left by a killed process still require the upload's directory-expiry cleanup.
- `validateRecordingSource` is an internal completion validator, with no upload route or worker connected yet. It checks exact sizes/SHA256 incrementally, packet sequence across arbitrary splits, canonical WAV geometry and complete sidecar metadata under the approved long-source limits. Only the sidecar (at most 256 KiB) and the 44-byte WAV header are buffered by the validator. The reader must provide chunks at most 1 MiB. Shared packet/WAV/sidecar helpers preserve version-1 limits, including six-digit sidecar duration; the future long transport permits seven digits.
- Generated two-hour zero-PCM and packet fixtures exercise source validation and bounded allocation only. They do not prove a two-hour ring capture, HTTP resume, native storage capacity or transcription.
- Current Android retention remains 100 MiB, with short whole-JSON/base64 uploads. Retrieval and codec conversion now use file sinks; long transport and deliberate capacity reservation must still replace the short bundle path.
- Verify source export/delete paths and meeting output transcript budgets before choosing final schema. Do not infer graph snippets are current: this index returned stale line-based source for RecordingImportService.process; bounded source reads verified actual behavior.
