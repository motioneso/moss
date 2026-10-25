# Vocci chat-turn latency

Part of #3584. Baseline is the unchanged server from PR #3707; candidate adds
busy-turn and successful session-startup wakeups. No phone, ring, ADB or production
database was accessed.

## Setup and assertions

Fresh headless Firefox logged the existing isolated proof owner into the real UI,
opened AI Settings and ordinary Chat, then submitted generated TTS through the real
voice-enablement and voice-recording APIs. The proof temporarily enabled isolated
local CPU ASR and restored the previous disabled endpoint configuration on exit.
The configured chat provider/model stayed unchanged. Real tools executed; no
response interception, rewriting or replay supplied product results. Synthetic
packet framing does not prove physical ring behavior.

Each normal sample asserts a replied durable receipt, normal Chat visibility,
real tool and nonempty reply events, and identical import/receipt IDs on upload
replay. A separate busy sample submits a long typed turn through Chat, verifies
voice remains queued, cancels the typed turn through the real API, then waits for
voice dispatch and completion and checks replay identity.

Temporary numeric-only timing was applied to the local API bundle, never committed
to product source. It separates launch preparation, engine launch, tool readiness,
pre-model work, session readiness, context assembly, submission and first returned
engine record. Engine records are not provider-internal first-token telemetry.
Private local artifacts contain no evidence suitable for public attachment; only
aggregate timing and executable assertion outcomes are recorded here.

## Before and after

Baseline successful run 7 completed three TTS samples. Run 9 exercised busy
admission. Both exited 0. Baseline milliseconds:

| Stage                                      | Cold / warm 1 / warm 2 |
| ------------------------------------------ | ---------------------- |
| Upload returned → receipt observed         | 3659 / 6507 / 6364     |
| Upload returned → replied receipt observed | 18821 / 9991 / 10197   |
| Engine launch preparation                  | 19 / reused / reused   |
| Engine launch cumulative                   | 6891 / reused / reused |
| Tool readiness cumulative                  | 6891 / reused / reused |
| Turn start → pre-model complete            | 10 / 5 / 4             |
| Turn start → session ready                 | 6908 / 8 / 6           |
| Turn start → context ready                 | 6932 / 21 / 17         |
| Turn start → submission complete           | 6932 / 21 / 17         |
| Turn start → first engine record           | 13542 / 2005 / 1324    |

The busy baseline waited **14703 ms** from typed-turn cancellation to observed
voice admission and **21989 ms** to replied receipt. Observation polls every
100 ms, so API observations include polling and request overhead. Receipt timing
includes ASR and queue stages; it is not an ASR-only measurement.

Candidate run 11 exited 0: three normal samples plus the busy/cancellation sample.
The candidate was built from the final source changes with local numeric timing
added only to the disposable bundle. The preceding attempt failed during API
restart before readiness or upload; it supplies no timings.

| Stage                                      | Candidate 1 / 2 / 3 (ms) |
| ------------------------------------------ | ------------------------ |
| Upload returned → receipt observed         | 6946 / 7107 / 7485       |
| Upload returned → first tool event         | 13920 / 10884 / 8869     |
| Upload returned → first tool result        | 14125 / 11086 / 11081    |
| Upload returned → first reply event        | 15105 / 12090 / 12087    |
| Upload returned → replied receipt observed | 15408 / 12381 / 12374    |
| Turn start → pre-model complete            | 12 / 5 / 9               |
| Turn start → session ready                 | 15 / 8 / 13              |
| Turn start → context ready                 | 42 / 22 / 26             |
| Turn start → submission complete           | 42 / 23 / 26             |
| Turn start → first engine record           | 6180 / 3843 / 1382       |

Candidate prestart prepared in 26 ms and reached engine/tool readiness at 7721 ms,
before the first voice turn ran. Startup still costs seconds; the change wakes a
request deferred behind startup instead of waiting for the 15-second job. Tool
readiness adds under 1 ms after engine readiness in these launches; per-turn tool
attachment and model-side discovery are included in the observed engine time.
Provider-internal first token and thinking time could not be separated with this
engine interface and are not claimed as measured stages.

| Busy case                                     | Baseline (ms) | Candidate (ms) |
| --------------------------------------------- | ------------: | -------------: |
| Typed cancellation → observed voice admission |         14703 |            158 |
| Typed cancellation → replied receipt          |         21989 |           3509 |

The paired admission observation removes 14545 ms of delayed retry waiting.
Model runtime and ASR vary: normal-turn totals do not show a general halving.
The busy sample proves cancellation releases admission; unit tests also cover
normal completion and thrown turns. All samples disable their synthetic source
enablement, restore ASR configuration and close Firefox.

## Interpretation and limits

The ranked plan retains existing session reuse and the full authorized tools.
Launch and model execution dominate; no measured tool resolver or context assembly
bottleneck justifies a new cache, smaller prompt or permission invalidation policy.
The change wakes durable jobs when an active turn or successful warm launch ends,
while retaining the existing 15-second delayed job. Failed startup, private/other
chat selection and pending thread transitions still use delayed recovery.

No new setting or alternate model is introduced. These samples do not establish
halving total latency. Ben still needs five real release-to-action timings after
`updateMoss`, recorded in AWAITING-BEN.

## Validation

Test-first red: two busy-release assertions failed while the prior 15 tests passed;
the warm-launch wake assertion then failed while the prior 18 passed. Green: all
20 manager unit tests and 240 voice regression tests in ten isolated database
suites. These cover duplicate hints, stalled/failed hints, stale completed receipts,
re-deferral, concurrent claim, delayed replay, failure recovery and failed startup.

Fresh independent Sonnet review of the complete source diff found no blockers.
Its remaining observations are the retained delayed-only selection deferrals and
serial hint scheduling; a stalled hint cannot delay the completed turn response.
Static, full foundation and CI final outcomes are recorded on the PR.
