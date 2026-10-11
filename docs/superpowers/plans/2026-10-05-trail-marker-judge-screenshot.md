# Plan: Trail Marker judges the screenshot directly (#3067)

**Spec:** [Judge the screenshot directly](../specs/2026-10-05-trail-marker-judge-screenshot.md), approved by Ben on October 5, 2026.
**Task:** #3067. **Depends on:** #3057 (PR #3059). Nothing here starts until #3059 is merged; every citation below is from #3059's branch at `2efefeafc` and must be re-checked against `main` after it lands.

## Seams (verified, file:line on `2efefeafc`)

| Seam                                                           | Where                                                                                                                                                      | Consequence for this plan                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `generateChoices` input has no image field                     | `packages/ai/src/structured/generate-choices.ts:43-59`                                                                                                     | Add `image?: string` to `GenerateChoicesInput`.                                                                                     |
| One body for both dialects; 12,000-byte cap on the whole body  | `generate-choices.ts:301`, `:303`, `:95`                                                                                                                   | Cap the body **without** `images`, then attach `images` under its own cap. Otherwise every image request fails `request_too_large`. |
| Dialect comes from the provider's `base_url`, not the model    | `generate-choices.ts:273`, `:311-315`                                                                                                                      | The image check sits after `:312`, where dialect and model are both known.                                                          |
| `explicitModel` is typed to 4 fields; the runtime row has more | `generate-choices.ts:43-59`; `AiConfiguredModelSafeRow.capabilities` `packages/ai/src/repository.ts:141`                                                   | Widen `explicitModel` to include `capabilities`.                                                                                    |
| Clef rows get `["json"]` only                                  | `packages/ai/src/model-discovery.ts:157-162`, `:391-399`; `tests/unit/ai-model-discovery.test.ts:300-331`                                                  | Cloudflare branch infers `["json", "vision"]`.                                                                                      |
| Judge model = the Classifier (sorting) binding                 | `AiRepository.resolveFocusJudgeModel` `repository.ts:1465-1485`                                                                                            | `judgeName` and `judgeTakesImages` come from this row. "Your focus judge" is the Classifier model.                                  |
| Activity log never sees state or body                          | `generate-choices.ts:399-426`, `:136`; warn sites list `{service, code}` only                                                                              | Keep it so; add `images` count fact.                                                                                                |
| Fact keys allow-listed in SQL and TS                           | `packages/ai/sql/0258_activity_owner_lines.sql:62-63`; `packages/ai/src/model-activity.ts:182`                                                             | New migration replacing the trigger function; never edit 0258.                                                                      |
| `not_supported` → prompt fallback                              | `packages/focus-judgment/src/judgment-service.ts:218`, `:226-249`                                                                                          | With an image, `not_supported` must end as `insufficient_evidence`, never fall back.                                                |
| Judge body schema is closed; no route `bodyLimit`              | `packages/shared/src/companion-api.ts:477-509` (`additionalProperties:false` `:480`); `apps/api/src/companion-routes.ts:367-402`                           | Add `image` to schema; add route `bodyLimit` like backtrack `companion-routes.ts:111`, `:426-432`.                                  |
| Context response schema is closed                              | `companion-api.ts:460-475` (`:464`)                                                                                                                        | Add `judgeTakesImages`, `judgeName` to schema or they are stripped.                                                                 |
| Server logs carry no body; error handler logs no body          | `apps/api/src/server.ts:249-254`; `apps/api/src/error-handling.ts:180-236`, `:207-213`                                                                     | Assumption to prove, not to claim: the no-retention test (Task 4).                                                                  |
| Log capture in integration tests                               | `tests/integration/companion-backtrack-routes.test.ts:52-59`, `:194-198`                                                                                   | Copy this pattern.                                                                                                                  |
| Focus route tests inject only `focusGenerate`                  | `server.ts:118`; `tests/integration/companion-focus-routes.test.ts:215`                                                                                    | Add `focusChoose` injection, or fake the provider over `fetch`. Builder picks; record the choice.                                   |
| Mac rung-3 flow                                                | `apps/trail-marker/TrailMarker/App/FocusRuntime.swift:528-614` (capture `:579`, encode `:585`, describe `:587`, second judge `:610`); test flow `:294-390` | Branch at `:572` on the new source.                                                                                                 |
| Mac contract types                                             | `Services/CompanionClient.swift:98-101`, `:103-125`, `:326-339`                                                                                            | Optional new fields, so an older server still decodes.                                                                              |
| Source persistence                                             | `Services/PreferencesStore.swift:34`, `:134-139`; `Services/VisionDescriber.swift:5-8`                                                                     | Add `case judge` to `VisionSource`.                                                                                                 |
| App map has no rung-3 entry; prose only                        | `packages/shared/src/app-map-core.ts:96-99` (`profile`), `:248-272` (`aiproviders`, `:269-271`)                                                            | Update both prose entries.                                                                                                          |

**Open questions**

1. Does Refresh models overwrite stored capabilities on existing Clef rows, or only add new models? If it does not, rows created between #3057 and this build stay `["json"]`. Owner: builder, answer from `model-discovery.ts` before Task 1. Fallback: the person ticks Vision (spec §3).
2. Which migration number is free at build time. Highest seen: `0283` (all packages), `0260` (ai). Owner: builder.

## Determinism boundary

- The label, confidence and the stored reason come from the choice answers through the existing `judgmentFromChoiceAnswers` mapping. No model-written text exists on this path.
- Every Mac message ("unavailable", consent sentence, test result) renders from `judgeTakesImages`, `judgeName` and the judge response. None comes from model output.
- The model's job is the same two choice questions as today. No new instructions beyond the existing screenshot guardrail sentence (spec §4).

## Phase 1: server (one PR)

### Task 1: contracts

- `packages/shared/src/companion-api.ts`
  - `FocusJudgeRequest.image?: string`
  - `FOCUS_IMAGE_SCHEMA`: string, `pattern: "^data:image/jpeg;base64,[A-Za-z0-9+/=]+$"`, `maxLength: FOCUS_IMAGE_MAX_CHARS`
  - `export const FOCUS_IMAGE_MAX_CHARS = 1_048_576`
  - `export const FOCUS_JUDGE_BODY_LIMIT_BYTES = 1_310_720`
  - `FocusContextResponse` gains `judgeTakesImages: boolean`, `judgeName: string | null`; both are added to `focusContextRouteSchema` and required.
- `image` and `description` together → 400. The JSON schema can't express that cleanly here, so the route checks it.
- `model-discovery.ts` Cloudflare branch: `capabilities: ["json", "vision"]`.

### Task 2: `generateChoices` image lane

- `GenerateChoicesInput.image?: string`; `explicitModel` widened with `capabilities: readonly string[]`.
- With `image`:
  - Returns `not_supported` unless the dialect is `cloudflare` and the model's capabilities include `vision`.
  - Text cap checked on the body without `images`. Image cap is `FOCUS_IMAGE_MAX_CHARS`; over it → `provider_error`, code `image_too_large`.
  - Outbound body is `{ model, state, questions, images: [image] }`.
- Activity fact `images: 1` on a call that carried one; absent otherwise.
- `packages/ai/src/model-activity.ts:182` allow-list gains `images`.
- New migration `packages/ai/sql/NNNN_activity_fact_images.sql`. It is `CREATE OR REPLACE FUNCTION` of the 0258 trigger function with `'images'` added to the key list, and keeps the rest of the function body identical.

### Task 3: focus judgment

- `FocusJudgeInput.image?: string`; `FocusChooseInput.image?: string`.
- `judge`: with `image`, call `choose` with it. If the result is `not_supported`, the label is `insufficient_evidence` and the warn code is `judge_image_not_supported`; there is no prompt fallback. Without `image`, behaviour is unchanged.
- `FocusContext` gains `judgeTakesImages`, `judgeName`. Both are built from `resolveFocusJudgeModel`:
  - `judgeName` = `` `${display_name} (${provider_display_name})` ``.
  - `judgeTakesImages` = capabilities include `vision` **and** the provider's base URL picks the Cloudflare dialect. The dialect test is the same function `generateChoices` uses, so the two can't disagree.
- `focus-wiring.ts:79-87` passes `image` through.
- Routes: judge gets `bodyLimit: FOCUS_JUDGE_BODY_LIMIT_BYTES`, the both-fields 400, and `image` threaded into `focus.judge`. Context returns the two new fields.

### Task 4: tests (each states why it fails against a broken build)

| Test                                                                                                                                                                      | File                                                                 | Fails if                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare + vision: outbound body has `images:[dataUrl]`; 11,000-byte state plus a 200 KB image succeeds                                                                 | `tests/unit/generate-choices.test.ts`                                | the image is inside `state`, or the cap counts image bytes                                                                      |
| Image with standard dialect, with Jev, or with a model lacking `vision` → `not_supported`; fetch never called                                                             | same                                                                 | an image leaks to a provider that doesn't accept it                                                                             |
| No-image request byte-identical to before (snapshot of serialized body)                                                                                                   | same                                                                 | text path regressed                                                                                                             |
| `images` fact recorded as 1; allow-list rejects unknown keys still                                                                                                        | same + `tests/integration/ai-model-activity-log.test.ts`             | migration or TS allow-list missing                                                                                              |
| Judge with image + `not_supported` → `insufficient_evidence`, `generate` never called                                                                                     | `tests/unit/focus-choice-judgment.test.ts`                           | silent prompt fallback                                                                                                          |
| Route: image+description → 400; 1.3 MB body → 413; image accepted at 1 MiB                                                                                                | `tests/integration/companion-focus-routes.test.ts`                   | bodyLimit or schema wrong                                                                                                       |
| Context: `judgeTakesImages`/`judgeName` true and named for Clef-flash, false/name for Jev, false/null with no binding                                                     | same                                                                 | schema strips fields or dialect check diverges                                                                                  |
| **No retention:** judge with a marker image, logger at `trace` streaming to an array; marker base64 absent from every log line, activity row, judgment row and error body | same, logger pattern from `companion-backtrack-routes.test.ts:52-59` | **must be observed failing** with a deliberate `request.log.info(request.body)` added, then removed; record both runs on the PR |
| Schema: pattern rejects PNG/remote URL/non-base64; over-length rejected                                                                                                   | `tests/unit/companion-focus-schema.test.ts`                          | schema accepts what Clef or the cap would refuse                                                                                |
| Clef discovery infers `["json","vision"]`; Jev stays `["json"]`                                                                                                           | `tests/unit/ai-model-discovery.test.ts`                              | Clef never qualifies                                                                                                            |

### Task 5: app map and release note

- `app-map-core.ts` `aiproviders` (`:269-271`): add "If that model can read pictures, such as Clef, Trail Marker can also send it one picture of the window when the title isn't enough." `profile` (`:96-99`): name the third screenshot source and its unavailable remediation.
- Release note goes on the Phase 2 PR, since Phase 1 has no visible change. Phase 1 PR: `Category: N/A`.

### Phase 1 verification (unpiped, exit 0 expected)

Use the `verify-gate` skill. Never run the gate bare.

```bash
pnpm exec vitest run tests/unit/generate-choices.test.ts tests/unit/focus-choice-judgment.test.ts tests/unit/companion-focus-schema.test.ts tests/unit/ai-model-discovery.test.ts > /tmp/p1-unit.log 2>&1; echo "EXIT=$?"   # 0
# then the full gate via the verify-gate skill (scripts/run-gate.sh), sentinel-waited; EXIT=0
```

### Phase 1 e2e (exit criterion)

On the live dev instance, with Clef-flash bound as the Classifier:

1. `POST /api/companion/focus/context` with a paired device token shows `judgeTakesImages: true`, `judgeName: "Clef-flash (Cloudflare)"`.
2. `POST /api/companion/focus/judge` carrying a real 1024px JPEG of a shopping page during a calendar block returns a judgment in under 20s.
3. Grep the API and worker logs and the `moss_model_activity_log` row for the image's first 64 base64 characters: no match.

The commands and outputs are recorded on the PR.

### Kill gate after Phase 1 (owner: Ben)

Before Phase 2 starts, run 5 real windows from Ben's day through Phase 1's endpoint and through describe-then-judge (`tools/jev-pilot/clef_probe.py --compare`). **Stop the line** if either is true:

- Clef-flash gets the alignment wrong on 2 or more of the 5 where describe-then-judge gets it right.
- Median judge latency through Moss is over 5s.

Ben makes the call from the side-by-side table on the PR.

## Phase 2: Mac (planned in detail only after the kill gate)

The outline is fixed by the spec. Details firm up after Phase 1.

- **Sources and requests:**
  - `VisionSource.judge`.
  - `FocusContext` decodes the optional `judgeTakesImages` / `judgeName`; absent means false/null.
  - `FocusJudgeRequest.image` uses `encodeIfPresent`.
- **Rung-3 flow:** `sendObservation` (`FocusRuntime.swift:572`) skips the describer for `.judge`, sends the second judge call with the JPEG as a data URL, and drops the `Data` after the call.
- **Settings:** the `FocusPane` picker gets a third row only when `judgeTakesImages`, plus an unavailable state. The consent sentence names `judgeName` and "through your Moss server".
- **Test:** the button sends the capture to the judge and shows label and confidence. No judgment row is stored; this needs a `test: true` request flag or a separate route, decided at Phase 2 planning.
- **Tests:** the Mac cases in spec §8, in `CompanionClientTests`, `Rung3DecisionTests` and a new `JudgeSourceTests`.
- **E2E:** the spec §9 live proof through the real Mac app. Release note: Added, "Judge screenshots with your decision model".

## Rulings ledger

- 2026-10-05, seams check: the 12,000-byte cap covers the whole body (`generate-choices.ts:303`). Spec §6's "image has its own cap" therefore needs code, not just a constant. Decision: cap the body without images.
- 2026-10-05, seams check: the Trail Marker judge is the Classifier binding (`repository.ts:1465-1485`). "Your focus judge in Moss" therefore names the Classifier model; there is no separate judge setting.
- 2026-10-05, seams check: Clef rows infer `["json"]` (`model-discovery.ts:391-399`). Spec §3's "adds `vision` to the fixed list" lands in the Cloudflare discovery branch, not in `decision-model-presets.ts`, which holds ids only.
- 2026-10-05, seams check: the app map has no rung-3 entry (`app-map-core.ts`). The only coverage is prose in `profile` and `aiproviders`.
