# Build plan — #2018 News story relevance integration and News surfaces

Spec: `docs/superpowers/specs/2026-08-18-906-story-relevance-feedback.md` (approved).
Implementation plan: the `SPEC` comment on issue #2018.
Parent: #906. Depends on #2016 (storage + lifecycle API) and #2017 (shared policy + evaluator),
both merged to `main`. Risk tier: security.

## 1. Seams check — every assumed capability, cited on this branch

| Assumed capability | Evidence | Verdict |
| --- | --- | --- |
| Shared relevance types and pure decision code | `packages/shared/src/story-relevance.ts:27` (`StoryRelevanceCandidate`), `:96` (`StoryRelevanceApplied`), `:109` (`StoryRelevanceDegraded`), `:241` (`decideStoryRelevance`) | exists |
| One policy entry point | `packages/usefulness-feedback/src/relevance/policy.ts:38` (`createStoryRelevancePolicy`) | exists |
| Policy is not constructed in production | only callers are `tests/unit/story-relevance-evaluator.test.ts:95` and `tests/unit/story-relevance-contract.test.ts:57` | unwired, as the spec says |
| Story target ref + bounded metadata | `packages/usefulness-feedback/src/story-target.ts:45`, `:80`, `:119` | exists |
| Target rows are written by nobody in production | only callers of `upsertTarget` for story kinds are `tests/integration/usefulness-feedback-helpers.ts:152` and `tests/integration/usefulness-feedback-story.test.ts:570` | gap is real — this slice fills it |
| `news_story` verifier registered | `packages/module-registry/src/index.ts:1741-1742` | exists |
| Preference-changed callback declared but unwired | `packages/usefulness-feedback/src/routes.ts:58` (declaration), `:375` (call site); no production caller passes it | unwired, as the spec says |
| News refresh queue helper | `packages/news/src/jobs.ts:71` (`enqueueNewsRefresh`), re-exported `packages/news/src/index.ts:24` | exists |
| News AI port satisfies the evaluator's port | `packages/news/src/discovery/ports.ts:63` `NewsAiPort.generateJson` vs `packages/usefulness-feedback/src/relevance/evaluator.ts:26` `StoryRelevanceAiPort.generateJson` — identical signature, News adds `fingerprint` | structurally assignable, no adapter needed |
| Compilation pipeline to insert into | `packages/news/src/compilation/compile.ts:104` filters, `:109` ranking, `:129` model-failure fallback, `:154` publish | exists |
| Overview composition point | `packages/news/src/news-service.ts:120` `getOverview`, `:317` `toPersonalizedHeadline`, `:230` `composeOverview` (non-personalized fallback) | exists |
| Response schema rejects undeclared fields | `packages/shared/src/news-api.ts:302` `additionalProperties: false` | confirmed — new field must be added to interface AND schema |
| Shared test fixture | `tests/fixtures/story-relevance.ts` | exists |
| News does not depend on the feedback package | `packages/news/package.json` has no `@moss/usefulness-feedback` | confirmed — keep it that way, inject a port |

**Open questions: none.** Every premise above was checked against this branch, not the spec text.

### One assumption made explicit

`hasEditorialEvidence` on a registered target means "this story led its source's feed". A published
snapshot does not carry feed position, so at overview time we derive it as **first story of its
publisher in the response**. That is the closest honest reconstruction from what is stored; it is
recorded here rather than hidden in the code.

## 2. Deliberate narrowing, carried forward from the implementation plan

The approved spec also asks that active preferences steer topic search planning. This slice does
not rewrite search queries from the owner's private reason text: there is no honest test seam for
it and it pushes private text toward a third-party search API, which the same spec's privacy rules
argue against. What ships instead is deterministic — exactly-rejected stories are dropped during
collection, and everything else is judged once, before publication. Query-level avoidance needs its
own issue.

## 3. Determinism boundary

- Every visible acknowledgement (the story disappearing, the Settings list, an error line) renders
  from the record or from the HTTP result, never from model output.
- The model has exactly one job here: judge whether a candidate story matches a saved preference
  and what evidence it carries. That prompt already exists and is fixed
  (`packages/usefulness-feedback/src/relevance/evaluator.ts:40`); this slice adds no prompt text.
- No module injects turns into host chat.
- The owner's reason text never enters a log field, a metric, a queue payload or a prompt beyond
  the compiled terms the dependency already produces.

## 4. Tasks

Ordered so each is testable before the next. Each commits green.

### Task 1 — News-owned port (no new dependency)

New file `packages/news/src/story-feedback-port.ts`:

```ts
export interface NewsStoryTargetRow {
  readonly storyRef: string;
  readonly surface: "news" | "today";
  readonly headline: string;
  readonly sourceLabel: string;
  readonly publishedAt: string | null;
  readonly topicRef: string | null;
  readonly hasEditorialEvidence: boolean;
}

export interface NewsStoryFeedbackPort {
  storyRef(canonicalUrl: string): string;
  registerTargets(
    scopedDb: DataContextDb,
    ownerUserId: string,
    rows: readonly NewsStoryTargetRow[]
  ): Promise<void>;
  applyRelevance(
    scopedDb: DataContextDb,
    input: {
      readonly ownerUserId: string;
      readonly candidates: readonly StoryRelevanceCandidate[];
      readonly now: Date;
    }
  ): Promise<StoryRelevanceResult>;
}
```

Exported from `packages/news/src/index.ts`. `@moss/news` gains no new package dependency; the
id helper uses Node crypto and must not reach the browser bundle.

Test: `tests/unit/module-dependency-allowlist.test.ts` must still pass unchanged.

### Task 2 — `feedbackRef` on a headline

`packages/shared/src/news-api.ts`: add optional `readonly feedbackRef?: string` to `NewsHeadline`
(`:48`) **and** `feedbackRef: { type: "string" }` to `newsHeadlineSchema.properties` (`:315`).
Not added to `required` — the non-personalized path has none.

`packages/news/src/news-service.ts`: `toPersonalizedHeadline` takes the port's `storyRef` and sets
the field. `composeOverview` leaves it undefined.

Test (unit, `tests/unit/news-service.test.ts` or nearest existing): a personalized overview carries
`feedbackRef` on every headline; the non-personalized fallback carries none. Fails against a broken
implementation because a headline built from a live feed has no verifiable target row.

### Task 3 — register the stories that were shown

`NewsService.getOverview` (`packages/news/src/news-service.ts:120`), after composing the
personalized response and inside the same data context: one `registerTargets` call with every story
in the response, capped at 40 (`NEWS_SNAPSHOT_MAX_ARTICLES`), each registered under both `news` and
`today`. Metadata is module, headline, source label, published time, first matched topic label,
and the editorial-evidence flag defined in section 1 — nothing else.

Failure is swallowed: log counts only, still return the stories.

Test (integration): after `GET /api/news/overview`, the feedback API accepts a preference on a
returned story and rejects one on a story never shown to that user. Fails against a broken
implementation because the verifier only trusts a pre-written row.

### Task 4 — apply the preference during compilation

`packages/news/src/compilation/compile.ts`, between the deterministic filters (`:104`) and ranking
(`:109`):

1. Map each filtered candidate to a `StoryRelevanceCandidate` — `storyRef` from the port, headline,
   `sourceLabel` from `publisher`, `publishedAt`, `feedPosition` as its index in the filtered list,
   `topicRef` as the first matched topic. `isOpinion` left unset: News has no opinion flag.
2. Call `applyRelevance`.
3. `degraded` → return `{ outcome: "kept_last_good", failureKind: "ai" }` without publishing.
   One counts-only log line: failure class, active preference count, candidate count, kept count,
   duration. Never a reason, headline, link or story reference.
4. `applied` → rank only the kept list, and add each boost's `lift` to that story's `relevance`
   before `orderRanked` sorts. The model-failure fallback at `:129` switches from `filtered` to the
   kept list, so a suppressed story cannot come back through it.

New log field variants added to `NewsCompilationLogFields` (`:20`) for the relevance step.

The port is optional on the compilation deps so existing tests keep working; when absent the step
is skipped entirely.

Tests (unit, `tests/unit/news-compile.test.ts`): a suppressed story is absent from the published
snapshot; a boosted story outranks an equal-scoring unboosted one; a degraded result publishes
nothing and reports `kept_last_good` with `ai`; the model-failure fallback path also drops the
suppressed story.

### Task 5 — a preference change refreshes News

`packages/module-registry/src/index.ts:1744` — pass `onStoryPreferenceChanged` to
`registerUsefulnessFeedbackRoutes`. When the target kind is `news_story` and `deps.boss` is not
null, call `enqueueNewsRefresh(boss, ownerUserId)`. Do nothing for `sports_story` (#2019 wires it).
Guard the null queue: several setups run without one.

Test (integration, extends `tests/integration/usefulness-feedback-story.test.ts`): saving a News
story preference enqueues exactly one News refresh; a Sports one enqueues none.

### Task 6 — the menu on the story cards

New `packages/news/src/web/story-feedback-menu.tsx` and
`packages/news/src/web/use-story-feedback.ts`. Uses `Menu` and `requestJson` re-exported by
`@moss/module-web-sdk`; no new dependency, no new CSS class names — the existing `jds-menu`
treatment only. Read the `design-system` skill first and run its audit after.

Behaviour contract:

- Renders nothing when the story has no `feedbackRef`.
- Three-dot trigger with an accessible label; items **More like this** and **Less like this**.
- More posts immediately, no reason.
- Less opens a labelled text field; empty or whitespace-only refused in the browser as well as on
  the server; 500-character cap; Escape and Cancel close it and return focus to the trigger.
- On success the story leaves the visible list at once and the next already-loaded story fills the
  gap; with no spare, the existing empty treatment shows. The rejected story is never put back.
- Then the News overview query and the feedback list query are invalidated.
- On failure the story stays put and one plain error line shows. Never claims a save that failed.

Wired into `packages/news/src/web/news-mosaic.tsx` (surface `news`) and
`packages/news/src/web/today-widget.tsx` (surface `today`).

Tests (unit): the removal-and-replacement rule; the reason editor's empty refusal, cap, Escape and
focus return; the pending and error states; the no-replacement empty case; both surfaces render the
menu only when a story carries a `feedbackRef`.

### Task 7 — News Settings shows what is shaping News

`packages/news/src/settings/index.tsx` gains a section listing active News story feedback, read via
a new function in `packages/news/src/web/news-client.ts` and a new key in
`packages/news/src/web/query-keys.ts`, from
`GET /api/me/usefulness-feedback?module=news&status=active`.

Each row: direction, stored headline and source, the reason where there is one, and when it was
created or last changed. A **Less like this** row offers Edit (PATCH the new reason); every row
offers Remove (the undo route). Both invalidate the feedback list and the News overview.

One short standing line stating that genuinely major stories may still appear even when they match
a preference — that is the honest description of the override rule, not decoration.

No new HTTP route in this slice. (A new route would also need a News manifest entry or the server
refuses to start.)

Tests (unit, `tests/unit/news-settings-pane.test.tsx`): the list renders each row's context; Edit
sends the new reason; Remove calls undo; both invalidate; the override line is present.

### Task 8 — outside-seam and browser proof

New `tests/integration/news-story-relevance.test.ts`, built on `tests/fixtures/story-relevance.ts`
(no second fixture — News and Sports are proven against the same stories):

- A **Less** preference makes the next compilation drop that exact story and later ordinary stories
  about the same subject, while keeping the exceptional one.
- Editing the reason changes the next compilation; removing the preference brings ordinary stories
  back.
- Evaluator failure: the previous snapshot survives, no new snapshot is published, the refresh run
  is recorded failed, and the exact rejected story still does not come back.
- The overview registers targets for what it returned; the feedback API accepts a story only after
  it was shown to that user.
- Two users: neither can see, edit, remove or be affected by the other's preferences, and an admin
  context gets no special view. (Hard invariant: no admin private-data bypass.)
- Instruction-shaped text in a reason changes nothing about the answer's shape and appears in no
  log line and no queue payload.

Extend `tests/integration/news-refresh-jobs.test.ts` with the degraded path.

Browser: extend `tests/e2e/news-overview.spec.ts` and `tests/e2e/news-settings.spec.ts` against the
mock News API in `tests/e2e/mock-news-api.ts` — the menu, the reason field, the immediate removal,
and the Settings list.

## 5. Verification

Never piped; exit code survives.

```bash
pnpm format:check > /tmp/2018-fmt.log 2>&1; echo "EXIT=$?"    # expect 0
pnpm lint > /tmp/2018-lint.log 2>&1; echo "EXIT=$?"           # expect 0
pnpm typecheck > /tmp/2018-tsc.log 2>&1; echo "EXIT=$?"       # expect 0
```

The full gate runs only through the `verify-gate` skill — an unscoped run hits the live development
database.

## 6. Kill gate after Task 4

Task 4 is the heart of the slice. If, once it is done, a suppressed story still reaches a published
snapshot, or a degraded evaluator result publishes anything at all, stop and escalate rather than
building the surfaces on top. Owner of that call: Ben, via the lane's blocked record.

## 7. Rulings ledger

- The News AI port is passed straight to the relevance policy. Rejected alternative: give the
  policy its own model binding. That would name a provider or model outside the user's configured
  router, which the provider-agnostic invariant forbids.
- The port is optional on the compilation dependencies. Rejected alternative: make it required.
  That forces every existing compilation test to grow a stub for behaviour it does not exercise,
  and buys nothing — the composition root always supplies it.
- `feedbackRef` is optional, not required, on `NewsHeadline`. The non-personalized fallback has no
  target row to verify against, so a required field would force us to mint references we cannot
  honour.
