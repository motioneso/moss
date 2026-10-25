# Vocci hold-to-talk latency plan

Part of #3584. Handoff: `docs/superpowers/handoffs/2026-10-25-vocci-hold-latency.md`.
Spec: `docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md`.

## Goal

Cut the time from releasing the ring button to Moss acting on a short spoken command.
Target: under 15 seconds for a 5-second command. Today it is estimated at 40 to 90 seconds.

## Status of the timeline

Stage lengths below come from reading the code. None are measured on a device yet. The device
is held by the `vocci-phone-range` session, so the measured run is a later step (Phase 0).

| #   | Stage                                 | Where      | Estimated wait                      | Source                                                           |
| --- | ------------------------------------- | ---------- | ----------------------------------- | ---------------------------------------------------------------- |
| 1   | Ring closes the file                  | ring       | unknown, likely 1-2 s               | needs device                                                     |
| 2   | Wait for the next check               | phone loop | 0-30 s, mean 15 s                   | `RetryPolicy.connectionDelayMs(0)` = 30 s, `DeliveryService.run` |
| 3   | Connect to the ring                   | phone      | unknown, likely 3-8 s               | `RingConnection` constructor, 6 sequential GATT steps            |
| 4   | First sighting, file skipped          | phone      | one more full cycle: 30 s + stage 3 | `retrieve()` needs the same sizes in two inventories             |
| 5   | Copy sidecar and audio over Bluetooth | phone      | about 4 s                           | range-check evidence                                             |
| 6   | Upload to Moss                        | phone      | under 2 s on Wi-Fi                  | `deliver()` runs right after `retrieve()`                        |
| 7   | Server queue hop to transcription     | API        | 0-2 s                               | `pollingIntervalSeconds: 2` in `recording-import-jobs.ts`        |
| 8   | Transcription                         | API        | model-dependent, unmeasured         | `RecordingImportService.process`                                 |
| 9   | Queue hop to chat turn                | API        | 0-2 s                               | `pollingIntervalSeconds: 2` in `voice-request-jobs.ts`           |
| 10  | Model reply and tool call             | API        | model-dependent, unmeasured         | existing chat path                                               |

The phone's follow-up polling for receipts (`pollVoice`, `chat`) runs in the next cycle. It is
not on the path to Moss acting, so it is out of scope.

Stages 2 and 4 are the bulk: roughly 30 to 60 s of dead waiting. Stage 3 happens twice.

## Options, ranked by seconds saved

| Rank | Option                                                                                                                                                   | Saves   | Battery                      | Ring wear                | Safety                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Fetch the sidecar on first sighting. If it carries the `end` record, trust it and fetch audio now. Skip the second sighting.                             | 30-40 s | none                         | none                     | Needs proof the ring writes `end` only after the audio file is final. If unproven, keep the size check as a second guard (re-list once, 2 s later). |
| 2    | Fast checks while hold-to-talk is on: check every 3-5 s for a short window after the phone sees recording state `hold` or a recent file, else keep 30 s. | 10-25 s | small, bounded by the window | one connection per check | Never changes what is fetched.                                                                                                                      |
| 3    | Keep one ring connection open while hold-to-talk is on, react to notifications.                                                                          | 15-30 s | highest, unmeasured          | continuous link          | Conflicts with official app handoff. Only if the ring pushes a hold-end event, which is unproven.                                                   |
| 4    | Server polling at 0.5 s for the two voice queues.                                                                                                        | 1-3 s   | none                         | none                     | Slightly more database polling.                                                                                                                     |
| 5    | Skip the second queue hop by admitting the chat turn inside transcription finish.                                                                        | 0-2 s   | none                         | none                     | Touches module boundaries. Defer unless Phase 0 shows it matters.                                                                                   |

Recommended first build: Option 1 plus Option 4, then Option 2 if Phase 0 shows connection time
dominates. Option 3 stays a research item.

## Seams to prove (open questions)

| Question                                                               | Owner                            | How                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------- |
| Is the sidecar `end` record written after the audio file is closed?    | device run, `vocci-hold-latency` | Poll inventory during a real press, log sizes and sidecar text at 1 s steps, no transcripts. |
| Does the ring send any event at hold start or end on the UART channel? | device run                       | Log opcodes seen while connected through a press.                                            |
| How long does connection setup take?                                   | device run                       | Timestamp each stage in `RingConnection`, local only.                                        |
| How long do transcription and the chat turn take?                      | dev instance                     | Receipt and message store times through the product API.                                     |

## Phases

0. **Measure.** Device free. Time five long presses end to end. Record per-stage numbers in
   `docs/evidence/vocci/`. No transcripts, addresses or device ids.
1. **Option 1**, test first: pure-function tests for the "complete on first sighting" decision in
   `ProtocolTest`/`CompletedSidecar` tests, including a still-growing file and a missing `end`
   record. Then wire into `retrieve()`.
2. **Option 4**, with an integration test that a voice upload reaches the chat turn without a
   2 s wait.
3. **Option 2** only if Phase 0 and Phase 1 leave more than 15 s.

Kill gate after Phase 1: if live time does not drop by at least 20 s, stop and re-plan.

## Must not change

Delivery enabled flag, hold-to-talk opt-in, cleanup choices, the official app permission
handoff, phone timeout, receipts, durable destinations, exactly-once delivery. A faster path
never fetches a partial recording and never delivers twice. Existing duplicate and partial
tests must still pass unchanged.

## Verification

`pnpm verify:static` unpiped. `verify-gate` for database tests. `apps/vocci-delivery/test.sh`
for Android code. Fresh Opus review. Live proof on the phone with before and after numbers
on the PR. Release note: Category Fixed.
