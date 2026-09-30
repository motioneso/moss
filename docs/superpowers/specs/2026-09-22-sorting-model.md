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
   - Email category and sign-in code split into a new job key with its own setup gate. Design
     agreed with Ben 2026-09-29 (#2805); section 11 records it.
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

## 11. Slice 3: email sorting on the sorting model (#2805)

Status: design agreed with Ben 2026-09-29. Step 1 (shadow comparison) built in PR #2807. Step 2
(switch), the sixth question and the unclear sign-in rule built for #2805 after Ben's rulings of
2026-09-29.

### Questions

The sorting model answers six atomic yes/no questions per email, in one request. On System One
each is a `noul` question, whose answer is one probability of yes with no separate confidence.
Any other sorting-capable provider answers yes or no with a confidence through the structured
path, read as a probability of yes (`confidence` for yes, `1 - confidence` for no).

| Id                  | Question                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `personal_sender`   | Did a real person write this to you personally, rather than an automated or bulk sender? |
| `asks_reply`        | Does it ask you a question or expect a reply?                                            |
| `asks_action`       | Does it ask you to do something (pay, sign, book, fill in a form)?                       |
| `near_deadline`     | Does it mention a date or deadline in the next week?                                     |
| `marketing`         | Is it marketing, a newsletter or a promotion?                                            |
| `receipt_or_notice` | Is this a receipt, order or booking confirmation, or an account or policy notice?        |

The model never picks the category. The state carries the subject, sender, received date, today's
date and the body, cut so the whole request stays under System One's 12,000-byte cap.

### Code-side facts

Not asked of the model:

- **Sign-in code.** The existing code check (`signInCodeDecision`). `hands-over-a-code` and
  `unclear` both decide: an unclear message is filtered as a sign-in code and no question is asked
  (Ben, 2026-09-29). This applies where the sorting model sorts; with no sorting model, `unclear`
  still makes the general model answer `deliversSignInCode` as before.
- **The user sent the last message in the thread.** The newest cached message in the email's
  thread came from one of the user's own addresses (the same address set the thread judgement
  uses).

### Mapping

First match wins:

1. Sign-in code -> skipped as a sign-in code, as today.
2. `marketing` yes and `personal_sender` no -> `noise`.
3. `asks_reply` yes -> `needs_reply`.
4. `asks_action` yes -> `needs_action`.
5. `receipt_or_notice` yes -> `receipt_or_notice`.
6. The user sent the last message -> `waiting_on_someone`.
7. `near_deadline` yes -> `time_sensitive_info`.
8. Otherwise -> `fyi`.

`receipt_or_notice` is a new stored category. Receipts, order and booking confirmations, terms of
service updates and account notices are not junk: they stay kept and searchable, but no briefing
reads them. A receipt that asks for a reply or an action takes that label instead (steps 3 and 4
win). The category lives in the `signals` jsonb, so no migration is needed.

### Unsure band

`unknown` is not produced. An answer from 0.35 to 0.65 inclusive is unsure; below is no, above is
yes. Each step reads its answers three ways (yes, no, unsure). A step that is clearly true decides,
clearly false moves on, and one that depends on an unsure answer sends the email to the general
model as today. An unsure answer that no reached step depends on is ignored: an unsure `marketing`
answer does not matter when `personal_sender` is clearly yes, and nothing after the deciding step
is read.

### Job key and gate

The job key is `module.connectors.email-sort`. It goes through the slice 1 gate unchanged: no
sorting model bound, an admin pin, or an exact `module.connectors.email-sort` binding all mean the
general model sorts as today. It accepts a System One model.

### Rollout

1. **Shadow comparison (built).** `pnpm email:compare-sorting <userId>` re-sorts one user's
   already-sorted mail through the path above and prints, side by side with the stored verdict,
   the agreement rate where the sorting model decided, the unsure count by step, how mail held for
   a closer look would have been sorted, a stored-versus-sorting table, and each disagreement with
   its six probabilities. `--out` writes the same as JSON (ids, verdicts and probabilities, no
   content). Nothing is written to the database and nothing the user sees changes; sync is
   untouched.
2. **Switch (built).** Sync asks the sorting model first. See "Switch" below. The comparison also
   reports how many messages it would file as `receipt_or_notice`, by stored verdict, and how many
   stored verdicts the sorting model set itself (agreement there is expected).

### Switch

Google and IMAP sync run a sorting-model pass before the general model's first pass
(`packages/connectors/src/email-sorting-live.ts`). The pass runs before any general-model batch,
so the scoped CLI session the general batches open and close covers only mail left for it.

- One settings read per pass (`resolveSortingModel` for the email job key) decides whether a
  sorting model is set. None set, or the read failing, sends every message to the general model.
- Each message is asked on its own. An unsure answer the decision depends on, a failed or thrown
  request, or a `not_supported` / `needs_config` answer sends that message to the general model's
  first pass, unchanged. The first `not_supported` / `needs_config` answer stops asking for the
  rest of the pass.
- Nothing names a model or provider. The slice 1 gate (binding, admin pin, exact job binding)
  decides, and the default is the general model. No new setting: the existing Sorting model row
  turns this on.

Stored shapes match the general model's first pass, so every reader keeps working. Every message
the sorting model settles carries `signals.sortedBy = "sorting_model"`.

| Category                                             | Stored as                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| `sign_in_code`                                       | The sign-in code skip (`skipped: "otp"`).                                         |
| `noise`                                              | Gate `nothing`, category `noise`, no summary.                                     |
| `needs_reply`, `needs_action`, `time_sensitive_info` | Gate `maybe_owed`, `pendingJudgement`; the thread judgement decides what is owed. |
| `fyi`                                                | Gate `worth_knowing`, category `fyi`, the preview summary.                        |
| `receipt_or_notice`, `waiting_on_someone`            | That category and the preview summary, no gate.                                   |

The preview summary is the same one the general path stores for worth-knowing mail: the snippet or
subject, through the body-echo guard. `hasFinishedVerdict` counts a bare `receipt_or_notice`
like bare `noise`, so an unchanged revision is not sorted again.

Readers checked:

- The morning and evening briefings read allow-lists (`fyi` for the worth-knowing roundup;
  `needs_reply`, `needs_action`, `time_sensitive_info` and important `waiting_on_someone` for
  action rows and the email catch-up). `receipt_or_notice` is on none of them.
- The email read tool and source context list the new value in their category enums, so a
  receipt stays visible to search and chat.
- No screen filters by category.

Settings disclosure: once a sorting model is chosen, the line under the row says each email's
subject, sender, dates and text go to it first. For System One it says TypeSafe answers News,
Sports and email sorting questions, so each email's subject, sender, dates and text go there too.

Sync logs counts only (`stage: "email-sorting"`): messages sorted per category and messages sent
to the general model per reason. No content goes into logs or job payloads.

### Data boundary (shadow)

- The comparison runs inside the named user's own data context, so row level security limits it
  to that user's mail. It is an operator command, not a product surface.
- The sorting model receives what the cache holds: subject, sender, dates and the stored excerpt
  (at most 500 characters), not the full body a live sync reads. Agreement from a comparison run
  is therefore a lower bound on agreement with full bodies.
- No content goes into logs, job payloads or the `--out` file. `--show-subjects` prints the
  subjects of disagreements to the operator's terminal only.

### Data boundary (switch)

- Live sync sends the sorting model the subject, sender, received date, today's date and the body,
  cut so the whole request fits the 12 KB cap. This is the same mail the general model already
  reads, and the settings disclosure line names it.
- Only counts are logged. Job payloads are unchanged: sync jobs carry ids, never email content.

### Tests

- Mapping order: each step beats the ones after it.
- Unsure band: both edges, each step deferring on its own unsure answer, unsure answers that do
  not matter, a missing answer read as unsure.
- The request stays under 12,000 bytes with a long multi-byte body.
- System One noul answers read as-is; a missing, out-of-range or wrong-type answer fails; a
  structured yes/no answer converts to a probability of yes; nothing is called with no sorting
  model bound.
- Comparison summary: agreement, unsure, pending and failed are counted separately; the receipt
  outcome and sorting-model-stored verdicts are reported.
- Switch: the receipt question and its place in the order, an unclear sign-in code filtered
  without a request, each stored shape, fallback when the sorting model fails, throws or is not
  set, the per-pass stop, and a stored receipt left out of a generated morning briefing.
