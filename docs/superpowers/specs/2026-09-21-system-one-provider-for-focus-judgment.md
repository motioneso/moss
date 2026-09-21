# System One provider for Trail Marker focus judgment

Status: draft, needs Ben's approval before any build. Part of #2570 (focus judgment). Extends
`2026-09-20-trail-marker-focus-judgment.md`, which names Jev as the judging model the person may
choose.

## 1. The problem

Jev, a model on TypeSafe's "System One" API, is the model Ben intends to use for focus judgment. It cannot
be used today. Moss's "custom" and "openai-compatible" providers send chat-completions requests
(`{base}/v1/chat/completions`). TypeSafe does not serve that route. Probed on 2026-09-21 with empty
bodies, so nothing was generated:

| Request                                           | Result                                                 |
| ------------------------------------------------- | ------------------------------------------------------ |
| `GET  https://api.typesafe.ai/v1/models`          | 200, `{"models":[{"name":"jev-latest",...},...]}`      |
| `POST https://api.typesafe.ai/v1/systemone`       | 422 naming the required fields `model` and `questions` |
| `POST .../v1/chat/completions` (three base forms) | 404                                                    |

Model names available: `jev-latest`, `jev-preview`. The published route list (section 2) confirms the two routes above are the only ones. With Jev configured as a "custom" provider,
every judgment fails to reach the model and is stored as `insufficient_evidence`, so nothing is
ever nudged. The failure is safe, but the feature does nothing.

## 2. What the API accepts and returns

TypeSafe publishes its contract at `https://api.typesafe.ai/openapi.json` (read on 2026-09-21). It
has exactly two routes: `GET /v1/models` and `POST /v1/systemone`. There is no chat-completions
route, so no change to a base URL or a key can make Moss's existing providers work with it. The key
is not the problem: it authenticates on `/v1/models`.

It is a general "answer named questions about some content" API, not a Jev-only one:

- Request: `{ model, state, questions }`. `model` is any name from `/v1/models` (today `jev-latest`
  and `jev-preview`). `state` is the content the questions refer to: a string, an object or an
  array. `questions` maps a name you choose to a question of type `noul` (yes/no, answered as a
  probability), `choice` (pick one of the listed criteria) or `score` (a rating).
- Response: `{ model, answers, usage }`. `answers` is keyed by the question names and each answer
  matches its question's type. `usage` reports input and output tokens.
- For `choice` the pilot (`tools/jev-pilot/pilot.py`) relies on `choice`, per-option
  `probabilities` and `confidence`. The published excerpt names the answer types but this spec has
  not yet read the full `ChoiceAnswer` schema; doing so is the first task and the validation rules
  in section 5 follow it.
- A `choice` question with the criteria `focused`, `necessary_detour`, `distracted` and
  `insufficient_evidence` maps directly onto Moss's four judgment labels.
- It returns no free text, so there is no model-written reason.

Nothing in this spec hardcodes a model: the person picks any model the API lists, and the code
refers only to the capability.

## 3. Design

**A. A provider type for the System One API.** A new provider kind, `system-one`, alongside the existing
kinds. Base URL defaults to `https://api.typesafe.ai`. The key is stored like every other provider
secret (AES-256-GCM at rest, never returned to the browser, never logged). Model discovery and the
Test button call `GET {base}/v1/models` and read `models[].name` and `release_date`. This is a
schema change (a new value on the provider kind enum, a new migration in the owning module's `sql/`)
and adds one entry to the provider picker in Settings, with its app-map entry.

**B. One router function that any model can serve.** `generateChoices` in `@moss/ai`: the caller
supplies the state and the named choice questions and a service key, and the router resolves the
model the person bound to that service, as for every other capability. The caller never names a
provider or model.

- If the bound model's provider is `system-one`, the request goes to `POST {base}/v1/systemone` in
  the System One shape and the answer is validated exactly as the pilot does.
- For any other provider, the same questions are rendered into a prompt and asked through the
  existing structured-answer call. The result has the same shape, with probabilities absent.

This is what keeps Moss provider-agnostic: focus asks for a capability, and Jev is one way of
answering it.

**C. Focus judgment uses it.** The judgment service calls `generateChoices` with the alignment
question, and the activity question alongside it (one call answers both). The alignment choice is
the judgment label. Because there is no model-written reason, the stored reason is built by Moss
from the two choices and the confidence, for example "Distracted, 91% sure; looks like shopping".
It is at most 140 characters, is never taken from window text, and so keeps the rule that window
text is never stored. The nudge rules are unchanged and still live on the server.

## 4. Data boundary and consent

The app name and shortened window title leave Moss and go to TypeSafe (a third party) on each
judgment, in addition to the person's own Moss server. The consent sentence in the Mac's Focus
pane and in the Settings row for the judgment model must say so in plain words. Text from window
titles stays quoted as untrusted data. The request carries no credential other than the provider
key, and no user identifier.

## 5. Failure behaviour

Unchanged from the focus spec: timeout, transport error, an invalid or inconsistent answer, or no
model bound all yield `insufficient_evidence` and never a nudge. An answer is invalid unless the
probabilities cover exactly the allowed choices, sum to about 1, and the chosen choice is the
highest. Errors log a category only.

## 6. Tests

- A contract test that the request body matches a fixture taken from a real accepted request
  (fails if a field is renamed or dropped).
- Answer validation: each rule in section 5 rejected on its own (each observed failing with the
  check removed).
- Provider add, discovery and Test against a local fake that answers like TypeSafe, including
  rejecting a bad key.
- The routing rule: a `system-one` model takes the bespoke path, any other model takes the prompt
  path, and both return the same shape.
- Live proof: one real judgment through the Mac app against the dev instance, recorded on the PR.

## 7. Decisions needed from Ben

1. **Kind name.** `system-one` (the API's own name) or `typesafe`. Recommended: `system-one`.
2. **Confidence floor.** Whether a `distracted` answer whose probability is below a threshold
   counts as `insufficient_evidence`. Recommended: yes, at 0.6, held as a named constant that the
   correction data can tune. The two-in-a-row rule already exists as a second guard.
3. **Recent context.** Jev accepts up to three recent observations. Sending them lets it judge a
   trend but sends more window text to TypeSafe. Recommended: send the previous one only.

## 8. Not in this spec

Any other non-OpenAI provider; free-text explanations from Jev; using Jev for image description
(the Mac's own image model is separate); batching or caching answers.
