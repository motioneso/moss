# Moss Extensions 1d: Trial Points, News Fencing and Live Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare the eight trial customization points, route every built-in through the point runner, keep a stored news page from outliving the customization it was built with, and prove the whole flow live with a real model.

**Architecture:** Each point wraps one pure function that plan 1c split out. The host calls that function through `callPoint`, then rebuilds its own result from its own copies of the data, so a customization can only choose among what it was given. Chat gets the three decision-model points through one optional port on the gate. News gets five points through one small seam object, so tests and old callers keep the plain built-in. Each news snapshot stores the customization revisions it was compiled under. Every read compares them with the current revisions and serves the built-in overview on a mismatch while a fresh compile runs. The compile re-checks before it publishes, and a revision event only saves work.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), `@sinclair/typebox`, Kysely and raw SQL on Postgres, pg-boss publish and subscribe, Vitest, Playwright for the live proof.

**Spec:** `docs/superpowers/specs/2026-10-11-moss-extensions-design.md`, sections 1.5, 1.8, 1.9, 2.4, 2.6, 5, Tests and Live proof. Shared names: `docs/superpowers/plans/2026-10-11-moss-extensions-interfaces.md`. File names from plan 1c (`2026-10-11-moss-extensions-1c-file-splits.md`, "Names and files fixed by this plan"). Machinery from plan 1b (`2026-10-11-moss-extensions-1b-points-storage-tools.md`, "Names this plan adds").

## Global Constraints

- Plain English rule (from Ben, applies to every human-readable thing you write, including PR bodies, PR comments and messages, and to any agent you hand work to): name things by what they do, keep exact names only where someone must act on them (a command, a file path, an error string). No colon-hinged sentences, no verbless fragments, no invented shorthand. Code, commit messages and comments stay precise and technical. Pass this rule on.
- Use the shared interfaces exactly. `defineExtensionPoint`, `callPoint`, `readPointRevisions`, `EXTENSION_REVISION_CHANGED_EVENT` and `createBuiltInHandle` come from `@moss/extensions` as written. Never edit the interfaces file.
- Plan 1b owns the extensions module, its tables, the registry, the runner, the bridge, the tools and the screens. This plan never edits files under `packages/extensions/` except the two lines Task 8 and Task 11 add to the locked list in `packages/extensions/src/points/open-files.ts`, and the generated files the build script rewrites.
- Module isolation. Chat and News use only the public exports of `@moss/extensions`. News never reads or writes an extensions table. The only cross-module wiring is in `packages/module-registry/src/extension-points.ts`.
- A customization never supplies a link, a title, a tool id, a risk, a source key's link or a story's text. Every host rebuilds its result from its own copies, by id or by position, and every output rule refuses ids it did not hand out.
- Never name a provider or model in code, tests or fixtures.
- Metadata-only job payloads. The revision event carries `actorUserId` and `pointIds` only.
- News logs carry counts and failure classes only (#2018). Never a headline, link, label, story reference or customization text.
- The decision-model quiet log is owner-only private data. Live proof output reports lengths, booleans and revision numbers, never the stored message text or wording.
- Never edit an applied migration. Chat SQL goes in `packages/chat/sql/`, news SQL in `packages/news/sql/`. This plan takes `0306` (chat) and `0307` (news). Run `pnpm check:migration-numbers` after adding each file; if main has taken a number, take the next free one and update the manifest list and the catalog entry to match.
- Tests. Unit tests run with `pnpm test:unit tests/unit/<file>`. Database tests run only through the gate script `test:extensions-db` that plan 1b created. Start it with `scripts/run-gate.sh start --gate test:extensions-db`, then wait with `scripts/run-gate.sh wait --follow` as one Bash call with `run_in_background: true`. Read the exit code (0 passed, 1 failed, 2 dead, 4 usage). Never pipe a gate command. Use the `verify-gate` skill before the first gate run. Never run `pnpm verify:foundation`, `pnpm test:integration` or any database test any other way.
- Security controls. Every hostile test names its control. To run a control, make only the change it names, run the one test, see it fail, then revert with `git checkout -- <file>` on that file alone and see it pass again. Record both runs in the PR body as exit codes.
- Build step. After any change to a file that declares a point, or to a file it imports from its own package, run `pnpm exec tsx scripts/build-extension-points.ts`, then `pnpm exec tsx scripts/check-extension-points.ts`, and commit the regenerated `packages/extensions/src/points/generated-points.json` and `packages/extensions/src/points/shape-record.json` in the same commit. If the check reports that a declaring file is not on the open list, stop and report it to the coordinator. Do not edit the open list.
- Static checks before every push: `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm check:package-deps`, `pnpm check:migration-numbers`, `pnpm typecheck`, `pnpm build:app-map`.
- Release note. Every PR fills in the template's "Release note" section. PRs 1 and 4 are user-facing. PRs 2 and 3 are `Category: N/A` because their points are not registered until PR 4, so nobody can customize them.
- App map. PR 1 updates the chat manifest's shadow-records feature text. PR 4 adds the news feature entry. PRs 2 and 3 change nothing a person can reach and say so in the PR body.
- Live-path gate. PRs 1 and 4 need live proof on moss-proof (port 5181, signed in to a real model), recorded on the PR as exit codes and text assertions. No screenshots, no intercepted or rewritten responses. Read `~/.config/moss-proof/README.md` for the address, container and database names. Never print, copy or commit `~/.config/moss-proof/account`; pass its values through environment variables only.
- This repository is public. No credentials, private hostnames, LAN addresses or personal data in code, fixtures, PR bodies or comments.
- Shared checkout. Stage only the files a task names (`git add <paths>`), never `git add -A` or `git add .`.
- Builders are Codex sessions. Reviewers are fresh sessions that see one task each, so every task below repeats the names it uses.

## Review Focus

1. A news ranking customization returns an id it was not given, a story twice, or a row carrying a new link and title. The published snapshot must contain only the host's own stories, each with its original link and title. Tests in Task 6.
2. A grouping customization returns a key that looks like a domain an attacker owns. The group's homepage link must still come from the first story's own source. Test in Task 10.
3. A stored snapshot built with a customization must never be served after a reset, a pause, or the owner turning customizations off, even when the revision event is late or never arrives. Tests in Task 15.
4. A compile that started before a reset must not publish its result when the reset commits before the compile's final check. Test in Task 15.
5. A suppressed story must never reach the ranking customization's input. Test in Task 6.
6. Two people with different customizations, compiled at the same moment, each get their own order. Test in Task 15.
7. A built-in whose model call never answers, and one whose reply body never finishes, both end at the built-in deadline, with and without a customization active. Tests in Tasks 6 and 15.
8. A reply wording customization must not fill in a value the tool did not return. Test in Task 2.
9. The featured-story rule and the page must share one copy of the eligibility check, and that copy must stay safe to load in the browser. Test in Task 11.

## Decisions

1. **Each point is declared in the file that holds its built-in function.** The build fingerprints the declaring file and its same-package imports, and shows Moss the function named by `exportName`. Declaring the point next to the function keeps both in one fingerprint.
2. **Chat reaches the points through one optional port.** `ClassifierGatePorts.wording` carries `question`, `descriptions` is applied inside the wiring's `listTools`, and `reply` sits beside `question`. When the port is absent the gate calls the pure built-ins directly, so every existing gate test keeps working unchanged.
3. **News reaches the points through one seam object, `NewsExtensions`.** It has `run` and `revisions`. The compile, the collector and the service take it as an optional dependency that defaults to `BUILT_IN_NEWS_EXTENSIONS`, which runs the built-in under its deadline and reports all-zero revisions. Production wiring passes `liveNewsExtensions`. Existing test call sites need no change.
4. **A failure in the extensions machinery never takes a news page down.** `liveNewsExtensions.run` wraps `callPoint` in a savepoint. If it throws before the built-in started, the built-in runs directly under its deadline. If it throws after the built-in started, the built-in's own result stands. A built-in that succeeded keeps its answer, and one that failed or missed its deadline sends its error to the caller's ordinary built-in failure path. The built-in is never started a second time.
5. **The compiled ranking path's built-in is the ranking model call, with a deadline.** The pure `rankStories` function in `rank.ts` shows the order a customization gets on the live path and the compiled path's no-model fallback order. A customization that wants the model's order calls `builtIn()`. If the model call fails or misses its deadline, the host falls back to today's no-model order and logs `news_compile_ai_fallback` exactly as before. Any other error from the ranking call also falls back to that order, logged as `aborted`, where today an outright throw keeps the last good page.
6. **The ranking input holds at most 300 stories, chosen as today's prompt chooses them.** The compiled path sorts by publish time, newest first, then id, and keeps 300. Today's model call already drops every story it does not rank, and its prompt fills from the same order, so the cap changes nothing.
7. **The live path ranks top stories only.** The point reorders the combined top-stories list. Each source group's own headline order keeps the built-in weights, because one point call per group would multiply the cost for no visible gain.
8. **Only the three compile points are fenced.** A snapshot stores revisions for `news.chooseSources`, `news.filterStories` and `news.rankStories`, plus the instance switch. Grouping and the featured story run on every read, so a reset takes effect on the next read without any fence.
9. **A snapshot written before this plan reads as built with no customization.** `NULL` in the new column means all-zero revisions. A stored value that does not parse is never served.
10. **The read check fails closed.** If the revision read throws, the snapshot is not served, the built-in overview is served, and a fresh compile is requested.
11. **The overview and the morning briefing are fenced.** The personalization status route, the image route and the chat approval preview read the snapshot for status, pictures and confirmation only, never to show an order, so they stay as they are.
12. **The compile checks its generation before ranking and its revisions before publishing.** A bumped generation returns `"stale"` before the slow model call. Changed revisions return `"stale"` before the publish. The worker loop already recompiles on `"stale"`.
13. **The revision event bumps the generation and enqueues a refresh.** News subscribes its own queue, `news.extension-revisions`, to `EXTENSION_REVISION_CHANGED_EVENT`. The worker ignores events with no fenced point id. The bump makes a running compile stop early, and the enqueue is coalesced per person, so the next read finds a fresh page sooner. Nothing depends on the event for correctness.
14. **`pointIds` is already in the job payload allowlist.** Plan 1b adds it, because the event payload reaches News's worker as a job and `assertMetadataOnlyPayload` rejects unknown keys. Task 14 checks it with a control and never adds it a second time.
15. **The featured rule shares the page's eligibility check from a new locked, browser-safe file.** `featureEligible` and `RankableHeadline` move to `packages/news/src/feature-eligibility.ts`. `ranking.ts` re-exports them, so the server code is unchanged, and the page imports the new file, so `ranking.ts` may import `@moss/extensions` without reaching the browser bundle.
16. **The filter point never sees a link.** The eligibility checks (approved domain, exclusions, safe link, publish time) move to the new locked file `packages/news/src/compilation/story-eligibility.ts` and always run on the host. The point decides only age and duplicates, and identifies a story's link by a 16-character hash.
17. **Grouping keys are checked and links never come from them.** A customization's group key must match `/^[A-Za-z0-9._:-]{1,64}$/` and be unique. The host uses the key as the group's identifier only. The homepage link always comes from the first story's own configured source or its own domain.
18. **The quiet log records the area question's wording and the revision used.** Two nullable columns on `app.chat_classifier_shadow_records`, so the live proof can show a wording change without reading any other table.
19. **Limits.** Decision-model points get 5 ms of guest time, 50 ms elapsed and a 2 second built-in deadline. News points get 250 ms of guest time, 2 seconds elapsed and a 60 second built-in deadline.
20. **Compilation never reads from Moss.** `moss.get` refuses every request in background jobs and in the worker, and News compiles in the worker. The sources, filter and compile-time ranking calls keep `apiAccess: "news_read"`, but no test or live step relies on a read inside them. Grouping, the featured story and live ranking run on the API server, where reads work.

## Names this plan adds

```ts
// packages/chat/src/live/classifier-gate.ts
export interface DecisionQuestionInput {
  readonly kind: "area" | "tool" | "argument" | "extraction";
  readonly subject: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
}
export interface DecisionQuestionOutput {
  readonly instructions: string;
  readonly criteria: readonly { readonly id: string; readonly text: string }[];
}
export function wordDecisionQuestion(input: DecisionQuestionInput): DecisionQuestionOutput;
export const chatDecisionQuestionWordingPoint: ExtensionPoint<
  DecisionQuestionInput,
  DecisionQuestionOutput
>;
// ClassifierGatePorts gains: readonly wording?: GateWordingPort
export interface GateWordingPort {
  question(
    input: DecisionQuestionInput,
    signal: AbortSignal
  ): Promise<PointCallResult<DecisionQuestionOutput>>;
  reply(
    input: DecisionReplyInput,
    signal: AbortSignal
  ): Promise<PointCallResult<DecisionReplyOutput>>;
}
// GateTrace gains: readonly areaQuestionInstructions?: string; readonly wordingRevision?: number

// packages/chat/src/live/classifier-gate-arguments.ts
export interface ReplyTemplateValue {
  readonly placeholder: string;
  readonly value: string | null;
}
export function replyTemplateValues(template: string, result: unknown): ReplyTemplateValue[];
export function renderReplyFromValues(
  template: string,
  values: readonly ReplyTemplateValue[]
): string | null;
export interface DecisionReplyInput {
  readonly toolName: string;
  readonly template: string;
  readonly values: readonly ReplyTemplateValue[];
}
export interface DecisionReplyOutput {
  readonly reply: string | null;
}
export function wordDecisionReply(input: DecisionReplyInput): DecisionReplyOutput;
export const chatDecisionReplyWordingPoint: ExtensionPoint<DecisionReplyInput, DecisionReplyOutput>;

// packages/chat/src/live/classifier-gate-wiring.ts
export const chatDecisionDescriptionsPoint: ExtensionPoint<GateDescriptions, GateDescriptions>;

// packages/chat/src/live/extension-point-entries.ts
export const CHAT_EXTENSION_POINT_ENTRIES: readonly RegisteredPointEntry[];

// packages/news/src/extension-calls.ts
export interface NewsExtensions {
  run<I, O>(
    point: ExtensionPoint<I, O>,
    input: I,
    builtIn: (input: I, signal: AbortSignal) => Promise<O>
  ): Promise<O>;
  revisions(): Promise<NewsStoredRevisions>;
}
export type NewsExtensionsFactory = (
  scopedDb: DataContextDb,
  ctx: { actorUserId: string; requestId: string; inBackgroundJob: boolean; signal?: AbortSignal }
) => NewsExtensions;
export const liveNewsExtensions: NewsExtensionsFactory;
export const BUILT_IN_NEWS_EXTENSIONS: NewsExtensions;
export function builtInNewsExtensions(deadlineOverrideMs?: number): NewsExtensions; // tests only pass the override

// packages/news/src/extension-fence.ts
export const NEWS_FENCED_POINT_IDS: readonly [
  "news.chooseSources",
  "news.filterStories",
  "news.rankStories"
];
export interface NewsStoredRevisions {
  readonly instance: number;
  readonly points: Readonly<Record<string, number>>;
}
export const NO_CUSTOMIZATION_REVISIONS: NewsStoredRevisions;
export function sameRevisions(left: NewsStoredRevisions, right: NewsStoredRevisions): boolean;
export function parseStoredRevisions(raw: unknown): NewsStoredRevisions | "invalid";
export async function snapshotServable(
  snapshot: NewsSnapshotRecord | null,
  extensions: NewsExtensions
): Promise<boolean>;

// packages/news/src/compilation/rank.ts
export interface NewsRankStory {
  /* see Task 6 */
}
export interface NewsRankInput {
  readonly path: "live" | "compiled";
  readonly topics: readonly string[];
  readonly stories: readonly NewsRankStory[];
}
export interface NewsRankOutput {
  readonly order: readonly { readonly id: string; readonly score?: number }[];
}
export function rankStories(input: NewsRankInput): NewsRankOutput;
export class NewsRankingUnavailable extends Error {
  readonly reason: RankingFailure;
}
export const newsRankStoriesPoint: ExtensionPoint<NewsRankInput, NewsRankOutput>;

// packages/news/src/compilation/source-choice.ts
export const newsChooseSourcesPoint: ExtensionPoint<NewsSourceOptions, NewsSourceChoice>;

// packages/news/src/compilation/story-eligibility.ts (locked)
export function safeCanonicalUrl(raw: string): string | null;
export function eligibleCandidates(
  candidates: readonly NewsCandidate[],
  input: { exclusions: readonly string[]; approvedDomains: ReadonlySet<string>; now: Date }
): NewsCandidate[];

// packages/news/src/compilation/filters.ts
export interface NewsFilterStory {
  /* see Task 8 */
}
export interface NewsFilterInput {
  readonly now: string;
  readonly stories: readonly NewsFilterStory[];
}
export interface NewsFilterOutput {
  readonly keepIds: readonly string[];
}
export function filterStories(input: NewsFilterInput): NewsFilterOutput;
export const newsFilterStoriesPoint: ExtensionPoint<NewsFilterInput, NewsFilterOutput>;
export async function applyStoryFilters(
  extensions: NewsExtensions,
  candidates: NewsCandidate[],
  input: { exclusions: string[]; approvedDomains: Set<string>; now: Date }
): Promise<NewsCandidate[]>;

// packages/news/src/grouping.ts
// GroupableStory gains: readonly headline: string; readonly topics: readonly string[]
export const newsGroupStoriesPoint: ExtensionPoint<
  readonly GroupableStory[],
  readonly StoryGroup[]
>;

// packages/news/src/feature-eligibility.ts (locked, browser-safe)
export interface RankableHeadline {
  readonly imageUrl: string | null;
  readonly publishedAt: string | null;
  readonly summary: string;
}
export function featureEligible(item: RankableHeadline): boolean;

// packages/news/src/ranking.ts
export const newsFeaturedStoryPoint: ExtensionPoint<readonly FeaturableStory[], string | null>;

// packages/news/src/extension-point-entries.ts
export const NEWS_EXTENSION_POINT_ENTRIES: readonly RegisteredPointEntry[];

// packages/news/src/jobs.ts
export const NEWS_EXTENSION_REVISIONS_QUEUE = "news.extension-revisions";

// packages/news/src/personalization-repository.ts
// NewsSnapshotRecord gains: readonly extensionRevisions?: unknown
// ReplaceSnapshotInput gains: readonly extensionRevisions?: NewsStoredRevisions
// NewsPersonalizationRepository gains: readRequestedGeneration(scopedDb): Promise<number>
```

## File Map

| File                                                                        | Change                                                        | Task                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `packages/chat/package.json`, `packages/news/package.json`                  | Add `@moss/extensions` and `@sinclair/typebox`                | 1, 5                         |
| `packages/chat/src/live/classifier-gate.ts`                                 | Question wording point, wording port, trace fields            | 1, 3                         |
| `packages/chat/src/live/classifier-gate-arguments.ts`                       | Reply split and reply wording point                           | 2                            |
| `packages/chat/src/live/classifier-gate-wiring.ts`                          | Descriptions point, wording port wiring                       | 2, 3                         |
| `packages/chat/src/live/classifier-gate-shadow.ts`                          | Pass the wording port, record the two new fields              | 3                            |
| `packages/chat/src/classifier-shadow-repository.ts`                         | Store the two new fields                                      | 3                            |
| `packages/chat/sql/0306_chat_classifier_shadow_wording.sql`                 | Create. Two nullable columns                                  | 3                            |
| `packages/chat/src/manifest.ts`                                             | Migration list, feature text                                  | 3                            |
| `packages/chat/src/live/extension-point-entries.ts`                         | Create. Chat registry entries                                 | 4                            |
| `packages/chat/src/index.ts`                                                | Export the entries                                            | 4                            |
| `packages/module-registry/src/extension-points.ts`                          | Fill `BUILT_IN_EXTENSION_POINTS`                              | 4, 15                        |
| `packages/db/src/types.ts`                                                  | New columns                                                   | 3, 12                        |
| `tests/integration/foundation-schema-catalog.test.ts`                       | Two catalog entries                                           | 3, 12                        |
| `packages/news/src/extension-calls.ts`                                      | Create. News seam                                             | 5                            |
| `packages/news/src/extension-fence.ts`                                      | Create. Stored revisions and the read check                   | 5, 12                        |
| `packages/news/src/compilation/rank.ts`                                     | Ranking point and pure built-in                               | 6                            |
| `packages/news/src/compilation/compile.ts`                                  | Route ranking and filters through the seam; fence the compile | 6, 8, 13                     |
| `packages/news/src/compilation/source-choice.ts`                            | Sources point                                                 | 7                            |
| `packages/news/src/compilation/candidates.ts`                               | Call the sources point                                        | 7                            |
| `packages/news/src/compilation/story-eligibility.ts`                        | Create (locked). Eligibility checks moved out of filters      | 8                            |
| `packages/news/src/compilation/filters.ts`                                  | Filter point and pure built-in                                | 8                            |
| `packages/news/src/news-service.ts`                                         | Seam dependency, live ranking, grouping, featured, read fence | 9, 10, 11, 12                |
| `packages/news/src/grouping.ts`                                             | Grouping point                                                | 10                           |
| `packages/news/src/feature-eligibility.ts`                                  | Create (locked, browser-safe)                                 | 11                           |
| `packages/news/src/ranking.ts`                                              | Featured point; re-export eligibility                         | 11                           |
| `packages/news/src/web/news-mosaic.tsx`                                     | Import eligibility from the new file                          | 11                           |
| `packages/news/src/routes.ts`, `packages/news/src/briefing-tool.ts`         | Pass `liveNewsExtensions`                                     | 9, 12                        |
| `packages/news/sql/0307_news_snapshot_extension_revisions.sql`              | Create. One nullable column                                   | 12                           |
| `packages/news/src/personalization-repository.ts`                           | Store and read revisions; read the generation                 | 12, 13                       |
| `packages/news/src/jobs.ts`                                                 | Pass the seam to the compile; revision event queue and worker | 13, 14                       |
| `packages/jobs/src/pg-boss.ts`                                              | Queue subscription option (`subscribesTo`)                    | 14                           |
| `packages/news/src/extension-point-entries.ts`                              | Create. News registry entries                                 | 15                           |
| `packages/news/src/index.ts`, `packages/news/src/manifest.ts`               | Export entries; migration list; feature entry                 | 12, 15                       |
| `packages/extensions/src/points/open-files.ts`                              | Add the two new locked files                                  | 8, 11                        |
| `packages/extensions/src/points/generated-points.json`, `shape-record.json` | Regenerated by the build script                               | 1, 2, 4, 6, 7, 8, 10, 11, 15 |
| `tests/unit/chat-extension-points.test.ts`                                  | Create                                                        | 1, 2, 3                      |
| `tests/unit/chat-gate-wording.test.ts`                                      | Create                                                        | 3                            |
| `tests/unit/chat-classifier-shadow-runner.test.ts`                          | One harness option, one test                                  | 3                            |
| `tests/unit/news-extension-points.test.ts`                                  | Create                                                        | 5-11                         |
| `tests/unit/news-extension-fence.test.ts`                                   | Create                                                        | 12, 13                       |
| `tests/integration/news-extension-points.test.ts`                           | Create; appended to `test:extensions-db`                      | 15                           |
| `tests/integration/chat-extension-points.test.ts`                           | Create; appended to `test:extensions-db`                      | 4                            |
| `tests/live/extensions-1d-decision-wording.spec.ts`                         | Create. Live steps 4 and 5 for chat                           | 4                            |
| `tests/live/extensions-1d-trial-points.spec.ts`                             | Create. Live steps 1, 2, 3 and 5 for news                     | 16                           |

## Pull requests

| PR  | Tasks              | Scope                                                       | Depends on                                                      | Release note  |
| --- | ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| 1   | 1, 2, 3, 4         | Decision-model points, quiet log columns, chat registration | 1b PR 3 (runner); 1b PRs 5, 6 and 7 for the live proof; 1c PR A | user-facing   |
| 2   | 5, 6, 7, 8         | News compile points (sources, filters, ranking)             | 1b PR 3; 1c PRs B and C                                         | Category: N/A |
| 3   | 9, 10, 11          | News read points (live ranking, grouping, featured)         | 1b PRs 3 and 4; 1c PR D; this plan's PR 2                       | Category: N/A |
| 4   | 12, 13, 14, 15, 16 | Fencing, revision event, news registration, live proof      | this plan's PRs 2 and 3; 1b PRs 3 to 7                          | user-facing   |

PR 1 can be built in parallel with PR 2. PR 3 starts after PR 2 merges, because both edit `compile.ts` imports and the news test file. Each PR starts from current `origin/main` after its dependencies merge. Each PR is one builder session.

---

## PR 1: Decision-model points

Branch: `feat/extensions-1d-decision-points`. Starts from `origin/main` after 1b PR 3 and 1c PR A have merged.

### Task 1: Question wording point

**Files:**

- Modify: `packages/chat/package.json` (dependencies)
- Modify: `packages/chat/src/live/classifier-gate.ts` (imports; new code directly below `buildExtractionInstructions`)
- Test: `tests/unit/chat-extension-points.test.ts` (new)

**Interfaces:**

- Consumes, from plan 1c in `classifier-gate.ts`: `buildAreaQuestion(areas: readonly { id: string; description: string }[])`, `buildToolQuestion(tools: readonly { name: string; description: string }[])`, `buildArgumentQuestion(argumentName: string, options: readonly { id: string; label: string }[])`, each returning `ClassifierChoiceQuestion { instructions: string; criteria: Readonly<Record<string, string>> }`, and `buildExtractionInstructions(toolDescription: string): string`.
- Consumes, from `@moss/extensions`: `defineExtensionPoint`, `type ExtensionPoint`, `type PointCallResult`.
- Produces, in `classifier-gate.ts`: `DecisionQuestionInput`, `DecisionQuestionOutput`, `wordDecisionQuestion`, `questionFromWording`, `chatDecisionQuestionWordingPoint` (id `chat.decisionQuestionWording`).

The built-in dispatches to the four builders, so its wording is exactly today's. The output rule keeps the choice ids fixed, because the locked checks compare the classifier's answer against those ids.

- [ ] **Step 1: Add the dependency**

In `packages/chat/package.json`, add to `dependencies`, keeping the list sorted:

```json
    "@moss/extensions": "workspace:*",
    "@sinclair/typebox": "^0.34.13",
```

Chat does not depend on TypeBox today, and the point schemas need it. Use the version the other packages pin.

Run: `pnpm install --offline`
Expected: exit 0. Then run `pnpm check:package-deps`, expected exit 0.

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/chat-extension-points.test.ts`:

```ts
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  buildArgumentQuestion,
  buildAreaQuestion,
  buildExtractionInstructions,
  buildToolQuestion,
  chatDecisionQuestionWordingPoint,
  questionFromWording,
  wordDecisionQuestion,
  type DecisionQuestionInput
} from "../../packages/chat/src/live/classifier-gate.js";

const def = chatDecisionQuestionWordingPoint.def;

const areaInput: DecisionQuestionInput = {
  kind: "area",
  subject: "",
  options: [
    { id: "calendar", text: "Calendar events" },
    { id: "tasks", text: "Task lists" }
  ]
};

describe("chat.decisionQuestionWording", () => {
  it("declares its id, limits and access", () => {
    expect(def.id).toBe("chat.decisionQuestionWording");
    expect(def.ownerModule).toBe("chat");
    expect(def.exportName).toBe("wordDecisionQuestion");
    expect(def.apiAccess).toBe("none");
    expect(def.limits).toEqual({ guestTimeMs: 5, elapsedMs: 50 });
    expect(def.builtInDeadlineMs).toBe(2_000);
    expect(Value.Check(def.inputSchema, def.sampleInput)).toBe(true);
  });

  it("words every kind exactly as the builders do", () => {
    const area = wordDecisionQuestion(areaInput);
    expect(questionFromWording(area)).toEqual(
      buildAreaQuestion([
        { id: "calendar", description: "Calendar events" },
        { id: "tasks", description: "Task lists" }
      ])
    );
    const tool = wordDecisionQuestion({
      kind: "tool",
      subject: "",
      options: [{ id: "calendar.listVisibleEvents", text: "List events" }]
    });
    expect(questionFromWording(tool)).toEqual(
      buildToolQuestion([{ name: "calendar.listVisibleEvents", description: "List events" }])
    );
    const argument = wordDecisionQuestion({
      kind: "argument",
      subject: "list",
      options: [{ id: "__proto__", text: "Groceries" }]
    });
    const built = buildArgumentQuestion("list", [{ id: "__proto__", label: "Groceries" }]);
    const rebuilt = questionFromWording(argument);
    expect(rebuilt).toEqual(built);
    expect(Object.getPrototypeOf(rebuilt.criteria)).toBe(Object.prototype);
    expect(Object.hasOwn(rebuilt.criteria, "__proto__")).toBe(true);
    expect(
      wordDecisionQuestion({ kind: "extraction", subject: "Adds a task", options: [] })
    ).toEqual({ instructions: buildExtractionInstructions("Adds a task"), criteria: [] });
  });

  it("accepts the built-in's own answer and a shorter rewording", () => {
    const builtIn = wordDecisionQuestion(areaInput);
    expect(def.outputRule(areaInput, builtIn)).toEqual({ ok: true });
    expect(Value.Check(def.outputSchema, builtIn)).toBe(true);
    expect(
      def.outputRule(areaInput, {
        ...builtIn,
        instructions: "Which area fits? Pick none if unsure."
      })
    ).toEqual({ ok: true });
  });

  // Hostile. Control: in chatDecisionQuestionWordingPoint's outputRule, delete the
  // "same choice ids" loop. This test turns red.
  it("refuses a rewording that adds, drops or repeats a choice id", () => {
    const builtIn = wordDecisionQuestion(areaInput);
    const dropped = { ...builtIn, criteria: builtIn.criteria.slice(1) };
    const added = { ...builtIn, criteria: [...builtIn.criteria, { id: "admin", text: "Admin" }] };
    const repeated = {
      ...builtIn,
      criteria: [...builtIn.criteria.slice(1), builtIn.criteria[1]!]
    };
    for (const output of [dropped, added, repeated]) {
      expect(def.outputRule(areaInput, output)).toEqual({ ok: false, schemaPath: "/criteria" });
    }
  });

  // Hostile. Control: in the outputRule, change both length limits to Infinity. Red.
  it("refuses instructions or criteria longer than the cap", () => {
    const builtIn = wordDecisionQuestion(areaInput);
    expect(def.outputRule(areaInput, { ...builtIn, instructions: "x".repeat(401) })).toEqual({
      ok: false,
      schemaPath: "/instructions"
    });
    const long = builtIn.criteria.map((entry, index) =>
      index === 0 ? { ...entry, text: "x".repeat(401) } : entry
    );
    expect(def.outputRule(areaInput, { ...builtIn, criteria: long })).toEqual({
      ok: false,
      schemaPath: "/criteria/0/text"
    });
  });

  it("refuses any criteria for an extraction question", () => {
    const input: DecisionQuestionInput = {
      kind: "extraction",
      subject: "Adds a task",
      options: []
    };
    expect(
      def.outputRule(input, { instructions: "Extract", criteria: [{ id: "x", text: "y" }] })
    ).toEqual({ ok: false, schemaPath: "/criteria" });
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts`
Expected: FAIL with a missing export error for `chatDecisionQuestionWordingPoint`.

- [ ] **Step 4: Add the point**

In `packages/chat/src/live/classifier-gate.ts`, add to the imports:

```ts
import { Type } from "@sinclair/typebox";
import { defineExtensionPoint, type PointCallResult } from "@moss/extensions";
```

Add directly below `buildExtractionInstructions`:

```ts
/** What a question wording customization receives. Ids are the choices the checks accept. */
export interface DecisionQuestionInput {
  readonly kind: "area" | "tool" | "argument" | "extraction";
  /** The argument name for `argument`, the tool description for `extraction`, else "". */
  readonly subject: string;
  readonly options: readonly { readonly id: string; readonly text: string }[];
}

export interface DecisionQuestionOutput {
  readonly instructions: string;
  readonly criteria: readonly { readonly id: string; readonly text: string }[];
}

/** The built-in question wording. Dispatches to today's builders. */
export function wordDecisionQuestion(input: DecisionQuestionInput): DecisionQuestionOutput {
  let question: ClassifierChoiceQuestion;
  switch (input.kind) {
    case "area":
      question = buildAreaQuestion(
        input.options.map((option) => ({ id: option.id, description: option.text }))
      );
      break;
    case "tool":
      question = buildToolQuestion(
        input.options.map((option) => ({ name: option.id, description: option.text }))
      );
      break;
    case "argument":
      question = buildArgumentQuestion(
        input.subject,
        input.options.map((option) => ({ id: option.id, label: option.text }))
      );
      break;
    case "extraction":
      return { instructions: buildExtractionInstructions(input.subject), criteria: [] };
  }
  return {
    instructions: question.instructions,
    criteria: Object.entries(question.criteria).map(([id, text]) => ({ id, text }))
  };
}

/** Rebuilds the classifier question. `fromEntries` keeps an id such as `__proto__` an own key. */
export function questionFromWording(output: DecisionQuestionOutput): ClassifierChoiceQuestion {
  return {
    instructions: output.instructions,
    criteria: Object.fromEntries(output.criteria.map((entry) => [entry.id, entry.text]))
  };
}

const QUESTION_TEXT_CAP = 400;

const decisionQuestionInputSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("area"),
      Type.Literal("tool"),
      Type.Literal("argument"),
      Type.Literal("extraction")
    ]),
    subject: Type.String({ maxLength: 2_000 }),
    options: Type.Array(
      Type.Object(
        { id: Type.String({ maxLength: 200 }), text: Type.String({ maxLength: 2_000 }) },
        { additionalProperties: false }
      ),
      { maxItems: 200 }
    )
  },
  { additionalProperties: false }
);

const decisionQuestionOutputSchema = Type.Object(
  {
    instructions: Type.String({ minLength: 1, maxLength: 4_000 }),
    criteria: Type.Array(
      Type.Object(
        {
          id: Type.String({ maxLength: 200 }),
          text: Type.String({ minLength: 1, maxLength: 4_000 })
        },
        { additionalProperties: false }
      ),
      { maxItems: 202 }
    )
  },
  { additionalProperties: false }
);

export const chatDecisionQuestionWordingPoint = defineExtensionPoint<
  DecisionQuestionInput,
  DecisionQuestionOutput
>({
  id: "chat.decisionQuestionWording",
  ownerModule: "chat",
  exportName: "wordDecisionQuestion",
  inputSchema: decisionQuestionInputSchema,
  outputSchema: decisionQuestionOutputSchema,
  shapeVersion: 1,
  limits: { guestTimeMs: 5, elapsedMs: 50 },
  builtInDeadlineMs: 2_000,
  sampleInput: {
    kind: "area",
    subject: "",
    options: [
      { id: "calendar", text: "Calendar events and reminders" },
      { id: "tasks", text: "Task lists and to-dos" }
    ]
  },
  apiAccess: "none",
  outputRule: (input, output) => {
    const builtIn = wordDecisionQuestion(input);
    if (output.instructions.length > Math.max(QUESTION_TEXT_CAP, builtIn.instructions.length)) {
      return { ok: false, schemaPath: "/instructions" };
    }
    const expected = new Map(builtIn.criteria.map((entry) => [entry.id, entry.text]));
    const seen = new Set<string>();
    for (const entry of output.criteria) {
      if (!expected.has(entry.id) || seen.has(entry.id))
        return { ok: false, schemaPath: "/criteria" };
      seen.add(entry.id);
    }
    if (seen.size !== expected.size) return { ok: false, schemaPath: "/criteria" };
    for (const [index, entry] of output.criteria.entries()) {
      const cap = Math.max(QUESTION_TEXT_CAP, expected.get(entry.id)!.length);
      if (entry.text.length > cap) return { ok: false, schemaPath: `/criteria/${index}/text` };
    }
    return { ok: true };
  }
});
```

`PointCallResult` is used by Task 3. If lint flags it as unused in this commit, add the import in Task 3 instead.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts tests/unit/chat-classifier-gate.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the two controls**

Make each control change named in the test comments, run the file, see the named test fail, revert with `git checkout -- packages/chat/src/live/classifier-gate.ts`, run again, see it pass. Note both exit codes for the PR body.

- [ ] **Step 7: Build the point records and commit**

Run: `pnpm exec tsx scripts/build-extension-points.ts && pnpm exec tsx scripts/check-extension-points.ts`
Expected: exit 0, and `generated-points.json` gains `chat.decisionQuestionWording`.

```bash
git add packages/chat/package.json pnpm-lock.yaml packages/chat/src/live/classifier-gate.ts \
  tests/unit/chat-extension-points.test.ts \
  packages/extensions/src/points/generated-points.json packages/extensions/src/points/shape-record.json
git commit -m "feat(chat): declare the decision question wording point (spec 5)"
```

### Task 2: Descriptions and reply wording points

**Files:**

- Modify: `packages/chat/src/live/classifier-gate-arguments.ts` (`renderReplyTemplate` at the end of the file)
- Modify: `packages/chat/src/live/classifier-gate-wiring.ts` (imports; new point below `buildGateDescriptions`)
- Test: `tests/unit/chat-extension-points.test.ts` (append two `describe` blocks)

**Interfaces:**

- Consumes, from plan 1c in `classifier-gate-wiring.ts`: `GateDescriptions { areas: readonly { moduleId: string; description: string }[]; tools: readonly { moduleId: string; name: string; description: string }[] }`, `buildGateDescriptions(input: GateDescriptions): GateDescriptions`.
- Consumes, in `classifier-gate-arguments.ts`: the private `valueAt(result, path)` and `renderReplyTemplate(template, result): string | null` (unchanged behaviour).
- Produces: `ReplyTemplateValue`, `replyTemplateValues`, `renderReplyFromValues`, `DecisionReplyInput`, `DecisionReplyOutput`, `wordDecisionReply`, `chatDecisionReplyWordingPoint` (id `chat.decisionReplyWording`), and `chatDecisionDescriptionsPoint` (id `chat.decisionDescriptions`).

Integration tools reach this point already described, because `packages/integrations/src/classifier-readable-name.ts` builds each tool's description into its manifest before the wiring reads it. No point crosses into the integrations package.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/chat-extension-points.test.ts`, and add these imports at the top:

```ts
import {
  chatDecisionReplyWordingPoint,
  renderReplyFromValues,
  renderReplyTemplate,
  replyTemplateValues,
  wordDecisionReply,
  type DecisionReplyInput
} from "../../packages/chat/src/live/classifier-gate-arguments.js";
import {
  buildGateDescriptions,
  chatDecisionDescriptionsPoint,
  type GateDescriptions
} from "../../packages/chat/src/live/classifier-gate-wiring.js";
```

```ts
describe("chat.decisionReplyWording", () => {
  const replyDef = chatDecisionReplyWordingPoint.def;

  it("keeps renderReplyTemplate exactly as before", () => {
    const result = { task: { title: "Milk", done: false }, count: 2 };
    expect(renderReplyTemplate("Added {task.title} ({count}, done {task.done})", result)).toBe(
      "Added Milk (2, done false)"
    );
    expect(renderReplyTemplate("Added {task.missing}", result)).toBeNull();
    expect(renderReplyTemplate("No placeholders", result)).toBe("No placeholders");
    expect(renderReplyTemplate("{count}", { count: Number.NaN })).toBeNull();
  });

  it("splits into values and rendering with the same result", () => {
    const values = replyTemplateValues("Added {task.title}", { task: { title: "Milk" } });
    expect(values).toEqual([{ placeholder: "task.title", value: "Milk" }]);
    expect(renderReplyFromValues("Added {task.title}", values)).toBe("Added Milk");
    expect(replyTemplateValues("Added {x}", {})).toEqual([{ placeholder: "x", value: null }]);
  });

  it("declares its id, limits and access", () => {
    expect(replyDef.id).toBe("chat.decisionReplyWording");
    expect(replyDef.exportName).toBe("wordDecisionReply");
    expect(replyDef.apiAccess).toBe("none");
    expect(replyDef.limits).toEqual({ guestTimeMs: 5, elapsedMs: 50 });
    expect(replyDef.builtInDeadlineMs).toBe(2_000);
    expect(
      replyDef.outputRule(replyDef.sampleInput, wordDecisionReply(replyDef.sampleInput))
    ).toEqual({ ok: true });
  });

  // Hostile. Control: in chatDecisionReplyWordingPoint's outputRule, delete the
  // "missing value means no reply" branch. This test turns red.
  it("refuses a reply that fills in a value the tool did not return", () => {
    const input: DecisionReplyInput = {
      toolName: "tasks.addTask",
      template: "Added {task.title}",
      values: [{ placeholder: "task.title", value: null }]
    };
    expect(wordDecisionReply(input)).toEqual({ reply: null });
    expect(replyDef.outputRule(input, { reply: "Added Milk" })).toEqual({
      ok: false,
      schemaPath: "/reply"
    });
    expect(replyDef.outputRule(input, { reply: null })).toEqual({ ok: true });
  });

  it("refuses no reply when every value is present, and an overlong reply", () => {
    const input: DecisionReplyInput = {
      toolName: "tasks.addTask",
      template: "Added {task.title}",
      values: [{ placeholder: "task.title", value: "Milk" }]
    };
    expect(replyDef.outputRule(input, { reply: null })).toEqual({
      ok: false,
      schemaPath: "/reply"
    });
    expect(replyDef.outputRule(input, { reply: "x".repeat(1_001) })).toEqual({
      ok: false,
      schemaPath: "/reply"
    });
    expect(replyDef.outputRule(input, { reply: "Done. Milk is on the list." })).toEqual({
      ok: true
    });
  });
});

describe("chat.decisionDescriptions", () => {
  const descDef = chatDecisionDescriptionsPoint.def;
  const input: GateDescriptions = {
    areas: [{ moduleId: "tasks", description: "Tasks" }],
    tools: [{ moduleId: "tasks", name: "tasks.addTask", description: "Adds a task" }]
  };

  it("declares its id and accepts the built-in", () => {
    expect(descDef.id).toBe("chat.decisionDescriptions");
    expect(descDef.exportName).toBe("buildGateDescriptions");
    expect(descDef.apiAccess).toBe("none");
    expect(descDef.outputRule(input, buildGateDescriptions(input))).toEqual({ ok: true });
  });

  // Hostile. Control: in the outputRule, delete the moduleId and name comparison. Red.
  it("refuses a description set that moves, renames or reassigns a tool", () => {
    const renamed = {
      ...input,
      tools: [{ moduleId: "tasks", name: "admin.deleteAll", description: "Adds a task" }]
    };
    const moved = {
      ...input,
      areas: [{ moduleId: "admin", description: "Tasks" }]
    };
    const extra = { ...input, tools: [...input.tools, input.tools[0]!] };
    expect(descDef.outputRule(input, renamed)).toEqual({ ok: false, schemaPath: "/tools/0" });
    expect(descDef.outputRule(input, moved)).toEqual({ ok: false, schemaPath: "/areas/0" });
    expect(descDef.outputRule(input, extra)).toEqual({ ok: false, schemaPath: "/tools" });
  });

  it("refuses an empty or overlong description", () => {
    const empty = { ...input, tools: [{ ...input.tools[0]!, description: "" }] };
    const long = { ...input, areas: [{ moduleId: "tasks", description: "x".repeat(301) }] };
    expect(descDef.outputRule(input, empty)).toEqual({
      ok: false,
      schemaPath: "/tools/0/description"
    });
    expect(descDef.outputRule(input, long)).toEqual({
      ok: false,
      schemaPath: "/areas/0/description"
    });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts`
Expected: FAIL with missing exports for `replyTemplateValues` and `chatDecisionDescriptionsPoint`.

- [ ] **Step 3: Split the reply template and add the reply point**

In `packages/chat/src/live/classifier-gate-arguments.ts`, add to the imports:

```ts
import { Type } from "@sinclair/typebox";
import { defineExtensionPoint } from "@moss/extensions";
```

Replace `renderReplyTemplate` with:

```ts
const REPLY_PLACEHOLDER = /\{([^{}]*)\}/g;

/** One placeholder in a reply template and the tool result's value for it, or null if missing. */
export interface ReplyTemplateValue {
  readonly placeholder: string;
  readonly value: string | null;
}

export function replyTemplateValues(template: string, result: unknown): ReplyTemplateValue[] {
  return [...template.matchAll(REPLY_PLACEHOLDER)].map(([, path = ""]) => {
    const value = valueAt(result, path);
    if (typeof value === "string" || typeof value === "boolean") {
      return { placeholder: path, value: String(value) };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return { placeholder: path, value: String(value) };
    }
    return { placeholder: path, value: null };
  });
}

/** Fills each placeholder in order. Any missing value means no reply. */
export function renderReplyFromValues(
  template: string,
  values: readonly ReplyTemplateValue[]
): string | null {
  if (values.some((entry) => entry.value === null)) return null;
  let index = 0;
  return template.replace(REPLY_PLACEHOLDER, () => values[index++]?.value ?? "");
}

export function renderReplyTemplate(template: string, result: unknown): string | null {
  return renderReplyFromValues(template, replyTemplateValues(template, result));
}

export interface DecisionReplyInput {
  readonly toolName: string;
  readonly template: string;
  readonly values: readonly ReplyTemplateValue[];
}

export interface DecisionReplyOutput {
  readonly reply: string | null;
}

/** The built-in reply wording. */
export function wordDecisionReply(input: DecisionReplyInput): DecisionReplyOutput {
  return { reply: renderReplyFromValues(input.template, input.values) };
}

const REPLY_CAP = 1_000;

export const chatDecisionReplyWordingPoint = defineExtensionPoint<
  DecisionReplyInput,
  DecisionReplyOutput
>({
  id: "chat.decisionReplyWording",
  ownerModule: "chat",
  exportName: "wordDecisionReply",
  inputSchema: Type.Object(
    {
      toolName: Type.String({ maxLength: 200 }),
      template: Type.String({ maxLength: 2_000 }),
      values: Type.Array(
        Type.Object(
          {
            placeholder: Type.String({ maxLength: 200 }),
            value: Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])
          },
          { additionalProperties: false }
        ),
        { maxItems: 50 }
      )
    },
    { additionalProperties: false }
  ),
  outputSchema: Type.Object(
    { reply: Type.Union([Type.String({ maxLength: 4_000 }), Type.Null()]) },
    { additionalProperties: false }
  ),
  shapeVersion: 1,
  limits: { guestTimeMs: 5, elapsedMs: 50 },
  builtInDeadlineMs: 2_000,
  sampleInput: {
    toolName: "tasks.addTask",
    template: "Added {task.title} to {list.name}.",
    values: [
      { placeholder: "task.title", value: "Buy milk" },
      { placeholder: "list.name", value: "Groceries" }
    ]
  },
  apiAccess: "none",
  outputRule: (input, output) => {
    const builtIn = wordDecisionReply(input);
    // A missing value means the action is unconfirmed. Only "no reply" may say so.
    if (builtIn.reply === null) {
      return output.reply === null ? { ok: true } : { ok: false, schemaPath: "/reply" };
    }
    if (output.reply === null) return { ok: false, schemaPath: "/reply" };
    if (output.reply.length > Math.max(REPLY_CAP, builtIn.reply.length)) {
      return { ok: false, schemaPath: "/reply" };
    }
    return { ok: true };
  }
});
```

- [ ] **Step 4: Add the descriptions point**

In `packages/chat/src/live/classifier-gate-wiring.ts`, add to the imports:

```ts
import { Type } from "@sinclair/typebox";
import { defineExtensionPoint } from "@moss/extensions";
```

Add directly below `buildGateDescriptions`:

```ts
const DESCRIPTION_CAP = 300;

const gateDescriptionsSchema = Type.Object(
  {
    areas: Type.Array(
      Type.Object(
        {
          moduleId: Type.String({ maxLength: 200 }),
          description: Type.String({ maxLength: 2_000 })
        },
        { additionalProperties: false }
      ),
      { maxItems: 200 }
    ),
    tools: Type.Array(
      Type.Object(
        {
          moduleId: Type.String({ maxLength: 200 }),
          name: Type.String({ maxLength: 200 }),
          description: Type.String({ maxLength: 2_000 })
        },
        { additionalProperties: false }
      ),
      { maxItems: 1_000 }
    )
  },
  { additionalProperties: false }
);

function describedWithin(description: string, original: string): boolean {
  return description.length > 0 && description.length <= Math.max(DESCRIPTION_CAP, original.length);
}

export const chatDecisionDescriptionsPoint = defineExtensionPoint<
  GateDescriptions,
  GateDescriptions
>({
  id: "chat.decisionDescriptions",
  ownerModule: "chat",
  exportName: "buildGateDescriptions",
  inputSchema: gateDescriptionsSchema,
  outputSchema: gateDescriptionsSchema,
  shapeVersion: 1,
  limits: { guestTimeMs: 5, elapsedMs: 50 },
  builtInDeadlineMs: 2_000,
  sampleInput: {
    areas: [{ moduleId: "tasks", description: "Tasks" }],
    tools: [{ moduleId: "tasks", name: "tasks.addTask", description: "Adds a task to a list" }]
  },
  apiAccess: "none",
  // Mapped back by position, so every position must keep its module and tool.
  outputRule: (input, output) => {
    if (output.areas.length !== input.areas.length) return { ok: false, schemaPath: "/areas" };
    if (output.tools.length !== input.tools.length) return { ok: false, schemaPath: "/tools" };
    for (const [index, area] of output.areas.entries()) {
      const original = input.areas[index]!;
      if (area.moduleId !== original.moduleId) return { ok: false, schemaPath: `/areas/${index}` };
      if (!describedWithin(area.description, original.description)) {
        return { ok: false, schemaPath: `/areas/${index}/description` };
      }
    }
    for (const [index, tool] of output.tools.entries()) {
      const original = input.tools[index]!;
      if (tool.moduleId !== original.moduleId || tool.name !== original.name) {
        return { ok: false, schemaPath: `/tools/${index}` };
      }
      if (!describedWithin(tool.description, original.description)) {
        return { ok: false, schemaPath: `/tools/${index}/description` };
      }
    }
    return { ok: true };
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts tests/unit/calendar-classifier-menu.test.ts tests/unit/calendar-classifier-tool.test.ts tests/unit/chat-classifier-gate.test.ts`
Expected: PASS. The two calendar files call `renderReplyTemplate` and must pass unchanged.

- [ ] **Step 6: Run the two controls**

Run each control named in the new test comments as in Task 1 Step 6, reverting with `git checkout --` on the one file changed.

- [ ] **Step 7: Build the point records and commit**

Run: `pnpm exec tsx scripts/build-extension-points.ts && pnpm exec tsx scripts/check-extension-points.ts`
Expected: exit 0, with `chat.decisionReplyWording` and `chat.decisionDescriptions` added.

```bash
git add packages/chat/src/live/classifier-gate-arguments.ts packages/chat/src/live/classifier-gate-wiring.ts \
  tests/unit/chat-extension-points.test.ts \
  packages/extensions/src/points/generated-points.json packages/extensions/src/points/shape-record.json
git commit -m "feat(chat): declare the decision description and reply wording points (spec 5)"
```

### Task 3: Wire the wording port and record the wording in the quiet log

**Files:**

- Modify: `packages/chat/src/live/classifier-gate.ts` (`GateTrace`, `ClassifierGatePorts`, `GateWordingPort`, a private `word` and `wordReply` method, the four question sites, the reply site in `dispatch`)
- Modify: `packages/chat/src/live/classifier-gate-wiring.ts` (`ClassifierGateAttemptPorts`, `runDecisionPoint`, the factory's `wording` port, `listTools`)
- Modify: `packages/chat/src/live/classifier-gate-shadow.ts` (pass the port; `withTrace`)
- Modify: `packages/chat/src/classifier-shadow-repository.ts` (`CompleteShadowRecordInput`, the `complete` UPDATE)
- Create: `packages/chat/sql/0306_chat_classifier_shadow_wording.sql`
- Modify: `packages/chat/src/manifest.ts` (migrations list; `chat.classifier_shadow_records` feature text)
- Modify: `packages/db/src/types.ts` (`ChatClassifierShadowRecordsTable`)
- Modify: `tests/integration/foundation-schema-catalog.test.ts` (one catalog entry)
- Test: `tests/unit/chat-gate-wording.test.ts` (new), `tests/unit/chat-classifier-shadow-runner.test.ts` (one harness option, one test)

**Interfaces:**

- Consumes, from Tasks 1 and 2: `wordDecisionQuestion`, `questionFromWording`, `DecisionQuestionInput`, `DecisionQuestionOutput`, `chatDecisionQuestionWordingPoint`, `replyTemplateValues`, `wordDecisionReply`, `DecisionReplyInput`, `DecisionReplyOutput`, `chatDecisionReplyWordingPoint`, `chatDecisionDescriptionsPoint`, `buildGateDescriptions`, `GateDescriptions`.
- Consumes, from `@moss/extensions`: `callPoint`, `type ExtensionPoint`, `type PointCallResult`.
- Consumes, in the gate: the private `guard(work, signal)` and `this.run(work, signal)` helpers, unchanged.
- Produces: `GateWordingPort`, `ClassifierGatePorts.wording?`, `GateTrace.areaQuestionInstructions?`, `GateTrace.wordingRevision?`, `ClassifierGateAttemptPorts.wording?`, `runDecisionPoint`, `CompleteShadowRecordInput.areaQuestionInstructions?` and `.wordingRevision?`, and two columns on `app.chat_classifier_shadow_records`.

The gate keeps working with no port, so every existing gate test and double compiles unchanged. A question goes through `this.run`, so the gate deadline still ends the attempt. The reply comes after the tool already ran, so a reply port failure or a missed deadline falls back to the built-in wording and never ends the attempt.

- [ ] **Step 1: Write the failing gate tests**

Create `tests/unit/chat-gate-wording.test.ts`. It keeps its own small harness, because `tests/unit/chat-classifier-gate.test.ts` is near the file size cap.

```ts
import { describe, expect, it, vi } from "vitest";

import type { ClassifierChoiceResult, ClassifierHandle } from "@moss/ai";

import {
  ClassifierGate,
  wordDecisionQuestion,
  type ClassifierGatePorts,
  type GateRequest,
  type GateTool,
  type GateWordingPort
} from "../../packages/chat/src/live/classifier-gate.js";
import { wordDecisionReply } from "../../packages/chat/src/live/classifier-gate-arguments.js";

const usage = { inputTokens: 1, outputTokens: 1 };

function pick(choice: string): ClassifierChoiceResult {
  return {
    ok: true,
    choice,
    confidence: 0.99,
    probabilities: { [choice]: 0.9, other: 0.1 },
    runnerUp: { choice: "other", probability: 0.1 },
    lead: 0.8,
    usage
  };
}

const handle: ClassifierHandle = {
  model: {
    id: "model-1",
    provider_config_id: "p",
    provider_kind: "x",
    provider_model_id: "m"
  } as never,
  capability: "choice_only"
};

const readTool: GateTool = {
  moduleId: "calendar",
  moduleDescription: "The user's calendar",
  name: "calendar.today",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: { window: { type: "string", enum: ["today", "tomorrow"] } },
    required: ["window"],
    additionalProperties: false
  },
  outputSchema: { type: "object", properties: { summary: { type: "string" } } },
  classifier: { description: "List the day's events", replyTemplate: "Events: {summary}" }
};

function ports(wording?: GateWordingPort) {
  const answers = [pick("calendar"), pick("calendar.today"), pick("today")];
  const choose = vi.fn(async () => answers.shift() ?? pick("none"));
  const value: ClassifierGatePorts = {
    classifier: { resolve: async () => handle, choose, extract: vi.fn() },
    listTools: async () => [readTool],
    loadCandidates: vi.fn(),
    gateway: {
      call: vi.fn(async () => ({
        kind: "executed" as const,
        outcome: "success" as const,
        response: { ok: true as const, data: {}, structuredData: { summary: "3 events" } }
      }))
    },
    isReleased: () => true,
    now: () => 1_000_000,
    ...(wording ? { wording } : {})
  };
  return { value, choose };
}

const request: GateRequest = {
  actorUserId: "user-1",
  threadId: "thread-1",
  message: "what is on my calendar today",
  hasAttachment: false,
  incognito: false,
  mode: "on"
};

const SHORT = "Which area fits? Pick none if unsure.";

function customWording(): GateWordingPort {
  return {
    question: vi.fn(async (input) => {
      const builtIn = wordDecisionQuestion(input);
      return {
        value: input.kind === "area" ? { ...builtIn, instructions: SHORT } : builtIn,
        usedRevision: 4
      };
    }),
    reply: vi.fn(async () => ({ value: { reply: "You have 3 events today." }, usedRevision: 4 }))
  };
}

describe("decision wording port", () => {
  it("records the built-in area wording and no revision when no port is wired", async () => {
    const { value } = ports();
    const outcome = await new ClassifierGate(value).evaluate(request);
    expect(outcome).toMatchObject({ kind: "handled", reply: "Events: 3 events" });
    const trace = (outcome as { trace: Record<string, unknown> }).trace;
    expect(trace.areaQuestionInstructions).toBe(
      wordDecisionQuestion({ kind: "area", subject: "", options: [{ id: "calendar", text: "x" }] })
        .instructions
    );
    expect(trace).not.toHaveProperty("wordingRevision");
  });

  it("asks the customized area question and records its wording and revision", async () => {
    const { value, choose } = ports(customWording());
    const outcome = await new ClassifierGate(value).evaluate(request);
    expect(choose.mock.calls[0]![1].question.instructions).toBe(SHORT);
    expect(Object.keys(choose.mock.calls[0]![1].question.criteria)).toContain("calendar");
    expect(outcome).toMatchObject({
      kind: "handled",
      reply: "You have 3 events today.",
      trace: { areaQuestionInstructions: SHORT, wordingRevision: 4 }
    });
  });

  it("falls back to the built-in reply when the reply port throws after the tool ran", async () => {
    const wording = customWording();
    wording.reply = vi.fn(async () => {
      throw new Error("extensions unavailable");
    });
    const { value } = ports(wording);
    expect(await new ClassifierGate(value).evaluate(request)).toMatchObject({
      kind: "handled",
      reply: wordDecisionReply({
        toolName: "calendar.today",
        template: "Events: {summary}",
        values: [{ placeholder: "summary", value: "3 events" }]
      }).reply
    });
  });

  it("falls back to the built-in reply when the reply port never answers", async () => {
    const wording = customWording();
    wording.reply = vi.fn(() => new Promise<never>(() => {}));
    const { value } = ports(wording);
    const started = Date.now();
    expect(await new ClassifierGate(value).evaluate(request)).toMatchObject({
      kind: "handled",
      reply: "Events: 3 events"
    });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
```

The last test uses real timers. The gate clears its own 3 second deadline before it runs the tool, so only the 2 second reply deadline is running while the port hangs.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:unit tests/unit/chat-gate-wording.test.ts`
Expected: FAIL with a type or missing export error for `GateWordingPort`.

- [ ] **Step 3: Add the port, the trace fields and the gate methods**

In `packages/chat/src/live/classifier-gate.ts`:

Change the import from `./classifier-gate-arguments.js` so it drops `renderReplyTemplate` and adds:

```ts
  chatDecisionReplyWordingPoint,
  replyTemplateValues,
  wordDecisionReply,
  type DecisionReplyInput,
  type DecisionReplyOutput,
```

In `interface GateTrace`, add above `readonly latencyMs: number;`:

```ts
  /** The area question's instructions as asked. The shadow record keeps them. */
  readonly areaQuestionInstructions?: string;
  /** The question wording customization's revision, when a customization answered. */
  readonly wordingRevision?: number;
```

In `interface ClassifierGatePorts`, add directly below `listTools(): Promise<readonly GateTool[]>;`:

```ts
  /** Question and reply wording customizations. Absent means the built-in wording. */
  readonly wording?: GateWordingPort;
```

Add directly below `chatDecisionQuestionWordingPoint` (Task 1):

```ts
/** The customization calls for question and reply wording, already bound to the actor. */
export interface GateWordingPort {
  question(
    input: DecisionQuestionInput,
    signal: AbortSignal
  ): Promise<PointCallResult<DecisionQuestionOutput>>;
  reply(
    input: DecisionReplyInput,
    signal: AbortSignal
  ): Promise<PointCallResult<DecisionReplyOutput>>;
}
```

Add these two private methods to `ClassifierGate`, directly below `ask`:

```ts
  /** Words one question through the port, or the built-in when no port is wired. */
  private async word(
    input: DecisionQuestionInput,
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] }
  ): Promise<DecisionQuestionOutput> {
    const worded = this.ports.wording
      ? await this.run(this.ports.wording.question(input, signal), signal)
      : { value: wordDecisionQuestion(input), usedRevision: null };
    if (worded.usedRevision !== null) trace.wordingRevision = worded.usedRevision;
    if (input.kind === "area") trace.areaQuestionInstructions = worded.value.instructions;
    return worded.value;
  }

  /**
   * Words the reply. The tool already ran, so a port failure or a missed deadline falls back to
   * the built-in wording and never ends the attempt.
   */
  private async wordReply(tool: GateTool, result: unknown): Promise<string | null> {
    const template = tool.classifier!.replyTemplate;
    const input: DecisionReplyInput = {
      toolName: tool.name,
      template,
      values: replyTemplateValues(template, result)
    };
    if (!this.ports.wording) return wordDecisionReply(input).reply;
    const signal = AbortSignal.timeout(chatDecisionReplyWordingPoint.def.builtInDeadlineMs);
    const worded = await guard(this.ports.wording.reply(input, signal), signal);
    return worded.kind === "value" ? worded.value.value.reply : wordDecisionReply(input).reply;
  }
```

In `chooseArea`, replace the `const question = buildAreaQuestion(...)` statement with:

```ts
const question = questionFromWording(
  await this.word(
    {
      kind: "area",
      subject: "",
      options: [...areas].map(([id, tools]) => ({ id, text: tools[0]!.moduleDescription }))
    },
    signal,
    trace
  )
);
```

In `chooseTool`, replace the `const question = buildToolQuestion(...)` statement with:

```ts
const question = questionFromWording(
  await this.word(
    {
      kind: "tool",
      subject: "",
      options: usable.map((tool) => ({ id: tool.name, text: tool.classifier!.description }))
    },
    signal,
    trace
  )
);
```

In `chooseArguments`, directly above the statement that calls `this.ports.classifier.extract`, add:

```ts
const extraction = await this.word(
  { kind: "extraction", subject: tool.classifier!.description, options: [] },
  signal,
  trace
);
```

and replace `instructions: buildExtractionInstructions(tool.classifier!.description),` with `instructions: extraction.instructions,`. In the argument loop, replace the `buildArgumentQuestion(arg.name, offered),` argument of `this.ask` with:

```ts
    questionFromWording(
      await this.word(
        {
          kind: "argument",
          subject: arg.name,
          options: offered.map((option) => ({ id: option.id, text: option.label }))
        },
        signal,
        trace
      )
    ),
```

In `dispatch`, replace `const reply = renderReplyTemplate(tool.classifier!.replyTemplate, result);` with:

```ts
const reply = await this.wordReply(tool, result);
```

The four builders stay in use through `wordDecisionQuestion`. If lint reports any of them as an unused import elsewhere in the file, remove only that import.

- [ ] **Step 4: Run the gate tests**

Run: `pnpm test:unit tests/unit/chat-gate-wording.test.ts tests/unit/chat-classifier-gate.test.ts tests/unit/chat-classifier-gate-checks.test.ts tests/unit/chat-extension-points.test.ts`
Expected: PASS. The existing gate tests pass unchanged, because the built-in wording is today's wording.

- [ ] **Step 5: Write the failing wiring tests**

Append to `tests/unit/chat-extension-points.test.ts`, adding `runDecisionPoint` to the existing import from `classifier-gate-wiring.js` and `vi` to the vitest import:

```ts
describe("runDecisionPoint", () => {
  // Control: in runDecisionPoint, delete the try/catch so the error propagates. Red.
  it("answers with the built-in and no revision when the extensions machinery throws", async () => {
    const dataContext = {
      withDataContext: vi.fn(async () => {
        throw new Error("extensions tables unavailable");
      })
    };
    const input: DecisionQuestionInput = {
      kind: "area",
      subject: "",
      options: [{ id: "calendar", text: "Calendar" }]
    };
    const result = await runDecisionPoint(
      dataContext as never,
      { actorUserId: "user-1", requestId: "req-1" },
      chatDecisionQuestionWordingPoint,
      input,
      new AbortController().signal,
      wordDecisionQuestion
    );
    expect(result).toEqual({ value: wordDecisionQuestion(input), usedRevision: null });
    expect(dataContext.withDataContext).toHaveBeenCalledWith(
      { actorUserId: "user-1", requestId: "req-1" },
      expect.any(Function)
    );
  });
});
```

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts`
Expected: FAIL with a missing export error for `runDecisionPoint`.

- [ ] **Step 6: Wire the port**

In `packages/chat/src/live/classifier-gate-wiring.ts`, add to the imports:

```ts
import { callPoint, type ExtensionPoint, type PointCallResult } from "@moss/extensions";
```

and import `chatDecisionQuestionWordingPoint` and `wordDecisionQuestion` from `./classifier-gate.js`, and `chatDecisionReplyWordingPoint` and `wordDecisionReply` from `./classifier-gate-arguments.js`, alongside the names those imports already carry.

In `ClassifierGateAttemptPorts`, add below `noteTimeout`:

```ts
  /** Question and reply wording customizations. The production factory always wires it. */
  readonly wording?: ClassifierGatePorts["wording"];
```

Add directly below `chatDecisionDescriptionsPoint`:

```ts
/**
 * Runs one decision-model point for the actor. The chat built-ins are pure, so any failure in the
 * extensions machinery answers with the built-in and never fails the gate.
 */
export async function runDecisionPoint<I, O>(
  dataContext: Pick<DataContextRunner, "withDataContext">,
  ctx: { readonly actorUserId: string; readonly requestId: string },
  point: ExtensionPoint<I, O>,
  input: I,
  signal: AbortSignal,
  builtIn: (input: I) => O
): Promise<PointCallResult<O>> {
  try {
    return await dataContext.withDataContext(
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      (scopedDb) =>
        callPoint(
          point,
          {
            scopedDb,
            actorUserId: ctx.actorUserId,
            requestId: ctx.requestId,
            signal,
            inBackgroundJob: false
          },
          input,
          async (value) => builtIn(value)
        )
    );
  } catch {
    return { value: builtIn(input), usedRevision: null };
  }
}
```

In the object the factory returns, add after `noteTimeout`:

```ts
      wording: {
        question: (input, signal) =>
          runDecisionPoint(
            dataContext,
            { actorUserId, requestId: nextRequestId() },
            chatDecisionQuestionWordingPoint,
            input,
            signal,
            wordDecisionQuestion
          ),
        reply: (input, signal) =>
          runDecisionPoint(
            dataContext,
            { actorUserId, requestId: nextRequestId() },
            chatDecisionReplyWordingPoint,
            input,
            signal,
            wordDecisionReply
          )
      },
```

In `listTools`, replace the `const described = buildGateDescriptions({ ... });` statement (plan 1c) with:

```ts
// Mapped back by position, so ids, names and risk always come from the manifest.
const { value: described } = await runDecisionPoint(
  dataContext,
  { actorUserId, requestId: nextRequestId() },
  chatDecisionDescriptionsPoint,
  {
    areas,
    tools: listed.map(({ manifest, tool }) => ({
      moduleId: manifest.id,
      name: tool.name,
      description: tool.classifier!.description
    }))
  },
  AbortSignal.timeout(chatDecisionDescriptionsPoint.def.builtInDeadlineMs),
  buildGateDescriptions
);
```

This statement must sit outside any `scoped(...)` callback, as the plan 1c statement it replaces does, so it opens its own short transaction instead of nesting one.

- [ ] **Step 7: Pass the port through the shadow and record the two fields**

In `packages/chat/src/live/classifier-gate-shadow.ts`, in the `new ClassifierGate({ ... })` call, add directly above `now: deps.now`:

```ts
          ...(ports.wording ? { wording: ports.wording } : {}),
```

In `withTrace`, add directly above `latencyMs: trace.latencyMs`:

```ts
    ...(trace.areaQuestionInstructions !== undefined
      ? { areaQuestionInstructions: trace.areaQuestionInstructions.slice(0, 500) }
      : {}),
    ...(trace.wordingRevision !== undefined ? { wordingRevision: trace.wordingRevision } : {}),
```

In `packages/chat/src/classifier-shadow-repository.ts`, add to `CompleteShadowRecordInput` below `latencyMs`:

```ts
  /** The area question's instructions as asked, at most 500 characters. */
  readonly areaQuestionInstructions?: string;
  /** The question wording customization's revision, when one answered. */
  readonly wordingRevision?: number;
```

and in the `complete` UPDATE, add directly below `latency_ms = ${input.latencyMs ?? null},`:

```ts
            area_question_instructions = ${input.areaQuestionInstructions ?? null},
            wording_revision = ${input.wordingRevision ?? null},
```

- [ ] **Step 8: Test the shadow pass-through**

In `tests/unit/chat-classifier-shadow-runner.test.ts`, add `wording?: ClassifierGateAttemptPorts["wording"];` to the `harness` overrides type, and add `...(overrides.wording ? { wording: overrides.wording } : {})` as the last property of the `ports` object. Add `wordDecisionQuestion` to the import from `classifier-gate.js` (add that import if the file has none). Append inside `describe("shadow decisions", ...)`:

```ts
// Control: in classifier-gate-shadow.ts, delete the wording spread from the gate's ports. Red.
it("records the customized area wording and its revision", async () => {
  const h = harness({
    wording: {
      question: async (question) => ({
        value:
          question.kind === "area"
            ? { ...wordDecisionQuestion(question), instructions: "Which area?" }
            : wordDecisionQuestion(question),
        usedRevision: 7
      }),
      reply: async () => ({ value: { reply: null }, usedRevision: 7 })
    }
  });
  h.runner.start(input());
  await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
  expect(h.complete).toHaveBeenCalledWith(
    fakeDb,
    expect.objectContaining({
      decision: "would_handle",
      areaQuestionInstructions: "Which area?",
      wordingRevision: 7
    })
  );
});
```

If an existing test in this file compares the whole `complete` argument exactly and now fails only because it gained `areaQuestionInstructions`, add `areaQuestionInstructions: expect.any(String)` to that expected object and nothing else.

Run: `pnpm test:unit tests/unit/chat-classifier-shadow-runner.test.ts tests/unit/chat-classifier-shadow-wiring.test.ts tests/unit/chat-classifier-gate-wiring.test.ts tests/unit/chat-extension-points.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the columns**

Create `packages/chat/sql/0306_chat_classifier_shadow_wording.sql`:

```sql
-- Classifier gate shadow records gain the area question's wording as asked and the question
-- wording customization's revision (Moss extensions, spec 5). Owner-only like the rest of the
-- row. The table-level grants in 0251 already cover new columns.
ALTER TABLE app.chat_classifier_shadow_records
  ADD COLUMN area_question_instructions text NULL
    CHECK (
      area_question_instructions IS NULL OR octet_length(area_question_instructions) <= 2000
    ),
  ADD COLUMN wording_revision integer NULL
    CHECK (wording_revision IS NULL OR wording_revision >= 0);
```

In `packages/chat/src/manifest.ts`, append `"sql/0306_chat_classifier_shadow_wording.sql"` after `"sql/0297_chat_action_history_permissions.sql"` in the migrations list, and replace the `chat.classifier_shadow_records` description with:

```ts
      description:
        "Private shadow records compare the gate's guess with the main model's first tool call " +
        "and keep message text, the area question as asked and the wording customization used. " +
        "A first tool outside the classifier stays unnamed; later calls never replace it. " +
        "Private chats never sent. Ask Moss to delete them.",
```

In `packages/db/src/types.ts`, add to `ChatClassifierShadowRecordsTable` below `latency_ms`:

```ts
area_question_instructions: string | null;
wording_revision: number | null;
```

In `tests/integration/foundation-schema-catalog.test.ts`, add `{ version: "0306", name: "0306_chat_classifier_shadow_wording.sql" },` in version order.

Run: `pnpm check:migration-numbers`
Expected: exit 0. If `0306` is taken on main, use the next free number in the file name, the manifest line and the catalog entry.

- [ ] **Step 10: Run the static checks and the database gate**

Run: `pnpm typecheck && pnpm lint && pnpm check:file-size && pnpm build:app-map`
Expected: exit 0.

Use the `verify-gate` skill, then run `scripts/run-gate.sh start --gate test:extensions-db`, then `scripts/run-gate.sh wait --follow` as one Bash call with `run_in_background: true`.
Expected: exit 0. The catalog test inside the gate's migration run proves the new file applies.

- [ ] **Step 11: Run the controls and commit**

Run the two controls named in the Step 5 and Step 8 test comments as in Task 1 Step 6.

```bash
git add packages/chat/src/live/classifier-gate.ts packages/chat/src/live/classifier-gate-wiring.ts \
  packages/chat/src/live/classifier-gate-shadow.ts packages/chat/src/classifier-shadow-repository.ts \
  packages/chat/sql/0306_chat_classifier_shadow_wording.sql packages/chat/src/manifest.ts \
  packages/db/src/types.ts tests/integration/foundation-schema-catalog.test.ts \
  tests/unit/chat-gate-wording.test.ts tests/unit/chat-extension-points.test.ts \
  tests/unit/chat-classifier-shadow-runner.test.ts
git commit -m "feat(chat): route decision wording through the extension points and record it (spec 5)"
```

If the build check reports a fingerprint change for a chat point, run the build step from Global Constraints and add the two generated files to this commit.

### Task 4: Register the chat points and prove them live

**Files:**

- Create: `packages/chat/src/live/extension-point-entries.ts`
- Modify: `packages/chat/src/index.ts` (one export line)
- Modify: `packages/module-registry/src/extension-points.ts` (fill `BUILT_IN_EXTENSION_POINTS`)
- Test: `tests/unit/chat-extension-points.test.ts` (append), `tests/integration/chat-extension-points.test.ts` (new), `package.json` (append to `test:extensions-db`)
- Create: `tests/live/extensions-1d-decision-wording.spec.ts`

**Interfaces:**

- Consumes, from plan 1b: `RegisteredPointEntry { point; sampleBuiltInAnswer }`, `registerExtensionPoints`, `resetRegisteredPointsForTests`, `configureExtensionsRuntime`, `resetExtensionsRuntimeForTests`, `ExtensionsRepository` (`applyVersion`, `reset`, `readState`), and `BUILT_IN_EXTENSION_POINTS` in `packages/module-registry/src/extension-points.ts`, which plan 1b leaves as an empty array.
- Consumes, from Tasks 1 to 3: the three points, their built-ins and `runDecisionPoint`.
- Produces: `CHAT_EXTENSION_POINT_ENTRIES`.

Registering the points is what lets a person customize them, so this task makes PR 1 user-facing.

- [ ] **Step 1: Write the failing registry test**

Append to `tests/unit/chat-extension-points.test.ts`, with these imports added at the top:

```ts
import { CHAT_EXTENSION_POINT_ENTRIES } from "../../packages/chat/src/live/extension-point-entries.js";
import { BUILT_IN_EXTENSION_POINTS } from "../../packages/module-registry/src/extension-points.js";
```

```ts
describe("chat registry entries", () => {
  it("registers the three decision-model points with valid sample answers", () => {
    const ids = CHAT_EXTENSION_POINT_ENTRIES.map((entry) => entry.point.def.id);
    expect(ids).toEqual([
      "chat.decisionQuestionWording",
      "chat.decisionDescriptions",
      "chat.decisionReplyWording"
    ]);
    for (const entry of CHAT_EXTENSION_POINT_ENTRIES) {
      const { def } = entry.point;
      expect(Value.Check(def.outputSchema, entry.sampleBuiltInAnswer)).toBe(true);
      expect(def.outputRule(def.sampleInput, entry.sampleBuiltInAnswer as never)).toEqual({
        ok: true
      });
    }
  });

  it("is part of the built-in point list", () => {
    const registered = BUILT_IN_EXTENSION_POINTS.map((entry) => entry.point.def.id);
    for (const entry of CHAT_EXTENSION_POINT_ENTRIES) {
      expect(registered).toContain(entry.point.def.id);
    }
  });
});
```

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts`
Expected: FAIL, because `extension-point-entries.js` does not exist.

- [ ] **Step 2: Add the entries and register them**

Create `packages/chat/src/live/extension-point-entries.ts`:

```ts
import type { RegisteredPointEntry } from "@moss/extensions";

import { chatDecisionQuestionWordingPoint, wordDecisionQuestion } from "./classifier-gate.js";
import { chatDecisionReplyWordingPoint, wordDecisionReply } from "./classifier-gate-arguments.js";
import { buildGateDescriptions, chatDecisionDescriptionsPoint } from "./classifier-gate-wiring.js";

/** Chat's decision-model points, each with its built-in's answer for the sample input. */
export const CHAT_EXTENSION_POINT_ENTRIES: readonly RegisteredPointEntry[] = [
  {
    point: chatDecisionQuestionWordingPoint,
    sampleBuiltInAnswer: wordDecisionQuestion(chatDecisionQuestionWordingPoint.def.sampleInput)
  },
  {
    point: chatDecisionDescriptionsPoint,
    sampleBuiltInAnswer: buildGateDescriptions(chatDecisionDescriptionsPoint.def.sampleInput)
  },
  {
    point: chatDecisionReplyWordingPoint,
    sampleBuiltInAnswer: wordDecisionReply(chatDecisionReplyWordingPoint.def.sampleInput)
  }
];
```

In `packages/chat/src/index.ts`, add below the `classifier-gate-shadow.js` export:

```ts
export { CHAT_EXTENSION_POINT_ENTRIES } from "./live/extension-point-entries.js";
```

In `packages/module-registry/src/extension-points.ts`, import `CHAT_EXTENSION_POINT_ENTRIES` from `@moss/chat` (the package already depends on it) and change the empty array to:

```ts
export const BUILT_IN_EXTENSION_POINTS: readonly RegisteredPointEntry[] = [
  ...CHAT_EXTENSION_POINT_ENTRIES
];
```

Run: `pnpm test:unit tests/unit/chat-extension-points.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the isolation test**

Create `tests/integration/chat-extension-points.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import {
  configureExtensionsRuntime,
  registerExtensionPoints,
  resetExtensionsRuntimeForTests,
  resetRegisteredPointsForTests
} from "@moss/extensions";

import {
  chatDecisionQuestionWordingPoint,
  wordDecisionQuestion,
  type DecisionQuestionInput
} from "../../packages/chat/src/live/classifier-gate.js";
import { runDecisionPoint } from "../../packages/chat/src/live/classifier-gate-wiring.js";
import { CHAT_EXTENSION_POINT_ENTRIES } from "../../packages/chat/src/live/extension-point-entries.js";
import { ExtensionsRepository } from "../../packages/extensions/src/storage/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const SHORT = "Which area fits? Pick none if unsure.";

const GUEST = `export async function wordDecisionQuestion(input, builtIn) {
  const base = await builtIn();
  return input.kind === "area" ? { ...base, instructions: ${JSON.stringify(SHORT)} } : base;
}`;

const areaInput: DecisionQuestionInput = {
  kind: "area",
  subject: "",
  options: [
    { id: "calendar", text: "Calendar events" },
    { id: "tasks", text: "Task lists" }
  ]
};

describe("chat decision points per person", () => {
  let appDb: Kysely<MossDatabase>;
  let appContext: DataContextRunner;
  const repository = new ExtensionsRepository();

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    appContext = new DataContextRunner(appDb);
    resetRegisteredPointsForTests();
    registerExtensionPoints(CHAT_EXTENSION_POINT_ENTRIES);
    configureExtensionsRuntime({
      mossGet: null,
      notifyPaused: async () => {},
      publishRevisionChanged: async () => {},
      recordRecentInputs: false
    });
  });

  afterEach(async () => {
    resetExtensionsRuntimeForTests();
    resetRegisteredPointsForTests();
    await appDb.destroy();
  });

  const asUser = <T>(userId: string, work: (db: DataContextDb) => Promise<T>) =>
    appContext.withDataContext({ actorUserId: userId, requestId: crypto.randomUUID() }, work);

  const ask = (userId: string) =>
    runDecisionPoint(
      appContext,
      { actorUserId: userId, requestId: crypto.randomUUID() },
      chatDecisionQuestionWordingPoint,
      areaInput,
      new AbortController().signal,
      wordDecisionQuestion
    );

  // Control: in runDecisionPoint, pass ids.userA as callPoint's actorUserId and as the
  // withDataContext actor regardless of ctx. The user B assertion turns red.
  it("gives each person their own wording, and the built-in after a reset", async () => {
    const def = chatDecisionQuestionWordingPoint.def;
    const applied = await asUser(ids.userA, (db) =>
      repository.applyVersion(db, {
        ownerUserId: ids.userA,
        pointId: def.id,
        versionId: crypto.randomUUID(),
        code: GUEST,
        name: "Shorter area question",
        shapeVersion: def.shapeVersion,
        fingerprint: def.fingerprint,
        sourceChatSessionId: null,
        sourceThreadId: null,
        expectedRevision: 0
      })
    );
    expect(applied.ok).toBe(true);
    const revision = applied.ok ? applied.state.revision : -1;

    const [forA, forB] = await Promise.all([ask(ids.userA), ask(ids.userB)]);
    expect(forA).toEqual({
      value: { ...wordDecisionQuestion(areaInput), instructions: SHORT },
      usedRevision: revision
    });
    expect(forB).toEqual({ value: wordDecisionQuestion(areaInput), usedRevision: null });

    const reset = await asUser(ids.userA, (db) =>
      repository.reset(db, { pointId: def.id, expectedRevision: revision })
    );
    expect(reset.ok).toBe(true);
    expect(await ask(ids.userA)).toEqual({
      value: wordDecisionQuestion(areaInput),
      usedRevision: null
    });
  });
});
```

In the root `package.json`, append ` tests/integration/chat-extension-points.test.ts` to the end of the `test:extensions-db` script's file list.

- [ ] **Step 4: Run the database gate and the control**

Use the `verify-gate` skill. Run `scripts/run-gate.sh start --gate test:extensions-db`, then `scripts/run-gate.sh wait --follow` as one Bash call with `run_in_background: true`.
Expected: exit 0.

Make the control change named in the test comment, run the gate again, expect exit 1 with the user B assertion failing, revert with `git checkout -- packages/chat/src/live/classifier-gate-wiring.ts`, run the gate again, expect exit 0.

- [ ] **Step 5: Build the point records and commit**

Run: `pnpm exec tsx scripts/build-extension-points.ts && pnpm exec tsx scripts/check-extension-points.ts`
Expected: exit 0.

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:package-deps && pnpm build:app-map`
Expected: exit 0.

```bash
git add packages/chat/src/live/extension-point-entries.ts packages/chat/src/index.ts \
  packages/module-registry/src/extension-points.ts package.json \
  tests/unit/chat-extension-points.test.ts tests/integration/chat-extension-points.test.ts \
  packages/extensions/src/points/generated-points.json packages/extensions/src/points/shape-record.json
git commit -m "feat(chat): register the decision-model extension points (spec 5)"
```

- [ ] **Step 6: Write the live proof**

Create `tests/live/extensions-1d-decision-wording.spec.ts`:

```ts
// Live-Path Gate for Moss extensions plan 1d, decision-model points (spec Live proof, steps 4
// and 5 for chat). Real chat turns on the owner's real model; nothing is intercepted.
//
// Disclosed setup:
// - the gate mode is set to Shadow through the admin route and restored at the end;
// - the quiet log is read by SQL, because no screen shows the asked wording.
//
// Variables: LIVE_BASE_URL, LIVE_OWNER_EMAIL, LIVE_OWNER_PASSWORD, LIVE_DB_CONTAINER, LIVE_DB_NAME,
// LIVE_GATE_MODE_RESTORE (the mode the instance had before the run: off, shadow or on).
// Output is lengths, booleans and revision numbers only.
import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const ACTION_CARD = '[role="region"][aria-label="Action request"]';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} before running the 1d decision wording proof`);
  return value;
}

function sql(query: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      required("LIVE_DB_CONTAINER"),
      "psql",
      "-U",
      "postgres",
      "-d",
      required("LIVE_DB_NAME"),
      "-Atc",
      query
    ],
    { encoding: "utf8" }
  ).trim();
}

interface QuietRecord {
  readonly instructionsLength: number;
  readonly revision: number | null;
}

/** The newest shadow record with an area question written after `since`. */
function latestRecord(since: string): QuietRecord | null {
  const row = sql(
    `SELECT length(area_question_instructions) || '|' || coalesce(wording_revision::text, '')
       FROM app.chat_classifier_shadow_records
      WHERE created_at > '${since}'::timestamptz AND area_question_instructions IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`
  );
  if (!row) return null;
  const [length, revision] = row.split("|");
  return { instructionsLength: Number(length), revision: revision ? Number(revision) : null };
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(required("LIVE_OWNER_EMAIL"));
  await page.getByLabel("Password").fill(required("LIVE_OWNER_PASSWORD"));
  await page.locator("form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible({
    timeout: 30_000
  });
}

async function askInNewChat(page: Page, message: string): Promise<void> {
  await page.goto("/today");
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await page.getByRole("button", { name: "New chat" }).click();
  // The page shows no ready signal for the background protocol start; give it a bounded settle.
  await page.waitForTimeout(20_000);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await composer.press("Enter");
}

async function setGate(page: Page, mode: string): Promise<void> {
  const saved = await page.request.put("/api/admin/runtime-config/chat.classifier_gate_mode", {
    data: { value: mode }
  });
  expect(saved.ok(), `gate ${mode} -> ${saved.status()}`).toBe(true);
}

/** Sends one calendar question and returns its quiet record. Fails loudly when none appears. */
async function recordFor(page: Page): Promise<QuietRecord> {
  const since = sql("SELECT now()::text");
  await askInNewChat(page, "What is on my calendar today?");
  let record: QuietRecord | null = null;
  await expect
    .poll(
      () => {
        record = latestRecord(since);
        return record !== null;
      },
      {
        timeout: 120_000,
        message: "no shadow record with an area question; check a decision model is set"
      }
    )
    .toBe(true);
  return record!;
}

let control: QuietRecord;

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page);
  await setGate(page, required("LIVE_GATE_MODE_RESTORE"));
  await page.close();
});

test("1. control: the built-in wording, with no customization", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await setGate(page, "shadow");
  control = await recordFor(page);
  console.log(
    `control: instructions length ${control.instructionsLength}, revision ${control.revision}`
  );
  expect(control.revision).toBeNull();
});

test("2. Moss writes a shorter area question and it is used", async ({ page }) => {
  test.setTimeout(600_000);
  await signIn(page);
  await askInNewChat(
    page,
    "Customize how the decision model words its area question. Make the instructions one " +
      "short sentence under 60 characters and keep everything else exactly the same. Apply it."
  );
  const card = page.locator(ACTION_CARD);
  if (await card.isVisible({ timeout: 240_000 }).catch(() => false)) {
    await card.getByRole("button", { name: "Approve" }).click();
  }
  await expect
    .poll(
      async () => {
        await page.goto("/settings?section=customizations");
        return page.getByRole("region", { name: "Customized functions" }).innerText();
      },
      { timeout: 240_000, message: "the customization never showed as Running" }
    )
    .toContain("Running");

  const customized = await recordFor(page);
  console.log(
    `customized: instructions length ${customized.instructionsLength}, revision ${customized.revision}`
  );
  expect(customized.revision).not.toBeNull();
  expect(customized.instructionsLength).toBeLessThan(control.instructionsLength);
});

test("3. the owner's switch puts the built-in back", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto("/settings?section=instcustomizations");
  const toggle = page.getByRole("switch").first();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();

  const after = await recordFor(page);
  console.log(
    `switched off: instructions length ${after.instructionsLength}, revision ${after.revision}`
  );
  expect(after.revision).toBeNull();
  expect(after.instructionsLength).toBe(control.instructionsLength);

  await toggle.click();
  await expect(toggle).toBeChecked();
});
```

The admin pane at `/settings?section=instcustomizations` holds only the owner's switch (plan 1b), so the first switch on that page is the right one. If plan 1b gave it no switch role, use the control's real accessible name from `packages/extensions/src/web/` and say so in the PR body.

- [ ] **Step 7: Run the live proof on moss-proof**

Read `~/.config/moss-proof/README.md` for the address, the container and the database name, and for how to update the instance to this branch. Never print or copy `~/.config/moss-proof/account`. Export its values into the shell without echoing them, for example `set -a; . ~/.config/moss-proof/account; set +a`, only if the README says that file is in that format. Record the current gate mode from the "Gate state" control at `/settings?section=aiproviders` in `LIVE_GATE_MODE_RESTORE`.

Run: `pnpm exec playwright test -c playwright.live.config.ts tests/live/extensions-1d-decision-wording.spec.ts`
Expected: 3 passed. The console lines show the control with no revision, the customized wording shorter with a revision number, and the switched-off wording back to the control length with no revision.

If step 2 fails because the model did not apply a customization, run it once more. Two failures mean stop and report to the coordinator with the console lines. Do not hand-write the customization through SQL.

- [ ] **Step 8: Open PR 1**

Push the branch and open the PR. The body carries:

- Release note. Category Added. Title "Customize how the decision model asks and answers". Description "You can ask Moss to change how the decision model words its questions, describes your tools and phrases its quick replies, and turn it back to the original at any time."
- App map. The shadow records feature now names the recorded question wording and customization version. The three points appear in the customizations pane through plan 1b's registry.
- Controls. Each control from Tasks 1 to 4, with the failing and passing exit codes.
- Database gate. The exit code of the final `test:extensions-db` run.

Post the live proof output as a PR comment with `gh pr comment <number> --body-file <file>`, holding only the three console lines and the pass count. Write the file outside the repository and delete it after posting.
