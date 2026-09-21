# System One provider for Trail Marker focus judgment

Status: draft, needs Ben's approval before any build. Part of #2570 (focus judgment). Extends
`2026-09-20-trail-marker-focus-judgment.md`, which names Jev as the judging model the person may
choose.

## 1. The problem

Jev, TypeSafe's "System One" model, is the model Ben intends to use for focus judgment. It cannot
be used today. Moss's "custom" and "openai-compatible" providers send chat-completions requests
(`{base}/v1/chat/completions`). TypeSafe does not serve that route. Probed on 2026-09-21 with empty
bodies, so nothing was generated:

| Request                                           | Result                                                 |
| ------------------------------------------------- | ------------------------------------------------------ |
| `GET  https://api.typesafe.ai/v1/models`          | 200, `{"models":[{"name":"jev-latest",...},...]}`      |
| `POST https://api.typesafe.ai/v1/systemone`       | 422 naming the required fields `model` and `questions` |
| `POST .../v1/chat/completions` (three base forms) | 404                                                    |

Model names available: `jev-latest`, `jev-preview`. With Jev configured as a "custom" provider,
every judgment fails to reach the model and is stored as `insufficient_evidence`, so nothing is
ever nudged. The failure is safe, but the feature does nothing.

## 2. What Jev accepts and returns

Established by the pilot (`tools/jev-pilot/pilot.py`), not yet by a published contract from
TypeSafe. Confirming it against TypeSafe's own documentation is a first task.

- Request: `{ model, state, questions }`. `state` holds the declared goal, the current
  observation (app, window title, dwell time), up to three recent observations, and an evidence
  level. `questions` maps a name to `{ type: "choice", instructions, criteria }`, where `criteria`
  maps each allowed choice to a description.
- Response: `answers[name] = { type: "choice", choice, probabilities, confidence }`. Probabilities
  cover exactly the allowed choices, sum to about 1, and the chosen choice has the highest one.
- Its `alignment` question has exactly Moss's four labels: `focused`, `necessary_detour`,
  `distracted`, `insufficient_evidence`. The mapping to a Moss judgment label is direct.
- It returns no free text, so there is no "reason" sentence from the model.

## 3. Design

**A. A provider type for System One.** A new provider kind, `system-one`, alongside the existing
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
  Jev's own shape and the answer is validated exactly as the pilot does.
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
