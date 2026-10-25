# Vocci chat-turn latency

Part of #3584. Authority: the turn-latency handoff and approved automatic-delivery
spec. Work stays in `~/Jarv1s`'s turn-latency worktree. No phone or production access.

## Proven seams and first slice

- `packages/chat/src/live/chat-session-manager.ts:221`: the drawer guard serializes
  live turns. Busy voice admission checks that same guard synchronously at line 247.
- `packages/chat/src/voice-request-service.ts:109`: the durable receipt is claimed
  before any effects. Deferred work retains its 15-second scheduled recovery.
- `packages/chat/src/voice-request-jobs.ts:30`: immediate jobs commit with a queue
  wakeup; delayed jobs keep polling. Extra jobs do not replace the receipt claim.
- `packages/chat/src/voice-request-runtime.ts:69`: the public Chat service wires
  admission to the ordinary manager, with the owner's configured provider/model.

On busy admission, remember one metadata-only requeue hint per reserved turn.
After either typed or voice turn releases the guard, drain hints in arrival order.
Hints schedule ordinary immediate jobs, without waiting for them on the completed
turn's response. The original delayed job stays as recovery. Each hint rereads the
receipt under its owner context; stale/completed receipts do nothing. Admission,
privacy, replay and interruption retain their existing checks.

Public seams under test: manager typed/voice submission and service admission,
processing/status, plus the real API-owned worker. Confirmed by the handoff's
requirement to retain canonical admission and receipts. Tests cover release,
replacement of duplicate hints, failure/stall isolation, stale hints, re-deferral,
concurrent processing and delayed replay. Red manager tests observed both wakeup
assertions fail before implementation; the previous 15 tests passed.

Kill gate: if real deferred admission still waits for the delayed job after the
blocking turn ends, the builder fixes or drops this slice before merge.

## Model-turn investigation

Measure only on the isolated proof instance, with generated TTS and the selected
ASR/chat bindings unchanged. Temporary local numeric timing splits pre-model work,
session preparation, engine launch, tool readiness, context assembly, submission,
and first returned records. Record model latency separately from queue admission;
engine records do not by themselves prove provider-internal first-token timing.

Baseline local timing: cold engine launch 6891 ms (19 ms launch preparation),
pre-model work 10 ms, context assembly 24 ms. Warm turns reached session readiness
in 8/6 ms and first returned engine record in 2005/1324 ms. These records are not
provider-internal first-token measurements. The baseline speech endpoint was
unconfigured for transcription; proof provisions local CPU ASR and restores its
previous disabled configuration after each run. Chat selection is unchanged.

Ranked decisions from those observations:

1. Reuse/warm the existing session: already implemented by stream prestart and
   manager reuse. Build the missing readiness wakeup: a voice arrival during an
   existing warm launch must requeue as soon as that launch succeeds. Failed
   launches keep delayed recovery. Test-first red observed the new wake assertion
   fail while the existing 18 tests passed. This removes a readiness deferral;
   it does not claim to shorten the engine's own startup.
2. Cache tool discovery: keep the full authorized tool set, permission freshness
   and per-turn attach proof. Cache only if discovery itself dominates; caching
   across changed authorization would change behavior. Keep existing discovery:
   no measured resolver bottleneck justifies a new invalidation policy.
3. Reduce repeated prompt work: preserve tool contracts, persona and all admitted
   context. Preparation/context took tens of milliseconds, so retain it; no
   seconds-scale saving was established.
4. Different model or a new voice setting: Ben's decision; document, do not build.

The first three preserve the configured provider/model. Fast model selection has
potentially larger savings, but silently routing voice elsewhere violates the
hard invariant. No speculative model-path change earns a merge from queue savings.

Determinism boundary: queue state, progress, receipt and destination are stored
records. The model's two jobs remain interpreting the request and choosing/calling
tools to answer it. No new model-authored contract, prompt or UI is introduced.

## Verification and acceptance

Commands are unpiped, expected exit 0:

- `pnpm exec vitest run tests/unit/chat-main-voice-turn.test.ts`
- `scripts/run-gate.sh start --gate test:voice-requests`, followed by its terminal receipt.
- `pnpm verify:static`
- Full foundation through `scripts/run-gate.sh start`, followed by terminal receipt.

Live proof uses fresh Firefox and real Settings/Chat, generated audio through the
voice API, real ASR and configured model/tool calls, with replay identity and
before/after numeric timings. No screenshots, intercepted responses or private
content in committed evidence. Fresh Sonnet review, resolve findings and re-review;
then CI, Changed release note and authorized squash auto-merge. Ben times real
presses after `updateMoss`; model-choice decisions go to AWAITING-BEN and needs-ben.

## Review rulings

Initial independent Sonnet review: no blockers. Added stale-hint scheduling and
re-deferral/failure tests, distinct duplicate callbacks, and a stalled-hint test.
Wakeups no longer delay the completed turn's response. Failures remain recovery
hints: delayed jobs are authoritative; no new logging of owner content is added.

Final independent Sonnet review of the busy and warm-launch source diff: no
blockers; 20 unit tests passed. Pending thread/privacy selection deferrals retain
delayed-only recovery by design. Live run 11 passed real Settings/Chat, TTS import,
tools, reply and replay assertions: cancellation-to-admission fell from 14703 ms
to 158 ms. Stage tables and limits are in the committed turn-latency evidence.
