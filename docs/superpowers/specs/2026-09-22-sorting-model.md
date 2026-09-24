# Sorting model

Status: draft rev 4, after three GPT 6 Astra reviews (last verdict: approve with changes, applied); Ben removed all sorting time limits 2026-09-22 to match the main model. Approval covers slice 1 only (sections 3 to 6).
Each later slice in section 7 needs its own approved contract and compatibility tests first; slice 2 was approved by an owner ruling on 2026-09-22 and is recorded there. Issue #2594. Research:
`docs/research/2026-09-22-sorting-model-fit-audit.md`. Related: System One provider spec (PR #2585,
task #2586).

## 1. Goal

Let an admin pick an optional **sorting model**: a small, fast model for sorting, filtering and
picking out details. Jobs that opt in try it first. When it is unset, bypassed, or fails, the job
runs exactly as it does today.

Moss ships no new container. A self-hosted sorting model (Needle, a small Ollama model) is run by
the person and added as a provider by address, like any other.

## 2. What exists today

- Admin-level job bindings live in `ai.service_bindings` (`app.instance_settings`). A binding is a
  mode (a tier) or a specific model.
- `resolveModelForService` (`packages/ai/src/repository.ts:1239`) handles module jobs.
  - A strict job with no binding returns `needs-config` (`:1252`). Email extraction is strict.
  - An admin pin overrides non-strict jobs (`:1261`).
  - Otherwise it tries the job's own `module.<id>` binding, then `module.worker`, then the
    capability default.
  - A module mode binding resolves its tier across providers.
  - For a non-strict job, an explicit model binding that is no longer usable first tries another
    capable model inside the default provider (`:1287`), and fails if none is available. It never
    continues to `module.worker`. A strict job fails straight away.
- `generateStructured` (`packages/ai/src/structured/generate-structured.ts:122`) serves JSON jobs
  on `anthropic`, `openai-compatible` and `google` kinds. It makes up to three attempts per model.
  Ollama works through its OpenAI-compatible endpoint.
- The story matcher (`packages/usefulness-feedback/src/relevance/evaluator.ts:85`) runs through
  the News and Sports model ports assembled in `packages/module-registry/src/index.ts:1203` and
  `:2368`. It resolves under `module.news` and `module.sports`.
- The repository accepts only chat and module binding keys (`packages/ai/src/repository.ts:803`) and
  deletes only module keys (`:858`).

## 3. Design (slice 1)

### 3.1 The setting

- A reserved key `sorting` in `ai.service_bindings`. It accepts only `{ kind: "model", modelId }`.
  Mode bindings for it are rejected, because "unset" already means "run as today".
- A model qualifies only if the sorting path can actually run it. It and its provider are active,
  its provider purpose is `assistant`, it has the `json` capability, and its provider kind is one
  `generateStructured` executes (`anthropic`, `openai-compatible`, `google`;
  `generate-structured.ts:147`). A local model runs through the OpenAI-compatible provider kind
  (Ollama and Needle-style servers both offer that). The dedicated `ollama` and `custom` kinds do
  not qualify in slice 1.
- No new capability in slice 1. A `sorting` capability arrives with the Jev slice, where a model
  can sort without supporting arbitrary JSON.
- Storage, route and schema changes, all in slice 1:
  - `packages/ai/src/repository.ts` saves, reads and deletes the `sorting` key.
  - `packages/shared/src/ai-service-binding-api.ts` accepts the key and returns it in the list
    response.
  - `packages/ai/src/capability-route-routes.ts` allows it, rejects mode bindings for it, and
    applies the eligibility rule above.
  - Save, read and delete round-trip tests through the real repository.

### 3.2 How a job opts in

`generateStructured` input gains `sorting?: true`. The result gains
`servedBy: "sorting" | "main"` on success. Existing callers are unchanged.

When `sorting` is set, the router applies this table in order:

| Condition                                              | What runs                                        |
| ------------------------------------------------------ | ------------------------------------------------ |
| The caller's signal is already aborted                 | nothing; returns `aborted`                       |
| The caller passed an explicit model                    | today's path only                                |
| An admin pin is set                                    | today's path only                                |
| The job is strict (`requireExplicitBinding`)           | today's path only                                |
| The job's own `module.<id>` binding exists             | today's path only                                |
| No `sorting` binding, or its model no longer qualifies | today's path only                                |
| Otherwise                                              | the sorting model, then today's path if it fails |

- "Today's path" is the unchanged `generateStructured` resolution for that job. A `module.worker`
  binding does not bypass the sorting model, because it is the generic default rather than a
  choice made for this job.
- The sorting attempt makes one try, never three. It has no time limit of its own, matching how
  Moss treats the main model. It shares the caller's abort signal.
- Fallback runs once on any failure (`needs_config`, `provider_error`, `validation_failed`). It never runs when the caller's own signal caused the abort.
- If today's path resolves to the same model that just failed, the router returns the original
  failure rather than asking it again.
- Per call, the worst case is one sorting try plus today's normal attempts.
- Logs carry metadata only: job key, `servedBy`, and the failure category.

### 3.3 Slice 1 user: the story matcher

- The News and Sports story-matcher calls pass `sorting: true` through their existing ports.
- One evaluation run handles several story batches in turn. After the first failed sorting attempt
  in a run, the remaining batches go straight to today's path.
- The evaluator accepts an optional abort signal and passes it through the policy and both ports,
  so a cancelled run stops both the sorting attempt and the fallback.
- The prompt, schema, evidence lists and the rule that code, not the model, makes the final keep,
  drop or nudge call are all unchanged. A JSON-capable sorting model answers the same schema.

## 4. Settings screen

One row under the existing per-job model rows on Settings > AI.

```
Model for each job
  Chat & briefing      [ Balanced (default provider)   v ]
  Email extraction     [ gpt-5-mini                    v ]
  Sorting model        [ Use main model                v ]
    A small, fast model for sorting, filtering and picking out details.
    Leave empty to use your main model.
```

- The dropdown lists "Use main model" and every qualifying model, grouped by provider.
- When a sorting model is chosen, a line under the row always reads: "Story details and your saved
  story preferences go to this model first, and to your main model if it does not answer. Each
  may charge for the request." The line grows with each slice's data.
- There is no live health line in slice 1. A failed sorting call falls back silently and is logged.
- If the chosen model stops qualifying (its provider is disabled or deleted), the row shows "Chosen
  model is unavailable. Using your main model." This reflects saved settings, not live calls.
- App map: the AI module's `features` gains a "Sorting model" entry. Error: "sorting model not
  answering". Remediation: "Moss tries your main model instead when it can. To stop trying the
  sorting model, choose Use main model."
- Release note (Added): "Pick a small, fast model to sort and filter your news and sports stories.
  If it does not answer, Moss tries your main model instead."

## 5. Data boundary

- The sorting model receives the same content today's model receives for that job: story details
  and the person's saved preferences, including their reasons.
- A fallback sends the same content to the model that would have received it without this
  setting. One run can therefore reach two providers, and both may charge. The settings line says
  so whenever a sorting model is chosen, local or not.
- Pins and strict jobs never reach the sorting model.
- All reads stay in the caller's scoped database handle. Nothing crosses users.
- No content, prompts or secrets appear in logs or job payloads.

## 6. Tests (slice 1)

- Routing table: one test per row, including a pin beating the sorting model, a strict job never
  reaching it, and an explicit caller model causing no request to the sorting provider.
- Eligibility: an `ollama` or `custom` kind model, or one without `json`, is rejected on save and
  absent from the picker.
- Story runs: a sorting failure on batch one means batches two onward skip it; an aborted run
  stops both the sorting attempt and the fallback.
- A `module.worker` binding does not bypass the sorting model. A `module.news` binding does.
- Fallback on each failure category. No fallback on a caller abort. No second call when both paths
  resolve to the same model.
- One try only on the sorting attempt.
- Binding routes: save, read and delete; mode rejected; a model with neither `sorting` nor `json`
  rejected.
- Story matcher: `sorting: true` passes through both ports; the prompt and schema are unchanged.
- Settings row: select, clear, and the third-party line.
- Live proof on dev: add a small JSON-capable model, set it as the sorting model, add a "less like
  this" news rule, and show the story hidden with `servedBy: "sorting"` in the log. Then disable
  its provider and show the main model takes over.

## 7. Later slices

2. **Sorting questions** (owner ruling, 2026-09-22: general, not a Jev special case). When any
   sorting model is bound and a job opts in, the job asks yes/no questions with a confidence, one
   per item, and matches on yes at or above a named threshold. This replaces sending the old
   evidence prompt to the sorting model. The story matcher asks one question per (story, saved
   rule): the story's headline, source label, team, competition and topic travel as data, and the
   rule's terms and reason travel in the same untrusted data half. Evidence lists stay empty on this
   path, so the "big news overrides a less-like-this rule" behaviour does not fire here yet. One
   general function in the AI package runs the questions with two backends chosen by provider kind:
   a System One model answers named choice questions through `generateChoices`, and every other
   sorting-capable provider answers a small structured JSON request with a yes/no and a confidence
   per question id. Requests are packed under the 12,000-byte cap and run a small bounded number at
   once. A failed sorting run falls back to the main model's evidence prompt for the rest of the
   run; a run with no sorting model keeps that prompt unchanged. The focus feature keeps its own
   approved behaviour and interface.
3. **More jobs.**
   - Email category and sign-in code split into a new job key with its own setup gate defined in
     that slice.
   - Commitments and task search opt in. Their today's path is preserved by construction.
   - News source and topic safety checks, after rewording away from "the active provider's policy".
   - The disclosure line is extended for each new data type.
4. **Modules and Needle.** The SDK flag, host request validator, and both bridges, JSON-only.
   Needle support once its serve API is confirmed.
5. **Remember sorting answers** (#2636). The story matcher stops asking about a (story, rule) pair
   it has already judged. The answer is remembered per owner, story, rule and sorting model, and it
   is re-asked when the rule or the model changes, or after seven days. Section 10 records it.

## 8. Decisions (recommended defaults, changeable)

1. **Storage.** Recommended: the reserved binding key, to reuse the routes and the row component.
2. **Pin versus sorting model.** Recommended: the admin pin wins.
3. **`module.worker` versus sorting model.** Recommended: the sorting model wins; an exact
   per-job binding still beats it.
4. **Focus judgment.** Decided by Ben, 2026-09-22: the Trail Marker focus judge **is** the
   sorting model, with no row of its own. The sorting binding therefore also accepts a System One
   model; the judge runs on it through choice questions. Since slice 2, sorting jobs use a System One
   model too, through the same choice questions; a job still on the free-form JSON path keeps
   skipping it. With nothing bound, focus judges nothing (it is never defaulted).

## 9. Not in this spec

- New sorting uses from the audit (marketing filter, chat tool narrowing, job dealbreaker). Each
  gets its own issue.
- A per-user sorting model. The setting is admin-level, like every binding.
- Replacing any hand-written rule.

## 10. Slice 3: remember sorting answers (#2636)

Status: built 2026-09-24. The story matcher asks a yes/no question for each (story, saved rule) on
every load. This slice remembers each answer so the next load does not ask again.

### What is remembered

One row per owner, story, rule and sorting model binding:

- The owner, from the caller's scoped database. The table is owner-only under row level security
  and no role bypasses it.
- The story identity, the same opaque reference the matcher already uses. It is a hash of the
  module and the canonical link, never the link itself.
- The rule id, plus a hash of the rule's terms and its reason text. Editing the rule changes the
  hash, so the old answer is not used.
- The sorting model binding, as a hash of the provider kind, the provider config, the
  configured-model row id and the upstream model id. Switching the model, or re-pointing a saved
  entry at another model in place, changes the fingerprint, so the old answer is not used.

The row stores only the verdict (`yes` or `no`) and the confidence. No prompt, no story text and no
reason is stored. The reason's own column stays the only place it lives.

### When it is used

The matcher reads remembered answers for the pairs it is about to judge.

- A remembered answer that is still fresh is used as-is, and no question is asked about it.
- A missing or expired answer is asked as today, and the fresh answer is remembered.
- If every answer is remembered, no request is made at all.
- The confidence floor is applied when the verdict is decided, not when the answer is stored, so
  changing the floor does not need a cache flush.

A remembered answer is only used when the sorting model is bound, because the key needs the model
binding. With no sorting model the matcher runs today's main-model path and nothing is remembered.

### Expiry and invalidation

- Answers expire seven days after they are written. An expired row is read as a miss and replaced.
- Writing new answers also deletes the owner's lapsed rows in the same scoped transaction, so rows
  for stories that have rotated out or for models that are no longer bound do not pile up. No
  background sweep is added.
- Editing a rule deletes its answers. Taking a rule back or replacing it with the opposite
  direction also deletes them. The key hash would already make an edited rule's answers unusable;
  the delete keeps the table small and honest.

### Data boundary and logging

- The table lives in the usefulness feedback module and is read and written only through that
  module's repository. Other modules go through the existing port.
- Logs carry counts only: how many answers were remembered and how many questions were asked. No
  headline, term, reason or story reference is logged.

### Tests

- Unit: a hit makes no request; a miss asks and remembers; a mixed batch asks only the misses; an
  edited rule's old answer is a miss; a changed model binding's old answer is a miss; a saved entry
  re-pointed at another upstream model is a miss; an expired answer is a miss; two candidates that
  share a story reference are remembered once.
- Integration: one user cannot read another user's remembered answers, cannot write a row claiming
  another user's id, and cannot delete another user's rule's answers; a write sweeps the owner's
  lapsed rows; editing, replacing or taking back a rule drops its answers.
