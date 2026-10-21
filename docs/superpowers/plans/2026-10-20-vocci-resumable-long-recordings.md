# Vocci resumable long recordings implementation plan

Status: resumable version-3 server/Android transport, physical Vault allocation, 2 GiB local retention budgets and checkpointed transcription implemented. Installed native recovery passes with retained physical 226-second Meeting and correctly recognized hold samples, including visible Meeting analysis and Main replies. Final checks remain in progress. Ben accepted simulated two-hour validation on 2026-10-21 instead of a physical endurance recording. Implements section 3 of the approved [companion spec](../specs/2026-10-20-vocci-companion-meetings-chat.md). Tracking: task #3553, draft PR #3554. Generated upper-bound evidence remains distinct from real shorter hardware recordings.

## Boundaries

- Meetings owns immutable source reservation, binary chunks, completion validation and transcript-window checkpoints. Chat continues through its public admission boundary.
- Vault filesystem access remains inside VaultContext. Immutable byte publication, exact range reads capped at 1 MiB, and an available-space snapshot now exist there. The snapshot is not a reservation; upload admission uses bounded physical chunk allocation before acceptance. Never raw filesystem in Meetings.
- Android retrieval writes temporary files, restarts BLE reads from zero, then streams MediaCodec output into canonical 16 kHz mono WAV. HTTP resumes independently.
- A two-hour recording may have 32 MiB packets, 256 KiB sidecar and 256 MiB WAV; chunks <= 1 MiB. Validate exact hashes, packet continuity, sidecar completion and WAV geometry before transcription. Supplied WAV is evidence, not hardware attestation.

## Implemented server approach

1. Reserve immutable manifest and source identity under the same owner/source advisory lock as existing imports. Keep version 1 behavior immutable. Durable reservation precedes any vault writes. New transport is explicit; reject conflicting destinations/bytes.
2. Keep fixed indexed immutable binary chunk files; do not assemble/base64 the entire source. Persist received positions and SHA256 checks in owner-scoped upload records. Publish bytes before acknowledging database progress; exact replay repairs a lost acknowledgement, changed bytes return 409. Bounds cap metadata size.
3. Reserve disk space before acceptance, including active reservations; statfs alone does not reserve capacity and can overbook concurrent owners. Implemented bounded physical chunk allocation, exact replay recovery and 24-hour cleanup.
4. Finalize after complete coverage and incremental whole-file hashes. Validate packets across chunk edges using <= 257 byte carry; validate canonical 44 byte WAV header and aligned duration; sidecar bound 256 KiB and duration field must accept seven digits for 7,200,000 ms.
5. Transcribe one bounded non-overlapping PCM window per job. Offset segment times, use stable window/segment IDs, and atomically commit transcript and next-window checkpoint. Reset attempts per window. Job expiry of 120 seconds means one whole two-hour provider call is invalid. Schedule the next job transactionally and summarize only after the last window.
6. Maintain import/meeting row lock order during dispatch, deletion and commits. Define user transcript editing during in-progress import; never overwrite external revisions silently. Protect retained-window hashes on reads.
7. Add scoped grants/RLS, module deletion/export declarations and fixtures, expired-partial cleanup, API delegated-access guards and truthful app-map entries. Verify guards with actual negative controls.

## Android approach

1. Implemented prerequisite: RingProtocol.Transfer writes to a caller-owned stream, and production retrieval publishes through an atomic file only after exact sizes/end frames. PacketReader shares framing between files and host fixtures. BLE resume remains unverified and reads restart at zero.
2. Implemented prerequisite: file-backed MediaCodec decode feeds a bounded PCM writer, carries 48-to-16 kHz sample groups across buffers and finalizes the WAV header before atomic publication. Meetings now allow two hours; explicit voice remains capped at 120 seconds. Host checks generate a two-hour PCM file with a 32 MiB heap; installed MediaCodec and file/journal checks pass. Fresh short normal and hold recordings were retrieved, decoded and accepted by the server through the installed proof companion on October 21; the native processing wait expired before completion. This does not verify long ring retrieval. Frozen short JSON bundles still allocate/base64 their bounded files.
3. Reserve enough local storage for sources and derived audio plus free reserve. Implemented 2 GiB bounded queue with per-recording retrieval/decode credits and 150 MiB free reserve; failed/queued recordings remain preserved.
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

## Transport and window verification (October 21 continuation)

- Version 3 shares the existing immutable owner/source identity with versions 1/2. Physical bounded zero writes allocate chunk blocks before reservation success; publication writes into the allocated inode. Durable 24-hour cleanup precedes file I/O. Expiry removes files/progress and preserves the identity tombstone.
- Whole-source validation runs before ready; every window rechecks manifest/chunk hashes. Each job handles 30 seconds, stable segment IDs, and one atomic checkpoint/next-job commit. Existing transcript sources and owner corrections survive appends. Final analysis runs only after the last window.
- Internal final-output selection expands to 20,000 segments/1,200,000 characters only for v3 imports. Default public/legacy transcript limits remain 500/100,000. Account exports hash-check each <=1 MiB source chunk; the existing enclosing JSON archive still accumulates in memory.
- Isolated upload suite passed 12 tests, including generated two-hour HTTP upload, 240 windows, 720 segments with zero omitted from final output, and one final summary trigger. Generated PCM and stub ASR do not establish real hardware/ASR duration support.
- Owner-policy removal and delegated-route-guard removal each made the intended isolation test fail in throwaway databases. Removing Vault reservation containment made the named symlink test fail; original code was restored byte-for-byte. Final green regressions are recorded separately.
- Installed Android instrumentation passes lost reserve/chunk response recovery, missing-chunk restart, expiry, immutable identity/destination and legacy frozen bundle preservation. Platform codec checks include generated 130-second silence and preserved short voice limits. No long ring capture is claimed.
- Installed native recovery gate `100515` passed (exit 0, base `e648bba22`, dirty-input fingerprint `0bc52c0d3b60`). Actual native Start, platform decode and v3 upload delivered privately retained real ring packet/sidecar bytes through real GPU Whisper to visible Meeting transcript/summary and the original 10-second bookmark. Historical opted-in hold input required explicit Send to ordinary Main; the persisted text reply was visible through Open reply. Native restart retained one import/request/user-assistant pair and one summary. The developer fixture restored completed-retrieval files and historical enrollment in an isolated account; the ring inventory was empty. This establishes the recovery path, not fresh BLE retrieval or long hardware capture. The hold transcript still did not match the requested phrase.
- Android styling follows Moss’s Park Press guide: centralized native semantic roles, bundled licensed Archivo, system light/dark mode, scalable text, safe insets and 48 dp controls. Installed UI checks pass in light/dark at normal font scale and dark at 1.5 scale: all controls reachable without truncated labels, view identity/focus/scroll stable across polling, and scroll restored after Activity recreation. The recreation check first failed at scroll 0 instead of 1559; restoring only after the populated snapshot layout fixes it. System font/night settings were restored afterward. The private probe scrolls controls into the viewport; it does not invoke destructive cleanup.

- Native recovery testing exposed Android’s implicit form content type on empty POSTs: chunk upload succeeded but finalize returned HTTP 415. The client now sends explicit JSON `null`. The installed socket-contract check failed before the fix and passed after it; the real receiver also accepts JSON-null finalization replay. Final installed instrumentation passes with `httpContract=json_null_post`, platform Opus, journal recovery and resumable-upload checks.
- Foundation validation identified six route/table/migration catalog expectations requiring updates. Those expectations are corrected; a full final-input foundation result is still required.

- Saved real hold audio passed the ordinary Main flow after refreshing a revoked isolated proof-runner token: explicit Send, persisted user/assistant pair, visible Open reply and no second turn on replay. This is developer HTTP replay evidence, not a fresh ring gesture. A punctuation-sensitive proof assertion was corrected; product response text was unchanged.

### Real long-capture timestamp regression

A fresh physical normal recording reached Moss through installed native BLE retrieval,
platform decode and v3 upload: 226,020 ms with a 35-second bookmark. Live gate
`103839` then failed transcription. Replaying actual inference on its first
30-second window reproduced adjacent segments ending at 29.98 seconds and starting
at 29.96 seconds; the strict provider parser rejected that 20 ms overlap.

The adapter now trims the preceding segment's end for adjacent overlaps of at most
20 ms, preserving every text string and the short final segment's duration. Larger
overlaps, negative timestamps and normalization that would erase a segment remain
invalid. The regression was observed failing before the correction; 66 focused
tests in three files and the retained actual provider response pass afterward.
This is a timestamp compatibility fix, not a transcription accuracy claim or a
successful final long live-proof receipt. The original ring files were preserved
for native recovery without requesting a new recording. A subsequent retrieval
attempt did not rediscover that capture and was cancelled; recovery explicitly
restores the original packet/sidecar bytes at the completed-retrieval checkpoint.

### Final physical-source recovery and duration acceptance

At clean product head `743f25fc1`, long recovery gate `113145` passed: the original
226,020 ms source completed installed native decoding/upload, real transcription
windows and real model analysis, with transcript, summary and the 35-second bookmark
visible in Meetings. Hold recovery gate `113449` also passed: actual recognition of
the fresh post-enrollment source, explicit Send, one persisted user/assistant pair
and a visible Main reply. Both runs restore retained physical files at the completed
retrieval checkpoint; they do not claim another BLE capture.

The hold proof exposed a separate display defect: standalone numeric replies became
empty Markdown lists. Six shell/shared-renderer regressions failed before the narrow
escaping correction; fifteen focused tests and full type/lint checks pass afterward.

Ben revised acceptance to simulated two-hour upper-bound validation, because such
long recordings are a rare need. The real shorter captures remain hardware evidence.
The generated two-hour binary transport/checkpoint test and bounded-memory PCM writer
cover the limit separately from real speech recognition. Physical two-hour endurance
and supported consumer onboarding remain outside this slice's completion claim.
An additional installed-codec proof decoded 360,000 generated 20 ms Opus frames into
an exact 7,200,000 ms canonical WAV (230,400,044 bytes) in 93.6 seconds. The private
instrumentation used unchanged repository decoder bytes; generated files were
removed afterward. This does not claim real two-hour speech-recognition accuracy.
