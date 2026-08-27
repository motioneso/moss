# Issue #2051: Sports story preferences browser work

## Scope

Build the browser half of Sports story preferences from issue #2051. The server contracts and
`storyRef` fields come from open PR #2050, so this lane is stacked on that branch while it is under
review. Do not change News, shared relevance rules, or the server composition.

## Current branch facts and seams

- `packages/sports/src/web/sports-client.ts:25-35` already routes Sports reads through
  `requestJson`; the four feedback calls belong beside these functions.
- `packages/sports/src/web/sports-page.tsx:85-181` owns the overview query, all page sections, and
  the shared `sportsQueryKeys.overview` cache entry. Its local removed set will be keyed by the
  opaque story reference and passed to every story surface.
- `packages/sports/src/web/sports-news.tsx:189-215` renders the top-story list, while
  `:278-421` renders the hero, feature, article, and brief surfaces. Each current story link is
  the wrapper, so the menu must be a sibling outside that link.
- `packages/sports/src/web/sports-ticker.tsx:1-360` owns followed team and league cards. Their
  story links are the same boundary where the menu must be placed.
- `packages/sports/src/web/today-widget.tsx:23-114` reads the same overview cache and renders the
  Today lead and briefs, so it must share the removal callback and use surface `today`.
- `packages/sports/src/settings/index.tsx:581-772` owns the Sports settings pane and currently
  ends after follows and sources; the preference list belongs below those sections.
- `packages/ui/src/menu.tsx:23-86` provides the existing accessible menu, including Escape,
  outside-click handling, and focus return. The new component will use it rather than adding a
  menu implementation.
- `packages/shared/src/usefulness-feedback-api.ts:28-75` already defines the create, list, edit,
  undo, story target, surface, and bounded reason contracts. The client will reuse these types.
- `packages/sports/src/web/query-keys.ts` already exports `sportsQueryKeys.overview`, which is the
  one cache entry both Sports and Today must invalidate.
- The current `origin/main` does not contain `storyRef`; `origin/pr-2050` does. The dependency is
  real and must be present before type checking. No server file from that dependency is edited in
  this lane.

## Decisions

- Use only `storyRef` as the browser identity. Never use an array position or raw story URL.
- Do not render a menu when `storyRef` is missing; an old cached response cannot be acted on safely.
- More feedback sends immediately. Less feedback opens a labelled, 500-character reason editor;
  trim before sending and reject blank input locally.
- The component owns request state and error display. Successful mutations notify the page, which
  keeps a removed-reference set, removes the story immediately, promotes the next loaded eligible
  story, and invalidates the shared overview query once.
- Settings reads only active Sports rows from the existing owner-scoped endpoint, displays stored
  metadata, edits reasons only for Less, and uses undo for either kind. It never refetches article
  content.
- All user-visible status, saved treatment, list updates, and empty states come from mutation or
  query records. No model output enters this path; no feedback injects a chat turn.
- The feature is security tier: opaque references stay opaque, request bodies contain only the
  approved feedback fields, and the server remains responsible for ownership and target checks.

## Tasks

### 1. Client calls and story menu

Files:

- `packages/sports/src/web/sports-client.ts`
- `packages/sports/src/web/story-feedback-menu.tsx`
- `tests/unit/sports-story-feedback-menu.test.tsx`
- `tests/unit/web-sports-client.test.ts` (only if its existing helpers cover the calls)
- `tests/uat/specs/2051-sports-story-preferences.uat.spec.ts`
- `.claude/skills/coordinate/uat-trigger-map.tsv`

Contracts:

- `createSportsStoryFeedback(input: CreateUsefulnessFeedbackRequest): Promise<CreateUsefulnessFeedbackResponse>`
- `listSportsStoryFeedback(): Promise<ListUsefulnessFeedbackResponse>` using
  `/api/me/usefulness-feedback?module=sports&status=active`.
- `updateSportsStoryFeedbackReason(id: string, input: UpdateUsefulnessFeedbackReasonRequest): Promise<CreateUsefulnessFeedbackResponse>`.
- `undoSportsStoryFeedback(id: string): Promise<{ ok: boolean }>`.
- `StoryFeedbackMenu` accepts optional `storyRef`, `surface: "sports" | "today"`, and
  `onChanged: (storyRef: string, kind: "more_like_this" | "less_like_this") => void`.

Tests must prove missing references render nothing, both actions appear, blank reasons are refused,
valid bodies contain only target kind/ref, kind, reason, and surface, pending actions disable,
success shows the existing saved treatment and calls the callback, failure keeps the story visible,
and Cancel/Escape return focus to the trigger. The UAT spec begins with the real Sports story menu
path and will be extended as the page wiring lands.

E2E check: run the focused UAT test against the live dev instance after the menu is wired to one
real story surface. Kill gate: if the real response has no opaque `storyRef`, stop and report the
dependency rather than weakening the safety check. Owner: this lane agent.

### 2. Wire every Sports story surface and instant removal

Files:

- `packages/sports/src/web/sports-page.tsx`
- `packages/sports/src/web/sports-news.tsx`
- `packages/sports/src/web/sports-ticker.tsx`
- `packages/sports/src/web/today-widget.tsx`
- `packages/sports/src/web/styles/sports-6-newsband.css`
- focused existing Sports render tests plus the UAT spec

Add the menu outside links at the top-story list, hero slide, feature article, smaller article,
brief, followed team card, followed league card, Today lead, and Today briefs. Keep `sports` for
Sports page and ticker surfaces and `today` for the Today widget.

The page-level removal handler tracks a `Set<string>` of removed references. It filters only the
affected loaded section, promotes the next loaded story that is neither visible nor removed, uses
the existing section empty treatment when there is no replacement, invalidates
`sportsQueryKeys.overview` once, and retains the set until a later response no longer contains the
reference. Live scores, carousel behavior, and unrelated stories stay unchanged.

The browser test proves immediate removal, promotion, empty fallback, failure preservation, and
cross-section consistency. The existing CSS files receive layout and spacing only, retaining the
`sp-` prefix and design tokens.

E2E check: run the UAT path through Sports, remove a story, confirm the gap fill, reload, and
confirm the removed reference remains hidden. Record the observed assertions before continuing.

### 3. Add Sports Settings preferences

Files:

- `packages/sports/src/settings/index.tsx`
- `packages/sports/src/settings/sports-2.css`
- `tests/unit/settings-sports-pane.test.tsx`
- the UAT spec

Add a list below follows and sources using only active Sports feedback. Render More/Less, stored
headline and source, stored reason when present, and created or changed time. Add the major-story
explanation exactly as product copy, edit only Less reasons through PATCH, and remove either kind
through undo. Successful changes refresh the list and the shared overview; failures show an error
without claiming success. Match the existing empty treatment. Add layout and spacing only.

Tests prove News rows are excluded, stored fields render, PATCH and undo use the right IDs and
bodies, the explanation renders, and successful changes refresh both queries.

E2E check: run the UAT Settings path, edit a Less reason, remove it, reload, and confirm ordinary
stories are eligible again.

### 4. Security coverage, design audit, and release evidence

Files:

- `tests/integration/usefulness-feedback-story.test.ts`
- any focused Sports render/client tests required by the preceding tasks
- `docs/WHATS_NEW.md` (generated after the PR exists)

Extend integration coverage so a second person cannot list, edit, undo, or create feedback against
the first person's Sports target, and unregistered targets are refused. Do not place private
reasons, headlines, links, or article bodies in logs or queued work.

Run the design-system invented-class check over Sports source and the two touched stylesheets. Run
the full UAT round from the issue, including Today and the second-user ownership check, and post a
PR comment whose first line is exactly `LIVE-PATH PROOF`; do not include private reason text in
screenshots. Add the required Added release note with the plain-English description and run
`node scripts/append-release-note.mjs --pr <number>`.

## Verification

Commands are unpiped and their expected result is explicit:

- Focused unit tests for changed Sports files: exit 0.
- `pnpm test:unit`: exit 0, except the known CI-only module-sdk-worker local limitation.
- Database-touching integration tests through `scripts/run-gate.sh`, never directly: exit 0.
- `pnpm format:check`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm typecheck`: exit 0.
- Invented-class check: prints no missing classes and exits 0.
- Live UAT path: exit 0, with bounded DOM/network evidence and the required PR comment.

Before pushing, run the cheap trio, fetch and rebase on `origin/main`, confirm no News or shared
relevance files changed, push the branch, open the PR, and record it with `fleetctl`.

