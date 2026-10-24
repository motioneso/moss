# Sourced Weather interval replies

Task [#3639](https://github.com/motioneso/moss/issues/3639), part of
[#3583](https://github.com/motioneso/moss/issues/3583). Implements the approved
[spec](../specs/2026-10-23-visual-chat-replies.md) and
[handoff](../handoffs/2026-10-24-visual-chat-weather.md).
Ben authorized implementation, independent Standards/Spec review, fixes, verification,
gated squash merge and verified fresh successor. Work stays in
`~/Jarv1s/.claude/worktrees/visual-chat-weather`.

## Verified seams and scope

Baseline `2f64a9475`; fresh main adds release notes only. No overlapping open PR.
The live issue has the `task` label and is on project 2 (Ready at start).

| Capability                                         | Current evidence                                                                             | Decision                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Location/unit preferences and approximate fallback | `packages/weather/src/weather-service.ts:9`, `:94`, `:101`                                   | Reuse the existing actor-scoped preference resolution; mark IP/time-zone guesses approximate. No preference write.            |
| Existing current/daily source                      | `packages/weather/src/open-meteo.ts:59`                                                      | Keep current/daily behavior compatible; extend with a separate bounded hourly adapter at the same reviewed Open-Meteo origin. |
| Real place time zone absent today                  | `packages/shared/src/weather-api.ts:21`                                                      | Require provider time-zone identity for interval windows; a place label or actor zone is insufficient.                        |
| Weather API and service construction               | `packages/weather/src/routes.ts:42`; `packages/module-registry/src/index.ts:2684`            | Add public GET `/api/weather/forecast` and an authorized module read tool over the same reader.                               |
| Actor-scoped tool database/context                 | `packages/module-sdk/src/index.ts:125`, `:185`                                               | Use the gateway's existing scoped database for preference reads; avoid nested transactions.                                   |
| Canonical local-day and DST arithmetic             | `packages/module-sdk/src/time.ts:119`, `:160`; `packages/shared/src/time.ts:57`              | Use localDay/localDayRange/addLocalDays and actual timestamp offsets; never infer day or zone from UTC labels.                |
| Public source proposal seam                        | `packages/sports/src/results/tool.ts:34`                                                     | Register only normalized current-turn facts, return reference-only proposal DATA; model decides presentation.                 |
| Public template validation                         | `packages/module-sdk/src/visual-template.ts:2`; `packages/sports/src/results/contract.ts:86` | Weather owns validation, formatter and card; no Weather imports/branches in core chat.                                        |
| Built-in catalog composition                       | `packages/module-registry/src/index.ts:3354`                                                 | Declare the Weather template in its manifest. Preserve generic and Sports catalogs.                                           |
| Browser discovery/lazy renderer                    | `packages/settings-ui/src/scanner.ts:169`                                                    | Export browser-safe `./visual` and lazy `./web/visual`; preserve module-scope lazy identity.                                  |
| Installed configured-engine harness                | `tests/uat/provisioned-run.ts:29`; `tests/uat/specs/real-chat-signin.ts:158`                 | Disposable installed stack; discover economy model, never hardcode it.                                                        |

## Bounded contracts and ownership

Weather owns `src/forecast/` (provider normalization, window selection, reader, tool,
browser-safe contract and React card) and additions to shared Weather API contracts.
The query names a place optionally, a local day offset 0–4 and an hourly half-open
window of at most 12 hours (default 18:00–22:00 today in the forecast place's zone).
Ambiguous place reads return candidates and require conversational clarification;
explicit qualified place reads never save Settings. No new writers, credentials,
source authority, subscriptions, controls or action dispatch.

Provider responses carry unix interval timestamps and a valid time-zone identity.
Request explicit temperature/wind units and validate the returned units. Normalize
only finite source values; unsupported rain/wind remain unknown. Resolve requested
local day/window after receiving the place's real zone. Track requested and covered
window, complete/partial/missing intervals, retrieval/observation timestamps and
freshness. Do not substitute current/daily lows for evening data. Missing intervals
return a truthful narrower current/daily outlook when available, without a fabricated
strip. Bounded cached reads preserve the original retrieval time; explicit update
bypasses cache and produces a new authorized read.

The snapshot contains display-required place, approximate/source status, units,
zone, requested window, actual intervals, coverage and freshness only. Host/module
owns every number, timestamp, source identity, status and fallback. Persist through
the existing immutable visual envelope; history performs no source read. No raw
provider payloads or location settings are saved in visual metadata.

The model has exactly two jobs: decide whether a visual helps and choose/arrange
registered components; write concise interpretation. Trusted guidance stays below
150 words plus generated contracts. Modules never inject turns or author save status.

Use the approved Weather target (place/window, temperature, supported rain/wind,
source/freshness and interval detail), shared Card/SectionHead/Badge/Note and existing
accessible shared row/table primitives. Module CSS is layout only and uses tokens.
No new screen or interaction is introduced. Unknown fields/coverage are explicit.

A separate interval reader avoids making every Today/briefing read fetch and persist
an hourly payload. Extending only today's DTO would share one request but would
couple background/UI consumers to interval selection and still require an explicit
place/refresh contract. Keep common preference/location resolution shared.

## Behavioral verification

- Provider/window tests: place-local date across UTC boundaries; DST gap/fold windows;
  explicit metric/imperial units; null/out-of-range/absent rain/wind; missing/duplicate/
  unordered/partial hourly data, stale observation/retrieval and invalid zone. Broken
  implementations using daily lows, actor zone or synthetic intervals must fail.
- Reader tests: saved versus approximate fallback, qualified/ambiguous/corrected place,
  no preference writes, actor/unit/location cache separation and explicit refresh.
- Catalog/tool tests: real gateway permission/module checks, successful current-turn
  registration and reference-only proposal, forged/foreign references, cancellation
  and thread isolation. Reuse existing host tests with explicit scope; observe security
  negative controls failing with the relevant guard removed where a new claim is made.
- Component/browser assertions: exact snapshot values, units, place/zone, missing fields,
  readable copy/fallback, immutable reload, 390px and drawer bounds, light/dark/sage.
- Installed acceptance: real owner sign-in and Settings/module path, discovered actual
  configured economy model, ordinary jacket questions, real authorized interval reads,
  natural proposals and persisted cards. No intercepted/faked app responses. Twenty
  fixed first-attempt prompts, at least 19 intended cards, useful text in all 20;
  four prose controls, novel composition and preserved Sports. Measure turn latency,
  prompt/output overhead and built bundle delta. Preserve every failed run.

## Gates, kill gate and continuation

Commit/push this plan before production code. Keep the inherited handoff in the PR.
All verification commands are unpiped and expect exit 0: scoped ESLint/Prettier,
root TypeScript and owning browser/package checks; meaningful Vitest unit cases;
`pnpm check:design-tokens`, `pnpm check:ui-classes`, and installed Playwright UAT.
Read verify-gate before DB/full tests; run `scripts/run-gate.sh start` then documented
detached `scripts/run-gate.sh wait --follow`, observing authoritative exit 0. Provision
and probe an owned healthy mail fixture before the full gate. Fresh exact-head CI,
including browsers, is separate. Use the PR skill and fill Release note.

Independent Standards and Spec reviewers examine the entire diff at the exact final
SHA. Fix/dispose all actionable findings, repeat affected checks and re-review changes.
Merge only when final head matches passing reviews, installed evidence, local gate
and CI, using squash with match-head and no admin override or branch deletion.

Kill gate: if real interval coverage, configured-engine reliability, runtime or data/
action boundaries fail, record a measured recommendation on #3583. Ben owns the actual
decision before dependent rollout. Existing chain authority cannot waive the renderer,
19/20 threshold or useful-text requirement. Broader provider/side-chat/lifecycle matrix
remains unverified until measured; umbrella 1b stays unchecked.

After verified merge, update tracking truthfully, select one bounded remaining read-only
family from current seams, commit/push its handoff on fresh main, use herdr-handoff to
launch a fresh isolated named session and verify Start execution. Carry the chain through
remaining read-only families, controls, actions and eight-family acceptance without
shrinking scope. Clean owned resources and keep durable routing/session identity.

## Rulings ledger

- 2026-10-24: Sports final receipt and host case-by-case receipt checked live. Their
  configured-Codex evidence does not establish every provider, arbitrary side chat or
  deletion case. Reuse only explicitly unchanged evidence.
- 2026-10-24: existing Weather read lacks interval timestamps and forecast-place zone.
  Weather service resolves preferences through a transaction runner; tool execution
  already supplies a scoped database, so the new reader must not nest that runner.
- 2026-10-24: the registry enforces a 240-character app-map description limit at boot.
  The first installed candidate failed during build on this limit, before acceptance.
  The corrected description is 212 characters. A second build found the missing web
  workspace dependency needed by the generated visual import; added `@moss/weather`
  to `apps/web`. Both failures remain in the verification record.
- 2026-10-24: source-ID negative control: temporarily removing the Open-Meteo ID
  check made `rejects malformed source snapshots` fail (Vitest exit 1); restored
  it and observed the Weather unit/card suite pass (22 tests, exit 0).
  Gateway tests exercise registered built-in declarations, session allowlist denial,
  absent-module denial and an allowed scoped read. These are deterministic evidence,
  not installed-model acceptance.
- 2026-10-24: independent review of `75633d2a2` requested changes: Standards found
  preference exceptions swallowed by source fallback; Spec found the real provider's
  imperial `mp/h` label discarded and an insufficient useful-prose predicate.
  Moved preferences outside the source catch, normalized `mp/h` to public `mph`,
  and added source-temperature/units and nonanswer checks plus full-answer assessment
  to the acceptance procedure. Regression suites cover each finding.
- 2026-10-24: installed run on `75633d2a2` signed in the owner, configured the
  discovered Codex economy `gpt-5.6-luna` and saved San Diego through Profile.
  It stopped before the source/matrix on a test assertion expecting required Weather
  in optional Modules. Removed that incorrect assertion; Profile is its actual settings
  path. This is a failed setup run, not acceptance. No prompt cases were attempted.
- 2026-10-24: paired production builds of the same source/toolchain, omitting only
  Weather's generated visual contract/renderer imports in the baseline, measured
  +5,990 JavaScript bytes (+1,911 gzip) and +487 CSS bytes. No token-savings claim.
- 2026-10-24: removing the session allowlist guard made the Weather denial test fail
  (exit 1); restored the guard. This supplements the source-ID negative control.
- 2026-10-24: Spec re-review of `a991e4e52` found that the new prose evaluator
  incorrectly required a degree glyph. Accepted equivalent ordinary Fahrenheit/
  Celsius/degrees wording while retaining source bounds, unit and nonanswer checks;
  all 12 prose-evaluator cases passed. Installed receipts also collect available
  per-message token usage; those totals do not measure marginal visual token cost.
- 2026-10-24: supplemental installed run using product source at `a991e4e52`
  produced 20/20 exact-source Weather cards. The compiled older acceptance harness
  rejected eight useful answers: seven parsed clock minutes in `18:00 to 66°F` as
  temperatures; one required temperature despite source-grounded 1% rain advice.
  Manually assessed all 20 complete recorded answers against the real source:
  71 to 66.1°F, 1% rain, light winds in San Diego's local evening. Added clock/rain
  regressions and supported rain bounds without changing prompts or thresholds.
  This failed harness run remains supplemental, not exact-final-head acceptance.
- 2026-10-24: exact-head installed run on `d97d43c77` stopped after two valid
  cards/useful answers: the second read reused the qualified saved place in conversation,
  so its truthful location source was `conversation` rather than `stored-preference`.
  Every other field matched the independent source. The harness now independently
  reads both authorized location-resolution paths before the matrix and requires exact
  equality to one complete DTO, including provenance; it never ignores that field.
  This stopped run is retained and does not establish the twenty-case acceptance gate.
- 2026-10-24: run 6 on `f4d7c18e4` exposed an actual configured-engine failure:
  case 2 asked for clarification after looking up shortened `San Diego` despite the
  saved qualified California identity. Of four attempted prompts, three had useful
  correct cards and one had an unnecessary clarification. Case 4 then stopped the
  harness because a new authorized retrieval timestamp differed from the initial
  baseline. This is incomplete acceptance and includes a genuine usefulness failure.
  The proposed repair resolves matching city/qualifier references through the saved
  identity, while conflicting places still use lookup/ambiguity and never save changes.
  Three saved-identity regressions failed before the repair. An explicit conflicting
  region regression preserves conversational correction. The harness now checks each
  card against its contemporaneous independent authorized source and accumulates
  matrix assertion failures so an early mismatch does not hide later cases.
  Ben's actual decision is required before dependent rollout; neither this repair
  nor a later retry silently waives or erases the failed configured-engine run.
- 2026-10-24: Ben replied “Yes” to the queued saved-place repair recommendation,
  then “resume please” in the session. Continue the unchanged gated chain; this
  is no renderer, threshold or scope waiver. Removed the resolved Awaiting-Ben entry.
- 2026-10-24: exact clean `087e30d` passed the full isolated local gate:
  1,562 unit files / 18,507 tests / three skips; 14 seed files / 35 tests;
  394 integration files / 4,093 tests / one skipped file and three skipped tests.
  Detached authoritative waiter exited 0. Fresh CI and both reviews were green.
- 2026-10-24: installed run 7 on `087e30d` discovered Codex economy
  `gpt-5.6-luna` and produced 20/20 exact-source Weather cards. All full answers
  were recorded. The evaluator falsely rejected the correct rounded 5°F drop
  from the source's 71 to 65.9°F endpoints. Added an observed-red regression
  distinguishing source-calculated differences from absolute temperatures and
  rejecting incorrect differences/units. Prompts and acceptance thresholds stay fixed.
  Reload, drawer/390px/themes, four prose controls, novel composition and unchanged
  location passed. Sports preservation failed: the model asked whether Liverpool
  meant the men's first team despite the saved follow. This is a real configured-
  engine preservation failure, separate from the evaluator false negative; run 7
  remains failed. The current generic routing guidance only orders domain reads
  before web research. Extend it to try an authorized preference-resolving read
  before disambiguation, preserving genuine ambiguous-result clarification. Log
  the complete preservation reply before asserting its visual/source. Re-review,
  fresh exact-head gate/CI and installed evaluation are required. Retain the kill
  gate for this actual failure; no complete acceptance or merge claim yet.
- 2026-10-24: Ben explicitly chose “Continue after every unchanged gate passes
  (Recommended)” for the separate run-7 Sports preservation failure and reviewed
  repair. The decision covers unchanged installed acceptance, independent review,
  full gate and CI, with merge and verified successor only if all pass. Removed
  the resolved new Awaiting-Ben entry. This is no renderer, threshold or scope
  waiver. The obsolete `6f61b03` full gate was stopped with the official stop
  command (143), and its installed build was stopped before prompt evaluation
  so both can restart on the final ruling commit. These are superseded runs,
  not passing acceptance evidence or hidden model retries.
