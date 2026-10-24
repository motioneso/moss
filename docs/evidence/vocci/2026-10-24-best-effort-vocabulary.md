# Best-effort Meeting vocabulary: implementation and live proof

Part of #3584; #3565 and #3584 remain open. The controlling
[decision](../../superpowers/specs/2026-10-24-meeting-vocabulary-decision.md)
is Ben's “Approve and best effort”. The
[committed plan](../../superpowers/plans/2026-10-24-meeting-best-effort-vocabulary.md)
was independently reviewed before implementation.

## Implemented boundary

Product head: `b8593a87ad91e3ba62d89877e35dc9de581562a3`.
Base: `1a79c74b4cf4800740340617c67496f70fa762e1`.
Settings → Modules → Meetings saves/clears owner vocabulary. The complete
normalized list is limited to 20 terms and its comma-separated prompt to 200
UTF-8 bytes, with no truncation. Nonempty lists require an explicit language.
Canonical preference locking serializes updates; one snapshot reads language/list.
Live speech, normal short imports and every normal long window forward the hint
through the selected configured ASR route. Empty lists omit prompt. Unknown hint
support is permitted; ignored hints do not block transcription. There is no
hint-stripping fallback or provider switch; existing retryable backoff remains.
Hold/raw voice and retained transcripts keep their existing behavior.

## Executed evidence

Private receipts are under
`~/.local/state/moss/vocci-recovery/vocabulary-build/`; frozen artifact digests are
in `evidence-sha256.json`. Gate logs are named below without machine addresses.

- `unit-final.log`: 403 tests in 12 files passed, exit 0.
- Isolated `test:integration:3584`, log suffix `20261024-082338`: 102 tests in
  seven files passed, exit 0; throwaway database container removed. Includes
  owner isolation, defaults/partial updates, conflicting writers, coherent pair
  reads, live capture, short imports, long windows, hold independence, actual
  configured-port multipart, legacy/pinned routes and immediate ASR rejection.
- Negative control `20261024-081615`: disabling RLS on the throwaway preference
  table caused the owner-isolation assertion to fail, exit 1. Negative control
  `20261024-081731`: replacing the canonical lock with a no-op caused the
  conflicting-writer assertion to fail, exit 1. Both containers were removed.
- `static-r1.log`: full `verify:static` exited 0. This began before final product
  amendments; final immutable-head static evidence must come from required CI.
- Isolated `test:vocabulary-live`, log suffix `20261024-082618`: exit 0,
  `VOCABULARY LIVE PASS`; container removed. Both successful isolated gates ran
  clean product head above, Node v22.22.2, pnpm 10.6.2, PostgreSQL 17.11,
  input fingerprint `f4a66d3ed2314961f7eb3af39d3a3d88be2a1dc49391dd783611c28ada7b54d3`.
  These are product-head receipts, not receipts for later documentation commits.

## Assembled real UI and transport

Webwright `live/final_runs/run_5/` retains the executable, six-step action log and
`receipt.json`. A fresh Firefox signed up a disposable owner through the real UI,
selected the disclosed ASR stand-in/model in real Settings, and exercised:

1. Explicit language, Save/reload, invalid language/oversize validation.
2. Actual browser-offline save failure, reconnect, module remount preserving the
   draft, and successful retry acknowledged from the returned record.
3. Keyboard focus and 390-pixel layout assertions; light/dark/sage theme attributes
   and computed styles. These are DOM checks, not a visual or accessibility audit.
4. A generated normal short import through the actual API/services/configured
   adapter: multipart model `unknown-vocabulary-support`, language `en`, prompt
   `Moss, Vocci`, audio 3,884 bytes.
5. A generated 36-second resumable import: first window 960,044 bytes with
   `Moss, Vocci`; while it was in flight, real Settings saved `Moss, Later`;
   next window 192,044 bytes received that updated prompt. Both windows completed.
6. Clear/reload followed by another short import: same model/language, prompt
   absent, prior transcript unchanged.

No Moss responses were intercepted. The third-party loopback ASR stand-in records
actual multipart and deliberately ignores the hints; generated sine audio and
synthetic packet framing prove transport, not recognition quality or real-device
framing. Browser service workers were blocked after Firefox reload stalls; this
proof makes no PWA lifecycle claim. Live capture is covered by isolated service
integration, not microphone UI proof. Browser/stand-in/API/worker/vault/database
were closed/removed; residual owned non-listening devport reservation released.

Runs 1–4 remain retained failures: two Firefox reload stalls, then two observer
assertions expecting 200 instead of the API's actual accepted-import 202. The
third run's premature ASR teardown also exposed an early rejected-request promise;
product head above immediately observes rejection during admission commit while
returning the original promise. Real-DB regressions verify safe terminal failure.
Mixed-input gate `20261024-082055` is invalidated and is not acceptance evidence.

## Review and remaining release gates

Plan `147592ae2`: Standards 0 / Spec 0. Initial product Standards P2 retry wording
was corrected; product `6acf64c37` and amendment `b8593a87a` each have Standards 0 /
Spec 0. Final evidence review and required final-head CI are recorded on PR #3653;
merge is permitted only after both settle successfully. Documentation commits do
not change the tested product; no local receipt is represented as reused at a
new fingerprint. Required CI independently verifies the final PR head.

## Preserved recovery queue and runtime boundaries

No production or phone access/mutation occurred in this slice. Companion 20261027
remains installed; never reinstall it. The one completed adapter outage remains
separate and must not repeat. Production copy source remains
`967bee00b1aa2119bc8ea55aa4b402f48898a6ff`; this slice authorizes no deployment.
Preserve signing/Keystore/config identity, queues/exclusions/originals/completed
imports/hold destinations, enabled=true, hold=false, cleanup=false, timeout120000
and official-app permission handoff. No new recording/replay, reset/rebind, source
deletion, hold enrollment, reboot, firmware or ownership write is authorized.

The unresolved queue remains package replacement; physical out-of-range/offline
and interrupted upload; separately opted-in production hold; reminder/endurance;
other approved missing Meeting processing; proven exact-source deletion;
original-preserving enhancement; firmware compatibility/recovery and streaming.
Virtual Android remains deferred. Best-effort vocabulary implementation is now
proved in isolation and live dev; it is not production deployment or hardware
acceptance. Continue from the
[recovery handoff](../../superpowers/handoffs/2026-10-24-vocci-recovery-continuation.md)
with the newer decision and boundaries above. Do not spawn into unchanged external
blockers. Any exclusive transfer requires actual fresh successor execution,
installation result and immutable session identity verification first.
