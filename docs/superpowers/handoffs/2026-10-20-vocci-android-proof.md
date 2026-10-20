# Vocci Android installed-path proof — 2026-10-20

Task #3550, following merged receiver #3548. Implementation is the developer
Android slice in `apps/vocci-delivery`; consumer setup and production deployment
remain outside this change. Review and CI remain separate requirements.

## Observed path

The final revised runtime `d8ea8e6463a9379dad101a178503008ce85bd404` passed
an isolated `test:recording-live` gate with exit 0:
`vocci_auto_delivery-20261020-073730.log`. The gate captured a clean tree and input
fingerprint `e88db78391cd`. Its private browser receipt is
`~/.local/state/moss/vocci-delivery/auto-browser/final_runs/run_9/result.json`.
Two final actual Opus rereviews report no blockers/medium defects; dispositions
and remaining low observations are in the adjacent Opus review ledger.

The original runtime passed `vocci_auto_delivery-20261020-052822.log` (run_5).
A later empty-inventory run and interrupted gate 072950 are not passing evidence.
Final-runtime run 073419 retrieved/imported/replayed the fresh captures, but failed
an immediate verifier reconnect after Stop (rc1). A subsequent standalone verifier
passed all four hashes. The private driver now allows 10 seconds for disconnect
before independent verification. During run_9 initial ring_connect failures required
one manual Bluetooth off/on recovery while the service remained running; retrieval
then resumed. This is an explicit environment intervention, not evidence of
unaided reconnect reliability or ring reboot recovery. No runtime change was made.

Executable assertions exercised owner signup, Voice Settings and Meetings
settings through real Firefox UI, then the installed Android foreground client:

- Fresh authenticated ring inventory and actual completed-file retrieval while
  the phone screen was off; no substituted uploads or intercepted responses.
- Final fresh physical recordings: normal 27,360 ms with source bookmarks at
  12,000, 19,000 and 26,000 ms; hold classified as `voice-request`. Both completed.
  Original run_5 used normal 32,100 ms/bookmark 16,000 ms and hold 5,580 ms.
- Android Opus decoding, authenticated acceptance, configured local Whisper
  transcription, and both nonempty transcripts opened from Meetings history.
- All four original packet/sidecar hashes matched independent fresh authenticated
  re-downloads through the installed client.
- Exact replay preserved import/meeting IDs. Process restart preserved source
  UUID and exact frozen bundle bytes. A separate executable interruption receipt
  stopped both accepted pending imports and verified their IDs/bytes before
  resuming the service screen off. The final run also exercised actual Stop,
  asserted the stored stopped outcome and absence of the service, and verified no
  false configuration failure.
- Unauthenticated import returned 401. The driver stopped delivery, restored the
  original official-app connect/scan permissions and Bluetooth state, and removed
  only its own ADB reverse.

The first new-capture proof failed because its private speech-endpoint setting
included a duplicated API suffix. Correcting the configured origin fixed dispatch.
Word alignment in the real local Whisper service provides clip-bounded timestamps;
no Moss response data was rewritten. The service runs actual inference on the
retrieved audio. Private drivers, credentials, source files and transcript text
remain outside git. No screenshots were captured.

## Other checks

Host tests cover HMAC vectors/wrong-key rejection, expected identity, split and
coalesced/corrupt frames, inventory byte order/terminator, strict transfer bounds,
interrupted reads, packet sequence gaps and finite retries. Installed device checks
cover Keystore retention/tamper rejection, platform decoding, completed-sidecar
admission, frozen recovery, interrupted-attempt accounting, stable UUID, exhaustion
and owner-switch rejection. Final device checks also cover discovered-state
restart, invalid-file isolation, oversized completed duration, interrupted-read
backoff/recovery, blocked/stopped status, identity/mode conflicts and retained HTTP
status. Removing ring proof verification, owner binding, server identity checks or
encrypted storage caused their corresponding assertions to fail; protections were
restored and checks passed. Final static/receiver/CI outcomes belong on the PR.

## Limits

Developer provisioning uses a normal general Moss cookie and an existing owner
binding. The APK is debuggable; it is not consumer onboarding or production
credential distribution. Only Android API 33+ is supported. No ring mutation,
deletion, ownership change, destructive acknowledgement or request execution.

Receiver limits remain 120 seconds, 1 MiB packets, 64 KiB sidecar and 8 MiB request.
Ring reboot, long-term background reliability, OS reclamation and interrupted BLE
transfer recovery on physical hardware remain unverified beyond the listed proof;
host assertions cover incomplete-file rejection/restart. Retention management and
consumer permission handoff/key recovery need separate work. Repeated early
framing faults can delay later sources until eight attempts exhaust; ended
sidecars without positive duration remain pending and retained discoveries consume
the 100-entry limit. Moss outages pause retrieval pending live owner verification.
No production deploy.
