# Meetings part 10 (Mac audio and control): build plan

Branch `task/259-rust-port-phase-5-meetings-part-10-mac-a`. Part of #4027. Parts 1-9 are merged. Device pairing (part 7) is parked, so the Mac's credential check is a narrow port with a fake.

## Already built (not rebuilt)

Link, grants, start, cancel-start, maintenance job, the two 410 routes, the recording-notice job, the state helpers (`retain_gap`, `expire_lease`, `view`, `stop`, `revoke`), and the start-time source selection.

## Legacy sources (packages/meetings/src)

| File                                              | Part 10 uses                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| capture-routes.ts                                 | audio, status, control, browser status and browser control routes, body schemas, 5.2 MB cap    |
| capture-service.ts                                | status, browserStatus, browserControl, nativeControl, control, stopTranscript, audio           |
| capture-domain.ts                                 | applyCaptureControl, applyCaptureSourceChange, decode and admit audio, WAV, gaps, lease expiry |
| capture-repository.ts                             | receipts, reserve, admitAudio, retry, finish, reconcileExpiredAudio, completeness              |
| capture-processing.ts, capture-silence.ts         | clip transcription window, silence check                                                       |
| capture-transcript-sources.ts, capture-waiters.ts | source records, long-poll                                                                      |
| recording-notice-jobs.ts                          | recording-notice job (built in part 9)                                                         |

## Design

1. The Mac's bearer credential reaches the module through a new `CaptureAuthority::grant_credential` host operation (route requests carry no headers). The default refuses. Tests use a fake. Listed as not proven.
2. Guest modules, each under 1000 lines: audio decoding and admission, receipts, status, control, browser status, routes.
3. Clip audio goes to the host transcribe port with the route digest from the processing authority. A changed route fails closed.
4. Receipts go through the typed query port. Transcript ingest reuses the existing batch encoder and store.
5. Limits: lease 30 s, finalization 60 s, clip 10 s, PCM 3,840,000 bytes, audio body 5,200,000 bytes, other bodies 131,072 bytes.

## Proof list

- Ported tests for every route and the error-code table, with a test that fails if the table and the enum differ.
- Second-person row-level-security test, seen failing with protection removed.
- Planted-marker test: meeting text absent from logs, job payloads and activity rows.
- Mutation controls for the new rules.
- Native and WebAssembly builds with tests in both.
- Live run against the installed package and a real database (done). It found that receipt reads of 4,000 rows fail on the host, which caps a page at 1,000. Reads are now paged.

## Not proven (expected)

- Real paired-device credential check (part 7 parked).
- A real model pass on real audio.
- A real Mac app talking to the server.
- Revoke on lost recording permission is rolled back by the host (a 401 undoes the call). See the report.
