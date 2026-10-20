# Vocci Android installed-path proof — 2026-10-20

Task #3550, following merged receiver #3548. Implementation is the developer
Android slice in `apps/vocci-delivery`; consumer setup and production deployment
remain outside this change. Review and CI remain separate requirements.

## Observed path

An isolated `test:recording-live` gate passed with exit 0:
`vocci_auto_delivery-20261020-052822.log`. Its private browser receipt is
`~/.local/state/moss/vocci-delivery/auto-browser/final_runs/run_5/result.json`.
The PR records exact test receipts and tested commits. A subsequent clean-commit
live rerun found an empty ring inventory after handback to the official app and
was stopped; it is not passing evidence. The successful run above remains the
physical proof. No later change alters Android runtime behavior.

Executable assertions exercised owner signup, Voice Settings and Meetings
settings through real Firefox UI, then the installed Android foreground client:

- Fresh authenticated ring inventory and actual completed-file retrieval while
  the phone screen was off; no substituted uploads or intercepted responses.
- Two new physical recordings: normal 32,100 ms with a 16,000 ms bookmark, and
  hold 5,580 ms classified as `voice-request`.
- Android Opus decoding, authenticated acceptance, configured local Whisper
  transcription, and both nonempty transcripts opened from Meetings history.
- All four original packet/sidecar hashes matched independent fresh authenticated
  re-downloads through the installed client.
- Exact replay preserved import/meeting IDs. Process restart preserved source
  UUID and exact frozen bundle bytes. A separate executable interruption receipt
  stopped both accepted pending imports and verified their IDs/bytes before
  resuming the service screen off.
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
and owner-switch rejection. Removing ring proof verification, owner binding or
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
consumer permission handoff/key recovery need separate work. No production deploy.
