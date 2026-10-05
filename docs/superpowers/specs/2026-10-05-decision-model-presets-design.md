# Decision models: Clef and any Jev-compatible service

**Status:** Approach approved by Ben in chat on October 5, 2026 ("generic type with presets is ideal"). Perplexity deferred to a follow-up.

**Tracking:** [Task #3057](https://github.com/motioneso/moss/issues/3057). Follow-up: [#3058 Perplexity preset](https://github.com/motioneso/moss/issues/3058).

## Goal

Let a user choose which decision model sorts their mail and judges Trail Marker focus. Today the only option is Jev through TypeSafe. Cloudflare's Clef and Clef-flash, two gateways and a family of self-hostable open models answer the same questions in the same format, so Moss should reach them without a new provider type per vendor.

## What exists today

- One provider kind, `system-one`, labelled "System One (TypeSafe)" in the picker.
- All calls go through `packages/ai/src/structured/generate-choices.ts`: `POST {base}/v1/systemone`, body `{model, state, questions}`, answers read from the top level of the reply.
- Test and model discovery call `GET {base}/v1/models`.
- A decision model may only serve the Classifier (sorting) row and the Trail Marker judge. It is never a default and never routed automatically. This stays as is.

## The landscape (checked October 5, 2026)

| Group                              | Examples                                                                                                                                                        | Moss needs                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Jev-compatible address and replies | TypeSafe (Jev), OpenRouter `/api/v1/systemone`, Vercel AI Gateway `/typesafe/v1/systemone`, self-hosted Kev 9B, Laya (`laya-serve`), SGLang's built-in endpoint | Works with the existing client; fix the rough edges below |
| Same answers, own address          | Cloudflare Clef, Clef-flash                                                                                                                                     | Cloudflare adapter (this spec)                            |
| Same answers, own address          | Perplexity `pplx-decider-v1-27b`                                                                                                                                | Deferred to #3058                                         |
| Different contract                 | Together `Tev1-4B` (chat, single letter)                                                                                                                        | Out of scope                                              |

Live probe of Cloudflare on October 5, 2026:

- `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef` with body model `"clef"` returned 200.
- The reply is `{"result": {model, answers, usage}, "success": true, "errors": [], "messages": []}`. Inside `result`, the answer fields match Jev's exactly (`type`, `noul`; `choice`, `probabilities`, `confidence`).
- `.../ai/v1/systemone` returns 400 "No route for that URI". There is no models list.

## Decisions

- **One provider kind.** Keep the `system-one` enum value. No migration. The UI calls it a "decision model".
- **The address picks the dialect.** A base URL on host `api.cloudflare.com` uses the Cloudflare dialect. Every other address uses the standard System One dialect. No new column, no stored dialect flag.
- **Presets are catalog entries**, the same way Mistral is an `openai-compatible` entry today:

| Picker label           | Kind       | Form asks for               | Base URL stored                                              |
| ---------------------- | ---------- | --------------------------- | ------------------------------------------------------------ |
| Jev (TypeSafe)         | system-one | API key; optional address   | blank (default `https://api.typesafe.ai`)                    |
| Clef (Cloudflare)      | system-one | Account ID, API token       | `https://api.cloudflare.com/client/v4/accounts/{account}/ai` |
| Any compatible service | system-one | Address (required), API key | as typed                                                     |

- **Several decision-model providers may coexist.** Jev and Clef have different labels already. "Any compatible service" stays addable after one exists.
- **The Classifier row and Trail Marker judge stay single-choice.** The user picks one decision model for each. No fan-out, no voting.

## Cloudflare dialect

| Step         | Standard dialect             | Cloudflare dialect                                            |
| ------------ | ---------------------------- | ------------------------------------------------------------- |
| Send         | `POST {base}/v1/systemone`   | `POST {base}/run/@cf/cloudflare/{model}`                      |
| Body `model` | stored model id              | stored model id (`clef` or `clef-flash`)                      |
| Read reply   | top-level `answers`, `usage` | `success` must be true, then `result.answers`, `result.usage` |
| Test button  | `GET {base}/v1/models`       | one-question probe to `clef-flash`                            |
| Discovery    | models list                  | fixed list: `clef`, `clef-flash`, both `json` / `economy`     |

- `success: false` or a missing `result` is a provider error, never `invalid_response` silently.
- The account ID is validated as 32 hex characters before Moss builds the address.
- The model id goes into the URL path, so it must match `clef` or `clef-flash` exactly. Anything else is refused locally.
- The API token is stored the same way as every other key: AES-256-GCM in the credential, never logged, never in job payloads.
- The 12,000-byte request cap stays the same for both dialects.

## Rough edges fixed for every decision-model provider

- **Adding a model by hand** on a decision-model provider defaults to capability `json`, tier `economy`. Today it defaults to `chat`, which makes the model silently unusable for sorting.
- **No model list.** When a compatible service answers 404 to the model list, the Test button says the service does not list its models and points to adding one by hand. It does not say the key failed.
- **Activity history** names the model that answered (for example "Clef-flash") instead of always "Jev". The classifier trial's "Jev disagreed" badge is a separate comparison and is unchanged.
- **Help text** stops saying "go to TypeSafe" unless the provider is TypeSafe.

## Add-provider form (Clef preset)

The form keeps the current picker panel, field style and button row. Only the fields change per preset.

```
┌ Clef (Cloudflare) credentials ──────────────────────────┐
│ Account ID                                               │
│ [ 0123456789abcdef0123456789abcdef               ]       │
│ On the Cloudflare dashboard, top right of Overview.      │
│                                                          │
│ API token                                                │
│ [ ••••••••••••••••••••                           ]       │
│ Use the "Workers AI" template. Stored encrypted.         │
│                                                          │
│                                  [ Cancel ] [ Add ]      │
└──────────────────────────────────────────────────────────┘
```

"Any compatible service" shows Address (required) and API key, with the hint "A service that speaks the System One API, such as OpenRouter or your own server." "Jev (TypeSafe)" is unchanged.

## App map and release note

- `packages/shared/src/app-map-core.ts`: replace the System One (TypeSafe) entries with the decision-model provider, its three presets, the Clef fields, and the no-model-list remediation.
- Release note: Added, "Choose your decision model", "You can now use Cloudflare's Clef, or any service compatible with Jev, to sort mail and judge focus."

## Testing

- Unit tests for each dialect, using an injected fetch:
  - Cloudflare URL building.
  - Unwrapping a wrapped reply.
  - `success: false` reported as a provider error.
  - A bad account ID or model id refused before any request.
  - Fixed model list for Clef.
  - Hand-added model defaults.
- An existing-behaviour guard: Jev requests and replies are byte-for-byte unchanged.
- Settings tests:
  - Clef form fields.
  - The compatible preset stays addable twice.
  - The no-model-list message.

## Live proof

- **Clef.** On the dev instance, add Clef next to Jev, run Test, bind the Classifier row to Clef-flash, and see a real sorting job succeed in Activity history named as Clef-flash.
- **Any compatible service.** Run Laya with `laya-serve` on this machine's CPU, add it as a compatible service, and get a real answer from it through Moss. Laya reads only 512 to 1,024 tokens, so the proof sends one short real question, not a full sorting batch.
- **Jev.** Confirm Jev still sorts after the change.

## Out of scope

- Clef's image input.
- Raising the 12,000-byte cap.
- Perplexity (#3058).
- Running several decision models at once on one job.
