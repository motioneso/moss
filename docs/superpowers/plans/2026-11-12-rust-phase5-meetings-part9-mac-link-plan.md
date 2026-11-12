# Meetings part 9 (Mac link): build plan

Branch `task/258-rust-port-phase-5-meetings-part-9-mac-li`. Part of #4027. Parts 1-8 are merged. Device pairing (part 7) is parked, so the paired-device check is a narrow port with a fake.

## Legacy sources (packages/meetings/src)

| File                                         | Part 9 uses                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| capture-connection-service.ts                | register, devices, start, commands, claim                                                                            |
| capture-connection-repository.ts             | locks, connection rows, retire, occupied, cancel, byRequest, create                                                  |
| capture-repository.ts                        | view/revision hash, lockMeeting, grants, renewClaim, activate, save, revokeExpired, receipt, reserve, transcriptHead |
| capture-start-limiter.ts                     | 10/min and 60/hour rolling budget, DB clock, advisory lock                                                           |
| capture-maintenance.ts                       | queue `meetings.capture-maintenance`, 5 s successor, deterministic job id                                            |
| capture-domain.ts                            | state shape, validateCaptureSelection, applyCaptureControl "record", expireCaptureLease                              |
| capture-authorization.ts, capture-binding.ts | auth error mapping, revocation reasons                                                                               |
| capture-service.ts                           | browser origin rules, cancelStart (693-740), native bearer `mm1_`                                                    |
| capture-routes.ts                            | route table, body schemas, no-store, 131072 body limit                                                               |
| apps/api companion-recording-routes.ts       | the two 410 routes (`attempt`, `decide`)                                                                             |

Out of scope (later parts): audio, source change, gaps, pause/stop/status control.

## Design

1. Route requests carry no headers, so credential checks sit behind a host trait `CaptureAuthority` (browser session, native credential, device binding, recording permission). The default refuses with 401. Tests use a fake. Listed as not proven.
2. A kv resource `meetings.capture` offers `lock` (meeting FOR UPDATE with 404, device lock, request-key lock), `identity`, `binding`, `device`.
3. Guest modules, each under 1000 lines: `capture_errors`, `capture_state`, `capture_start_limit`, `capture_connection`, `capture_start`, `capture_cancel`, `capture_maintenance`, `capture_gone` (410 routes).
4. Typed queries on the capture tables. JSON state is filtered in the guest, rows bounded by 1000.
5. New queue `meetings.capture-maintenance` in the manifest jobs block, capabilities, `QUEUES` and `PARAMETER_KEYS`. Payload is the grant id and a sequence only. Host retry default is 3 (max 10), so the 5 s successor is enqueued with `enqueue-after-commit` and `availableAt`.
6. App map: routes, features and settings in `modules/meetings/moss.module.json`.

## Proof list

- Ported tests: link and grant lifecycle, receipts, start and cancel-start, revocation, 410 routes, start limits, mutation controls (the six scripts under `scripts/`).
- Second-person row-level-security test, seen failing with protection removed.
- Planted-marker test: meeting text absent from logs, job payloads and activity rows.
- Native and WebAssembly builds with tests in both.
- Live run on the real Rust server, plus a check from another address.
- Error-code table in the part 9 report section, with a test that fails if the Rust enum differs.

## Not proven (expected)

- Real paired-device credential check (part 7 parked).
- Lease and fence acquisition on the auth side.
- A real Mac app talking to the server.
