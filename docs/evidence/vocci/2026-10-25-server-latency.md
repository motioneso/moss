# Vocci server pickup latency

Part of #3584; PR #3707. Baseline `cdf39095b`; live candidate
`13fc36f49c0f607a3fc729a31ff52d2976eb7e5d`.

## Setup and executable assertions

Fresh headless Firefox exercised the isolated proof copy: authenticated owner →
Settings → Admin / Setup → AI providers → Voice; Personal → Modules; Chat drawer.
Generated TTS audio went through the product voice-enablement and voice-recording
APIs, the real local CPU ASR endpoint selected in Settings, and the unchanged
configured chat model. Real Tasks tools ran. No Moss response was intercepted,
rewritten or replayed. Synthetic packet framing does not establish ring behavior.

The same generated PCM source was used before and after (SHA-256
`566f0d178e7eef85da1c1c600b48d0cb4df5860a7316bdb5084704b45ad9ae06`).
Padding kept ASR segment boundaries inside the 4.3-second clip. This is an isolated
server comparison, not physical release-to-action timing.

Successful baseline run 6 and candidate runs 7 and 9 exited 0. Assertions proved:

- Voice Settings showed the real configured ASR; Modules and ordinary Chat were reachable.
- Upload accepted; durable import/voice receipt reached `replied`.
- The transcript appeared in ordinary Chat.
- Replaying the upload returned the same import and receipt IDs.
- Run 9 additionally required a real tool event and nonempty reply event for each sample.
- Each run disabled its synthetic source enablement and closed Firefox on exit.

A supplemental observer attempt (run 8) failed before upload because Firefox CSP
blocked the polling helper. Run 9 replaced that helper with direct evaluation.
Run 7's additional stream observer captured only its first sample; stored queue and
receipt timestamps cover all three. Run 9 reopened the observer per sample and
captured all events. These are observation changes, not response interception.

## Before and after

Milliseconds, samples in execution order. Queue wait means pg-boss `started_on`
minus `created_on`. ASR stage ends at receipt creation; chat admission ends at
receipt `dispatched_at`. The API upload return is the origin for tool/reply/finish
rows. First reply is the first observed reply record, not provider-internal first-token
telemetry. Baseline sample 1 also discovered tools; its requested Tasks result was
9394 ms (the earlier result belonged to discovery).

| Stage                             | Baseline 1 / 2 / 3  | Candidate run 7: 1 / 2 / 3      |
| --------------------------------- | ------------------- | ------------------------------- |
| Transcription queue               | 251 / 287 / 314     | 27 / 15 / 21                    |
| Pickup → transcript/receipt       | 1392 / 1406 / 1249  | 1960 / 1442 / 1471              |
| Chat queue                        | 380 / 125 / 267     | 15 / 10 / 10                    |
| Receipt → chat admission          | 392 / 138 / 277     | 34 / 25 / 24                    |
| Both immediate queue waits        | 631 / 412 / 581     | 42 / 25 / 31                    |
| Upload return → first tool        | 7610 / 5261 / 5501  | 10105 / unobserved / unobserved |
| Upload return → requested result  | 9394 / 5462 / 5700  | 10305 / unobserved / unobserved |
| Upload return → first reply       | 10398 / 6468 / 6901 | 11315 / unobserved / unobserved |
| Upload return → receipt completed | 10634 / 6697 / 6930 | 11553 / 7314 / 6473             |

The paired immediate queue totals fell by 589/387/550 ms. This supports retaining
the wakeup slice; it does not establish halving total latency. End-to-end samples
include model/session variance, and local ASR CPU runtime also varied.

The complete-observer repeat retained an admission outlier:

| Stage                             | Candidate run 9: 1 / 2 / 3 |
| --------------------------------- | -------------------------- |
| Transcription queue               | 18 / 19 / 12               |
| Pickup → transcript/receipt       | 1878 / 1925 / 2037         |
| First chat job queue              | 12 / 15 / 13               |
| Receipt → chat admission          | 15532 / 29 / 27            |
| Upload return → first tool        | 23028 / 5706 / 3419        |
| Upload return → requested result  | 23228 / 5907 / 5844        |
| Upload return → first reply       | 24238 / 6712 / 6835        |
| Upload return → receipt completed | 24484 / 6944 / 7065        |

Run 9 sample 1 had two chat jobs: the immediate job was picked up in 12 ms; a
subsequent job waited 15490 ms. The unchanged service schedules deferred admission
15 seconds later (`packages/chat/src/voice-request-service.ts:121`); delayed jobs
intentionally keep polling. This sample demonstrates that faster queue pickup does
not remove existing admission deferrals. The exact cause of this deferral was not
instrumented, so this evidence does not assign it to model startup.

## Implementation and validation

Commit-delivered queue-name hints wake the existing pg-boss fetch loop. Existing
claims, retries, receipts and destination rules remain in place, with 0.5-second
polling as fallback. Two owned LISTEN connections are the runtime cost; there is no
schema migration or new required setting.

Test-first red: both real-database immediate-work cases timed out with 30-second
polling when scheduler notifications were removed. Green: four isolated queue
integration tests; 13 scoped lifecycle/runtime unit tests after review additions;
238 existing voice regression tests across ten suites. Explicit `pnpm verify:static`
exited 0. Database tests used the repository's throwaway-container gate runner.

Fresh independent Sonnet review of the implementation found no blockers. Follow-ups
restore plain app-map/source-format copy, cover pending-connect shutdown and failed
reconnect, and retain the bounded Jobs listener policy (see the plan's review rulings).
Final exact-head re-review, full foundation outcome and CI receipts belong on the PR;
earlier commit receipts are not reused as final-head evidence.

After deployment Ben must time five real short holds from release to Moss acting.
That remaining physical acceptance step is in the Vocci AWAITING-BEN entry. No phone,
ring, ADB or production database was accessed for this slice.
