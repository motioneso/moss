# Plan: decision-model presets (Clef and Jev-compatible services)

**Spec:** [2026-10-05-decision-model-presets-design.md](../specs/2026-10-05-decision-model-presets-design.md)

**Tracking:** Part of [#3057](https://github.com/motioneso/moss/issues/3057). Branch `feat/3057-decision-model-presets`, PR #3059. One worktree, one PR.

## Seams check (tree at `60505036c`)

| Assumption                                                      | Evidence                                                                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All decision calls share one sender                             | `packages/ai/src/structured/generate-choices.ts:251` `postSystemOne`; URL built at `:428`                                                                               |
| Base URL is read once, defaulted to TypeSafe                    | `generate-choices.ts:306`                                                                                                                                               |
| Replies are parsed at the top level                             | `generate-choices.ts:367` (usage), `:468`, `:490` (answers)                                                                                                             |
| Test button lists models for system-one                         | `packages/ai/src/provider-validation.ts:20-47`, `:87-92`                                                                                                                |
| Discovery lists models for system-one, saves `json` / `economy` | `packages/ai/src/model-discovery.ts:197-202`, `:380-389`                                                                                                                |
| Provider body parsing accepts any non-empty base URL            | `packages/ai/src/routes.ts:1039`, `:1056`                                                                                                                               |
| Catalog entries can share a kind under different labels         | `apps/web/src/settings/settings-ai-provider-catalog.ts:13-16` (Mistral, OpenAI-compatible)                                                                              |
| Picker marks an entry "added" by display-name match             | `apps/web/src/settings/settings-ai-admin-pane.tsx:891-897`                                                                                                              |
| Credential form has only Base URL and API key                   | `settings-ai-admin-pane.tsx:841-860`, examples `:71-80`                                                                                                                 |
| Hand-added models default to `chat` / `interactive`             | `apps/web/src/settings/settings-ai-edit-model-form.tsx:192-199`; `AddModelForm` gets only `providerConfigId` (`:172`), mounted at `settings-ai-provider-models.tsx:231` |
| TypeSafe-only sorting note                                      | `apps/web/src/settings/settings-ai-sorting-row.tsx:34`, shown `:184`                                                                                                    |
| The tool check runs on the Classifier-bound model               | `packages/ai/src/structured/classifier.ts:119` `resolveSortingModel`                                                                                                    |
| "Jev" wording in Activity history                               | `apps/web/src/settings/settings-activity-line.ts:49`, `:97-98`; `settings-activity-pane.tsx:141`, `:253`                                                                |
| Activity lines carry the model name                             | `packages/shared/src/ai-activity-lines-api.ts:107` `modelName`                                                                                                          |
| App-map System One entries                                      | `packages/shared/src/app-map-core.ts:256-265`, `:311-314`                                                                                                               |

No migration. The `system-one` enum value stays.

**Open question (owner: builder, before task 6):** check whether `AddModelForm` can reach the provider's kind from its parent without a new fetch. If not, pass `providerKind` as a prop from `settings-ai-provider-models.tsx:231`.

## Determinism boundary

- Every Test message, form error and Activity label renders from the record or a fixed string. None comes from model output.
- The model has one job here, which is to answer typed decision questions. It authors no user-facing text.
- No prompt guidance is added.

## Phase 1: the Cloudflare dialect (server)

### Task 1. Shared preset helpers

New file `packages/shared/src/decision-model-presets.ts`, exported from the package index.

```ts
export type DecisionModelDialect = "standard" | "cloudflare";
export const CLOUDFLARE_DECISION_MODELS: readonly ["clef", "clef-flash"];
export function decisionModelDialect(baseUrl: string | null | undefined): DecisionModelDialect;
export function isCloudflareAccountId(value: string): boolean; // 32 lowercase hex
export function cloudflareDecisionBaseUrl(accountId: string): string; // throws on a bad id
export function isCloudflareDecisionBaseUrl(baseUrl: string): boolean; // exact shape check
```

`decisionModelDialect` returns `cloudflare` only when the URL parses and its host is `api.cloudflare.com`.

Tests in `tests/unit/decision-model-presets.test.ts`:

| Case                                                                                                  | Why it fails a broken build                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A TypeSafe, OpenRouter, Vercel or blank address gives `standard`                                      | A substring match on "cloudflare" would misroute `my-cloudflare-proxy.example` |
| An `api.cloudflare.com` account address gives `cloudflare`                                            | Catches a host check that compares the full URL                                |
| A 31-character or uppercase id is refused; a valid id round-trips through the builder and shape check | The id goes into a URL path, so a loose check lets `../` through               |

### Task 2. Cloudflare dialect in the sender

In `generate-choices.ts`, branch on `decisionModelDialect(provider.base_url)`:

- **Address.** Standard posts to `{base}/v1/systemone`. Cloudflare posts to `{base}/run/@cf/cloudflare/{model}`, and only when the model id is in `CLOUDFLARE_DECISION_MODELS`. Any other id is refused locally as `provider_error`, with no request sent.
- **Reading the reply.** Cloudflare needs `success === true` and a record `result`. Otherwise it is `provider_error`, with a warning log carrying the code only. The parsed reply then goes through the existing answer checks.

Tests extend `tests/unit/generate-choices.test.ts` with an injected fetch:

| Case                                                                                               | Why it fails a broken build                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A Cloudflare provider posts to `.../ai/run/@cf/cloudflare/clef-flash` with body model `clef-flash` | Catches the URL still ending in `/v1/systemone`                                       |
| A wrapped reply gives the same answers and token counts as an unwrapped Jev reply                  | Catches parsers reading the top level, which gives `invalid_response` and zero tokens |
| `{success:false, errors:[...]}` gives `provider_error`, not `invalid_response`                     | Catches the wrapper being ignored                                                     |
| A model id `../x` on a Cloudflare provider sends nothing                                           | Catches unchecked path building                                                       |
| Jev requests are unchanged: same URL, headers and body for a standard provider                     | Guards existing users                                                                 |

### Task 3. Test button and discovery

- **Cloudflare Test** (`provider-validation.ts`). Send a one-question probe through the Task 2 URL and unwrap: one yes/no question to `clef-flash`, with tiny fixed state and no user data. A 2xx with `success` passes. 401/403 means the key was rejected. Anything else is a failure.
- **Standard Test, model list returns 404.** Show the message "This service does not list its models, so the key could not be checked. Add a model by hand, then try it." This is not the rejected-key message.
- **Cloudflare discovery** (`model-discovery.ts`). Return `clef` and `clef-flash` as `json` / `economy` with no network call.
- **Server validation** (`routes.ts`, create and update). A `system-one` provider whose base URL host is `api.cloudflare.com` must pass `isCloudflareDecisionBaseUrl`. Otherwise reply 400.

Tests:

| File                                                  | Case                                                         | Why it fails a broken build                        |
| ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `tests/unit/system-one-provider.test.ts`              | The Cloudflare Test sends the probe                          | Catches a GET to the missing models list           |
| `tests/unit/system-one-provider.test.ts`              | A 404 models list shows the no-list message                  | Catches "Provider test failed"                     |
| `tests/unit/ai-model-discovery.test.ts`               | Cloudflare discovery gives the two models with no fetch call | Catches discovery hitting a 404 and saving nothing |
| `tests/integration/ai-provider-model-refresh.test.ts` | Creating a Cloudflare provider saves both models             | Catches discovery wiring that skips the new branch |
| `tests/integration/ai-provider-model-refresh.test.ts` | A malformed Cloudflare address is refused with 400           | Catches validation that only runs in the browser   |

### Phase 1 kill gate

**Owner:** Ben.

Before phase 2, create a Cloudflare provider through the API (the settings form arrives in phase 2). Then bind Clef-flash to the Classifier row and run one real sorting job. The line ends if any of these happen:

- Clef's answers fail Moss's answer checks on real sorting questions.
- Clef errors on more than 1 in 10 real requests.
- Ben judges the answers worse than Jev's on the same mail.

## Phase 2: settings, wording, app map

Use the `design-system` skill before touching UI. Use the existing picker panel, the `Field` and `jds-input` controls, and the button row. Invent no classes.

### Task 4. Presets in the picker

`settings-ai-provider-catalog.ts`:

- Replace the System One entry with three entries.
- Add `readonly preset?: "typesafe" | "cloudflare" | "compatible"`.
- Labels are "Jev (TypeSafe)", "Clef (Cloudflare)" and "Any compatible service".

`settings-ai-admin-pane.tsx`:

- **Already-added check.**
  - `typesafe` counts as added when a system-one provider has a blank or `api.typesafe.ai` address.
  - `cloudflare` counts as added when a system-one provider has a Cloudflare address.
  - `compatible` is never marked as added.
- **Form fields per preset.**
  - Cloudflare asks for "Account ID" and "API token". The address is built with `cloudflareDecisionBaseUrl`.
  - Compatible needs "Address", with the spec's hint.
  - TypeSafe is unchanged.
- **Help text.** Replace the TypeSafe example for the compatible preset.

Tests in `tests/unit/settings-ai-admin-pane.test.tsx`:

| Case                                                                    | Why it fails a broken build                        |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| The Clef form shows Account ID and token, and submits the built address | Catches the account id pasted raw into the address |
| A bad account id disables Add                                           | Catches a request the server would reject          |
| "Any compatible service" stays addable after one exists                 | Catches the label-match lockout                    |
| An existing "System One (TypeSafe)" provider still marks Jev as added   | Catches a regression for current installs          |

### Task 5. Sorting-row note

Show `SYSTEM_ONE_SORTING_NOTE` only when the bound provider is TypeSafe. Other decision models get a neutral note that names the provider's display name.

Test in `tests/unit/settings-ai-sorting-row.test.tsx`: a Clef binding shows no "TypeSafe" text.

### Task 6. Hand-added model defaults

On a `system-one` provider, `AddModelForm` defaults to `capabilities: ["json"]`, `tier: "economy"`. See the open question above.

Test: the add-model form on a decision-model provider submits `json` / `economy`. This catches the current silent `chat` default.

### Task 7. Activity wording

`settings-activity-line.ts`:

- `activityTitle` takes `modelName`.
- The tool check reads "{modelName} guessed which tool to use".
- Agreement reads "The classifier agreed." / "The classifier disagreed."
- The badge reads "Classifier disagreed".

`settings-activity-pane.tsx`:

- "Jev confidence" becomes "Confidence".
- "Jev check" becomes "classifier check".

Keep the fact key `jev_agreed`.

Update `tests/unit/2956-activity-lines.test.ts`. One case asserts that a Clef-flash line never contains "Jev", which catches a missed string.

### Task 8. App map and release note

- `app-map-core.ts:256-265`, `:311-314`. Describe the decision-model provider, its three presets, the Clef fields, the no-model-list message, and the hand-added defaults. Run `pnpm build:app-map`.
- PR release note:
  - Category: Added
  - Title: Choose your decision model
  - Description: "You can now use Cloudflare's Clef, or any service compatible with Jev, to sort mail and judge focus."

## Phase 3: live proof (recorded on PR #3059)

Use a dev instance from this worktree on a port from `devports claim`. The token is read from `~/.config/clef/token` and never logged.

1. **Clef.** Through the real Settings screen:
   - Add Clef with an account ID and token, then press Test.
   - Bind Clef-flash to the Classifier row.
   - Trigger a real sort.
   - Activity history shows "Clef-flash".
   - Screenshot crops go into the PR.
2. **Any compatible service.**
   - Run Laya with `laya-serve` on CPU.
   - Add it as a compatible service and add the model by hand.
   - Get one real short answer through Moss.
3. **Jev.** The existing Jev provider still sorts.

The e2e test is `tests/live/3057-decision-model-presets.spec.ts`, built on `classifier-2984-r26b-setup-uat.spec.ts`. Clef steps skip when the token file is absent. It must be run and observed passing, with the output recorded on the PR.

## Verification

Run the gate only through the `verify-gate` skill (`scripts/run-gate.sh`), never as a bare pipe.

```bash
pnpm typecheck > /tmp/3057-tc.log 2>&1; echo "EXIT=$?"     # expect EXIT=0
pnpm lint > /tmp/3057-lint.log 2>&1; echo "EXIT=$?"        # expect EXIT=0
pnpm check:ui-classes > /tmp/3057-ui.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm test:unit > /tmp/3057-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm test:ai-model-refresh > /tmp/3057-int.log 2>&1; echo "EXIT=$?"  # via verify-gate; expect EXIT=0
```

The full gate comes last, through `verify-gate`, and should finish with EXIT=0.

## Review

The build is DeepSeek through OpenCode, so cross-model review goes to a Claude reviewer (the side-pr-reviewer agent) before merge. Security focus:

- The token never reaches logs, payloads or the browser after save.
- The account id and model id cannot steer the request to another host or path.
