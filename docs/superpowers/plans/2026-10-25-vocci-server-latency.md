# Vocci server latency: measured queue wakeups

Part of #3584. Authority and scope: the server-latency handoff and the existing
automatic-delivery spec. Work stays in `~/Jarv1s`'s server-latency worktree.

## Baseline, measured before changes

Three generated short commands went through the isolated instance's real Voice
Settings, recording API, configured local ASR, ordinary Chat and real tool execution.
No response interception. Synthetic packet framing does not prove ring behavior.
Stored pg-boss/receipt timestamps and observed chat events give these milliseconds:

| Stage                                   | First session | Warm 1 | Warm 2 |
| --------------------------------------- | ------------: | -----: | -----: |
| Transcription job created → picked up   |           251 |    287 |    314 |
| Picked up → transcript/receipt ready    |          1392 |   1406 |   1249 |
| Receipt ready → chat claimed            |           392 |    138 |    277 |
| Claimed → user event                    |            52 |     19 |     17 |
| Upload returned → first tool event      |          7610 |   5261 |   5501 |
| Upload returned → requested tool result |          9394 |   5462 |   5700 |
| Upload returned → first reply event     |         10398 |   6468 |   6901 |

The first session also discovered tools. First reply events are the first observed
reply records, not a claim to provider-internal token timing. Audio used actual TTS
and actual ASR; padding kept ASR's segment boundaries inside the clip.

## Ranked options and decisions

1. **Model/tool routing:** largest remaining opportunity (several seconds), but the
   current provider is selected by the user and tool discovery is provider-owned.
   No measured alternative yet. Preserve the configured router; do not silently
   enable a classifier, replace a model, or remove tools to achieve a benchmark.
2. **Commit-triggered worker wakeups:** save the measured 0.43–0.64 seconds spent
   waiting across the two queues, without changing claims or delivery. Build this
   bounded slice. Keep 0.5-second polling for missed notifications and delayed jobs.
3. **Inline chat dispatch:** can remove only the second queue's 0.14–0.39 seconds.
   Its strongest case is less infrastructure. Reject because overlapping direct
   execution and queued recovery complicate the durable lifetime of dispatch.
4. **Faster configured transcription:** approximately 1.25–1.41 seconds available
   in this proof. Only one usable path was configured. No hardcoded model/provider.

This slice cannot halve total latency; report its measured effect honestly.

## Proven seams

- Recording work is transactionally enqueued at
  `packages/meetings/src/recording-import-jobs.ts:25`; its API-owned consumer is
  `packages/module-registry/src/recording-import-runtime.ts:65`.
- Chat receipt and work commit together in
  `packages/chat/src/voice-request-service.ts:55`; its separate consumer is
  `packages/module-registry/src/voice-request-worker-runtime.ts:9`.
- pg-boss already exposes `notifyWorker`; its worker aborts its sleep and fetches
  normally. Wakeups therefore leave claims/locking/retry ownership with pg-boss.
- PostgreSQL commit-delivered notifications already have a precedent in
  `packages/chat/src/reminders/live-arrival.ts:36`, and the owned client lifecycle
  is publicly exported from `@moss/db` (`owned-pg-client.ts:12`).
- AI routing stays at `packages/ai/src/configured-transcription.ts:107` and
  `packages/chat/src/live/chat-session-manager.ts:237`.

## Build and test-first verification

Public seams under test: transactionally scheduled queue work and the API-owned
worker runtimes. A real database test must show committed work wakes a worker with
a deliberately long polling interval, rollback never wakes it, delayed jobs retain
their delay, and the worker still processes without a notification. Unit tests cover
listener loss, reconnect, irrelevant messages and shutdown. Keep existing voice
replay, simultaneous claim, privacy, destination and interruption tests unchanged.

Add a small generic queue wakeup utility in `@moss/jobs`, using a fixed PostgreSQL
channel carrying only the queue name. The two schedulers notify in their existing
transaction for immediate work. Their runtimes own listeners, wake the registered
pg-boss workers, and stop listeners before draining workers. Polling remains the
fallback during connection failure. No schema migration or new required setting.

Determinism boundary: progress, receipt and destination remain stored records. The
model's two existing jobs are interpreting the command and choosing/executing tools
to answer it. No new prompt, model-authored data contract, or UI is introduced.
Update the recording feature declaration to describe prompt queued processing.

Commands, all unpiped, expected exit 0:

- `pnpm exec vitest run tests/unit/job-queue-wakeup.test.ts`
- `pnpm verify:static`
- `scripts/run-gate.sh start --gate test:voice-requests`, then its terminal receipt.
- Full foundation gate through `verify-gate` before merge.
- Repeat the same live UI script and generated inputs on the committed candidate;
  record stage timings, real tool result, normal chat visibility and replay IDs.

Fresh independent review on a different model, resolve findings and re-review;
then PR with Changed release note and authorized squash auto-merge.

Kill gate: if wakeups do not remove the queue waits, fix or drop this slice. After
this slice stop broadening routing changes: publish the measured remaining model
time and leave physical release-to-action timing in the Vocci AWAITING-BEN entry.
The implementing agent owns that decision; Ben owns post-deploy physical timing.
