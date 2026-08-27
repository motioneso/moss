# Build plan — Sports story relevance and the Sports surfaces (#2019)

Spec: `docs/superpowers/specs/2026-08-18-906-story-relevance-feedback.md`, plus the slice-level
build plan posted as the `SPEC` comment on issue #2019.
Issue: #2019 (Part of #906). Risk tier: security.
Branch: `fleet/lane-2019`, off `origin/main` @ `491148343`.

## Seams check — every assumed capability, cited

| Assumption                                                                               | Evidence                                                                                           | Status                       |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| `storyFeedbackTargetRef(module, link)` builds the opaque ref                             | `packages/usefulness-feedback/src/story-target.ts:45`                                              | exists                       |
| `buildStoryTargetContext(...)` bounds the stored story detail                            | `packages/usefulness-feedback/src/story-target.ts:80`                                              | exists                       |
| Story metadata is allow-listed on write                                                  | `packages/usefulness-feedback/src/story-target.ts:119`, used at `repository.ts:366`                | exists                       |
| `upsertTarget` registers one story row                                                   | `packages/usefulness-feedback/src/repository.ts:347`                                               | exists, singular only        |
| `createStoryRelevancePolicy` is the single filter entry point                            | `packages/usefulness-feedback/src/relevance/policy.ts:38`                                          | exists                       |
| Policy short-circuits with zero rules and makes no model call                            | `packages/usefulness-feedback/src/relevance/policy.ts:53-61`                                       | exists                       |
| Applied/degraded result shapes                                                           | `packages/shared/src/story-relevance.ts:98,111,116`                                                | exists                       |
| Candidate shape the policy consumes                                                      | `packages/shared/src/story-relevance.ts:27`                                                        | exists                       |
| Shared test stories + `sportsCandidate`                                                  | `tests/fixtures/story-relevance.ts:49,207`                                                         | exists                       |
| `SportsServiceDependencies` has no relevance/feedback port                               | `packages/sports/src/sports-service.ts:95-109`                                                     | gap is real                  |
| `getOverview` pulls hero-team feeds AFTER `buildHero`                                    | `packages/sports/src/sports-service.ts:457-509`                                                    | hoist needed                 |
| `canonicalStoryUrl` is the module's cross-feed story identity                            | `packages/sports/src/headline-composition.ts:26`                                                   | exists                       |
| `rankTopStories` tier 1 = each group's lead, tier 2 = followed-team stories by feed rank | `packages/sports/src/headline-composition.ts:145-168`                                              | exists                       |
| `toPublicHeadline` / `toTeamStories` are the public mappers                              | `packages/sports/src/headline-composition.ts:116`, `:60` (via import at `sports-service.ts:33,60`) | exists                       |
| `isWrittenArticle(headline)` is the only written-vs-clip signal                          | `packages/sports/src/news-ranking.ts:24`                                                           | exists                       |
| `DegradeState` threads the degraded flag through one pass                                | `packages/sports/src/sports-service.ts:154-157`                                                    | exists                       |
| Feedback endpoints: create / list / edit reason / undo                                   | `packages/usefulness-feedback/src/routes.ts:91,227,287,245`                                        | exists, no API change needed |
| `surface` accepts `"sports"` and `"today"`                                               | `packages/shared/src/usefulness-feedback-api.ts:20`                                                | exists                       |
| `Menu` primitive (trigger, outside click, Escape, focus return)                          | `packages/ui/src/menu.tsx:23`, re-exported by `packages/module-web-sdk/src/index.ts:23`            | exists                       |
| Menu pattern to copy (not import)                                                        | `apps/web/src/today/briefing-feedback-menu.tsx`                                                    | exists                       |
| One shared cache key for Sports page + Today widget                                      | `packages/sports/src/web/query-keys.ts:9`                                                          | exists                       |
| `buildSportsDiscoveryPorts` builds the owner-configured Sports model port                | `packages/module-registry/src/index.ts:736`, called `:1864`                                        | exists                       |
| `usefulnessFeedbackRepository` is in scope at the sports registration                    | `packages/module-registry/src/index.ts:332,1896`                                                   | exists                       |

Open questions: none. Every spec premise was re-checked on this branch and still holds.

## Determinism boundary

- Every visible response to a save renders from the record, never from model output: the menu
  shows "Saved" or the server's error, the row disappears from local state, Settings lists rows
  from `GET /api/me/usefulness-feedback`.
- The model has exactly one job here, already owned by #2017's evaluator: return per-story
  verdicts. This slice adds no prompt and no guidance text.
- Nothing this slice writes injects a turn into host chat.
- No log line, response field or queue payload may carry a reason, a headline, a link or a
  story reference. The policy's own log lines are counts only
  (`packages/usefulness-feedback/src/relevance/policy.ts:70,88`); do not add to them.

## Trust boundaries (security tier)

- The story-target row is the authorisation boundary: feedback on an unregistered
  `(owner, kind, ref, surface)` is refused. Registration is therefore mandatory, and must be
  done per surface (`sports` and `today`) or the Today widget's menu silently 403s.
- The browser never sees a raw article link as an identifier — only the hashed `storyRef`.
- Stored story detail passes through the allow-list; no new key may be added without adding it
  to `STORY_CONTEXT_KEYS` first, or it is dropped silently.
- The owner's reason text stays in its own column. It is never logged, never sent to the model
  as free text, and never rendered outside the owner's own Settings pane.

## Phase 1 — server: story reference, registration, filter, wiring

### Task 1.1 — `storyRef` reaches the browser

`packages/shared/src/sports-api.ts`

- Add `readonly storyRef?: string` to `Headline` and to `FollowedTeamNews`.
- Add `storyRef: { type: "string" }` to the matching response schemas in the same file.
  A field absent from the schema is stripped by the API server — this is the whole task.

`packages/sports/src/headline-composition.ts`

- `toPublicHeadline(headline: SourceHeadline, refFor?: (canonicalLink: string) => string): Headline`
- `toTeamStories(headlines: readonly SourceHeadline[], refFor?: (canonicalLink: string) => string): FollowedTeamNews[]`
- Both optional so every existing caller and test compiles unchanged. The ref is built from the
  canonical link, so the same story arriving from two feeds yields one reference.

### Task 1.2 — two injected ports

`packages/sports/src/sports-service.ts`, added to `SportsServiceDependencies`:

```ts
readonly storyRelevance?: StoryRelevancePolicy;
readonly storyFeedback?: {
  readonly refFor: (canonicalLink: string) => string;
  readonly registerStories: (
    scopedDb: DataContextDb,
    ownerUserId: string,
    stories: readonly RegisteredStory[]
  ) => Promise<void>;
};
```

`RegisteredStory` is declared in `packages/sports/src/sports-service.ts` and carries only:
`storyRef`, `surface` (`"sports" | "today"`), `headline`, `sourceLabel`, `publishedAt`,
`teamRef`, `competitionRef`, `hasEditorialEvidence`, `isOpinion`.
Both ports optional. Sports must not import `@moss/usefulness-feedback`; the types it needs
(`StoryRelevancePolicy`, `StoryRelevanceCandidate`) come from `@moss/shared` or are declared
structurally here. Module isolation.

### Task 1.3 — plural registration

`packages/usefulness-feedback/src/repository.ts`

- `upsertTargets(scopedDb: DataContextDb, inputs: readonly UpsertTargetInput[]): Promise<void>`
- One multi-row insert, same `ON CONFLICT (owner_user_id, target_kind, target_ref, surface)`
  clause and the same metadata sanitiser as `upsertTarget`. `upsertTarget` stays and delegates.
- Additive only; the News slice wants the same method, first one in wins.

### Task 1.4 — hoist the hero feed pull, then filter once

`packages/sports/src/sports-service.ts` `getOverview`:

1. Compute the gameday game list before `buildHero` (its gameday branch reads only scoreboards
   and follows), pull those teams' feeds, merge into `headlinesByComp`. Keep the existing
   comments explaining why the feeds are pulled at all.
2. Build one candidate list from every headline the page could show — per-competition pools,
   per-sport pools, each followed team's merged list — deduplicated on `canonicalStoryUrl`.
3. Call the policy once. Candidate mapping: `storyRef` from `refFor(canonical link)`, `headline`
   = title, `sourceLabel` = `publisherLabel`, `publishedAt`, `feedPosition` = position in its own
   feed, `competitionRef` = competition key, `teamRef` = first followed team key on the story,
   `isOpinion` = `!isWrittenArticle(...)` and left off when the check cannot tell.
   `hasEditorialEvidence` is true only for a story first in its own feed. Never invent evidence.
4. Filter every pool to the surviving refs, then let the existing composition run unchanged, so a
   filtered story cannot return through a sibling feed.
5. Wrap the policy call the way every other source call is wrapped: a throw sets `degraded` and
   keeps every story. A `status: "degraded"` result keeps `kept` and sets `state.degraded = true`.
   Live scores must keep updating through a relevance failure.

### Task 1.5 — the "more like this" lift

`packages/sports/src/headline-composition.ts`

- `rankTopStories(groups, followedTeams, boosts?: ReadonlyMap<string, number>, refFor?)`
- Subtract the lift from `feedRank` in the second-tier sort only. Tier 1 is each league's
  editorial lead and a boost may never enter it. Comment that the league news band keeps its own
  ranking and boosts are a server-side top-stories effect in this slice.

### Task 1.6 — register what the page shows

After the overview is composed, before returning: one `registerStories` call inside one data
context, covering every story in the response, once for `surface: "sports"` and once for
`surface: "today"` (the Today widget renders from the same response). Story detail built with
`buildStoryTargetContext`.
Add a comment where a reader would expect the `onStoryPreferenceChanged` wiring, explaining that
Sports composes live on every request so there is no snapshot to rebuild and no queue to schedule.

### Task 1.7 — composition root

`packages/module-registry/src/index.ts`, sports registration block (`:1896`):

- Reuse the object `buildSportsDiscoveryPorts` already builds as the policy's model port. No
  provider or model name anywhere.
- `createStoryRelevancePolicy({ ai, repository: usefulnessFeedbackRepository, logger })`.
- Story feedback port: `refFor` = `storyFeedbackTargetRef` bound to `"sports"`;
  `registerStories` = `usefulnessFeedbackRepository.upsertTargets`.

### Phase 1 verification (expected `EXIT=0`)

```
pnpm typecheck > /tmp/2019-tc.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/2019-lint.log 2>&1; echo "EXIT=$?"
pnpm test:unit > /tmp/2019-unit.log 2>&1; echo "EXIT=$?"
```

`module-sdk-worker` fails locally for everyone and is green in CI — not this branch.

### Phase 1 kill gate

**Owner: the lane, escalating through `fleetctl`.** End the line and re-slice if hoisting the
hero feed pull cannot be done without changing what the hero shows — that is, if an existing
`sports-service` test that asserts hero content goes red and the only way to green it is to
change the assertion. The hoist is meant to be an ordering change, not a behaviour change.

## Phase 2 — browser: the menu and its five homes

Planned in detail only after phase 1 ships green.

- `packages/sports/src/web/story-feedback-menu.tsx` — built on `Menu` from `@moss/module-web-sdk`,
  copying the shape of `apps/web/src/today/briefing-feedback-menu.tsx`. Sports cannot import from
  the web app.
  `StoryFeedbackMenu(props: { storyRef?: string; surface: "sports" | "today"; onRemoved: (ref: string) => void })`
  renders nothing when `storyRef` is missing.
- Client calls in `packages/sports/src/web/sports-client.ts` using `requestJson`: create, list,
  edit reason, undo.
- Homes: `sports-news.tsx` (top stories, both news-band sizes, story hero slide),
  `sports-ticker.tsx` (each story on a followed team or league card), `today-widget.tsx` (lead
  story and briefs). Never inside the story's link.
- Immediate behaviour: remove by reference in local state, promote the next unshown story already
  in the loaded response, fall back to the section's existing empty treatment, then invalidate
  `sportsQueryKeys.overview` only. Keep the removed set until a server response no longer carries
  the story — the page re-fetches every sixty seconds during a live game.
- Settings section in `packages/sports/src/settings/index.tsx`: list with `module=sports` and
  `status=active`, edit reason, remove, the one-line note that a major story can still appear, an
  empty state matching the pane's existing ones.
- Layout-only `sp-` classes into `packages/sports/src/web/styles/sports-6-newsband.css` and
  `packages/sports/src/settings/sports-2.css`. No colours in module CSS.

## Tests — behaviour, and how each fails against a broken build

`tests/unit/sports-service.test.ts` (extend):

1. Fake policy suppresses the ordinary matching story, keeps the exceptional one → it is gone
   from followed cards, hero, top stories and league news; the exceptional one survives in all.
   _Fails if the filter is applied per-pool instead of once over the merged candidate list._
2. The suppressed story also arrives from a second feed → still absent.
   _Fails if pools are filtered by object identity rather than by canonical link._
3. Degraded result → every story except the explicitly rejected ones survives, `degraded` is
   true, the scoreboard is still returned. A throwing policy does not fail the request.
   _Fails if the policy call is not wrapped like every other source call._
4. Every returned story's `storyRef` equals the ref built from its canonical link, and one story
   from two feeds has one ref. _Fails if the schema drops the field, or the ref is built from the
   raw url._
5. A lift promotes a story inside the second tier and never above a league's lead.
   _Fails if the lift is applied to the whole ranked list._
6. A service built with no relevance port behaves exactly as today and makes no model call.
   _Fails if the ports were made required._

`tests/unit/sports-story-feedback-menu.test.tsx` (new): opens; offers both actions; refuses an
empty or whitespace reason before sending; sends `sports_story`, the right ref and the right
surface; removes the story and promotes the next; shows the section's empty treatment when there
is nothing to promote; on a failed request leaves the story on screen and shows the error;
Escape returns focus to the trigger.

`tests/unit/settings-sports-pane.test.tsx` (extend): shows only Sports preferences; shows stored
story detail and reason; edits a reason; removes a preference; shows the major-story note;
invalidates both the feedback list and the overview.

`tests/integration/usefulness-feedback-story.test.ts` (extend): a second person cannot create,
list, edit or undo the first person's Sports preferences; a story never registered for this owner
is refused; a story registered for `sports` is refused when acted on as `today`.

Privacy assertion (in the service test): instruction-like text inside a reason changes nothing
about the answer's shape, and no log line, response field or job payload carries the reason, the
headline, the link or the story reference.

Extend, never replace. Existing `SportsService` tests with no relevance port must pass unchanged
— that is also the proof that an owner with no preferences pays nothing.

## Live proof (phase 2 exit)

On the dev instance, signed in as the test user with Sports enabled: reject a story with an empty
reason and see it refused, then a real one; watch it go and the gap fill; reload and confirm it is
still gone and an unrelated story is not; edit then remove the preference in Sports Settings;
reload and confirm ordinary stories on that subject are eligible again; repeat one round trip from
Today. Desktop and narrow-width screenshots on the pull request. Never photograph the reason text.
Posted as a `gh pr comment` whose first line is exactly `LIVE-PATH PROOF`.

## Release note

Category Added. One plain sentence, no code names. Then
`node scripts/append-release-note.mjs --pr <number>` on this branch, and commit the
`docs/WHATS_NEW.md` change.
