# Plan: finishing Park Press, and the Workshop project workspace

Spec: `docs/superpowers/specs/2026-09-05-park-press-finish-design.md` (approved by Ben 2026-09-05;
his four rulings of the same day are folded in). The spec wins over this plan wherever they differ.
Mockup: `docs/superpowers/specs/assets/2026-09-05-park-press-finish/index.html`.
Written 2026-09-05 by Fable 5.1 against PR 2307's branch `feat/workshop-projects-phase-a` as it
stood that day (open, not merged).

Plain English, no jargon, in every commit message body, pull request, status update and prompt
you write for another agent. Pass this rule on.

## How to use this plan

- One slice is one working session. Do not start a slice you cannot finish in one session; if it
  turns out bigger than that, split it before building, do not relay a half-built change.
- **Three pull requests.** PR A is slice 1 alone, because it changes every screen in the app and
  needs its own live proof. PR B is slices 2 to 7, one worktree, committed slice by slice, merged
  once its live proof is on the pull request. PR C is slice 8 alone. Slices 9 to 12 each wait on
  build-side work from PR 2307's plan that does not exist yet; group them into pull requests as
  that work lands, never one pull request per slice, and never a pull request held open for
  weeks waiting on a slice that cannot start.
- Every slice below says what PR 2307 already ships, what this slice replaces, what is new, which
  files it touches, how to check it, what the live proof is, and which app-map entries move with
  it. Where it says "must not", that is a house rule with a real failure behind it.
- Read the spec's section for the slice before touching code, then use the `design-system` skill
  before any UI work. The mockup screens are the reference for how it looks; the spec is the
  reference for what it does.

## Ground truth: what PR 2307 ships today

Read from `feat/workshop-projects-phase-a` on 2026-09-05. Nothing here is on `main` yet.

- **Routes and pages** (`packages/workshop/src/web/project-routes.tsx`, `project-pages.tsx`):
  `/workshop` is a card grid of projects with an in-page heading, a "New project" button and a
  footer link "Earlier builds and installed modules"; `/workshop/new` is a form (name, idea, and
  "Already decided (optional)"); `/workshop/:projectId` is a two-column page with an in-page
  heading, a back link, a "Only you" badge, the conversation on the left (your idea as a card,
  then messages as cards, each marked "Saved - awaiting delivery"), a "Project work" pane on the
  right that only ever says "No plan yet", and a two-button switch on phones ("Conversation" /
  "Project work"); `/workshop/legacy` is the older admin-only page (`workshop-page.tsx`,
  `workshop-groups.tsx`) listing module builds and installed modules with Build it / Stop / Look
  at the draft / Discard / Ship actions against `/api/ai/module-builds/*` and
  `/api/admin/modules/*`.
- **There are no earlier builds anywhere.** Ben, 2026-09-05: "We don't have any earlier builds
  anywhere, the workshop has never worked." The older page lists nothing on any install, so
  nothing in this plan carries anything forward from it: no one-off server step, no rows for old
  builds, no wording for a project with no conversation. The one list starts empty and fills as
  projects are made. The page, its route and its tests are simply deleted in slice 2.
- **No Moss replies yet.** A message you send is saved and shown as awaiting delivery; nothing
  answers. Planning, building, plans attached to projects and mockups are later slices of PR
  2307's own plan (its M3, D3/D4, M4 and onward).
- **API** (`packages/workshop/src/project-routes.ts`, declared in `manifest.ts`): create project
  (POST `/api/workshop/projects`, requires `requestKey`, `title`, `initialRequest`), list, get,
  list messages, save message. No rename, no delete, no build attached to a project.
- **Contract** (`packages/shared/src/workshop-api.ts`): `WorkshopProject { id, title,
  initialRequest, context, createdAt, updatedAt }`; `ModuleBuildStatus` has seven values
  (planning, awaiting_plan_approval, building, awaiting_change, ready, failed, cancelled);
  `ModuleBuildPlan` has five parts (what it does, what it reaches, what it keeps, when it runs,
  rough cost), not numbered steps.
- **Client** (`packages/workshop/src/web/project-client.ts`): `listProjects`, `createProject`,
  `getProject`, `listMessages`, `saveMessage`, and the query keys.
- **App map** (`packages/workshop/src/manifest.ts`): navigation "The Workshop" at `/workshop`;
  feature `workshop.view` ("Manage your private Workshop projects and see your earlier module
  builds"); feature `workshop.projects` with a retry remediation; feature `workshop.chat_handoff`
  whose remediation says "Open the new-project form and choose the details you want to save" at
  `/workshop/new`; the five API routes.
- **Styles** (`packages/workshop/src/web/workshop.css`): layout-only, a 1.4fr/1fr grid, single
  column below 1024px, the phone switch below 768px.
- **Tests**: `tests/integration/workshop-project-routes.test.ts`,
  `tests/integration/workshop-projects.test.ts`, `tests/uat/specs/workshop-chat-handover.uat.spec.ts`,
  and two live specs under `tests/live/`.

## Rules for every slice

- Work in your own worktree on the branch for the pull request. Never `git add -A` or `git add .`,
  never a bare `git commit`; add explicit paths. Use the `shared-checkout` skill before any commit
  in the shared checkout. Do not check out, stash or reset while another session is running.
- **Do not touch `feat/workshop-projects-phase-a` or PR 2307.** Slices 2 onward start from `main`
  after that pull request has merged.
- Module rule: `packages/workshop` may only import from `@moss/ui`, `@moss/module-web-sdk` and
  `@moss/shared`. Anything it needs from the web app (a chat component, a top bar hook) moves into
  one of those first. Module CSS is layout only; anything that is visual identity (a rule, a colour,
  a hover) is a host primitive in `packages/ui`.
- Only `jds-*` primitives and `tokens.css` tokens. Before finishing a slice run
  `pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:ui-catalogue` (a new primitive
  must be added to `packages/ui/catalogue.json`), `pnpm lint` and `pnpm typecheck`. The full gate
  (`pnpm verify:foundation`) only through the `verify-gate` skill.
- App map: every product change in a slice updates the Workshop manifest's `navigation`,
  `features` (including errors and remediations) and API declarations in the same pull request. A
  route that is not declared in the manifest stops the server from starting. Core shell changes
  (the top bar) go in `packages/shared/src/app-map-core.ts` if the map describes that surface.
- Live proof: a user-facing slice is not done until it has been used through the real screens on
  the live dev instance and the proof (what you clicked, what you saw, screenshots) is on the pull
  request. Until then the honest status is "code-complete, unverified". Spin the instance up with
  the dev-preview recipe in memory; never test against prod.
- The pull request fills in the "Release note" section of `.github/PULL_REQUEST_TEMPLATE.md` in
  plain English.
- No provider or model name in code. No new required setting or environment variable.
- Do not create GitHub issues from this plan; the coordinator does that.

## What blocks on PR 2307

- **Everything from slice 2 on** needs PR 2307 merged: the project tables, routes, pages and
  manifest only exist on its branch.
- **Slice 8 (the panel and the Plan tab)** needs, from PR 2307's own plan: a build linked to its
  project (its D3/D4 tasks), Moss producing a plan for a project (M3), and approve / ask-for-changes
  routes for that plan.
- **Slice 9 (Design)** needs the mockup manifest, the confined capture and the image serving
  (M4, P0/R1), and a spec of its own for the design step in a build.
- **Slice 10 (Files)** needs a build that actually writes files under supervision (R-tasks).
- **Slice 11 (Preview and install)** needs verified drafts loadable through the module loader (V2,
  L1) and the private-finish route (L4).

Do not build against a guess of what those will look like. If one has not landed, the slice waits.

---

## PR A

### Slice 1 - Archivo, the bone page colour, and the masthead tokens

Spec: "Display typeface: Archivo", "Page colour: bone", and the token tables under "The masthead".
Ships alone, before anything else, and does not depend on PR 2307.

**Already there:** `--font-display` in `apps/web/src/styles/tokens.css` is an alias of
`--font-sans`; the comment at the top of that file reserves the slot for a self-hosted font. The
content-security policy in `apps/api/src/static-web.ts` already allows fonts from our own origin.
The rail already has its own field tokens (`--rail-bg`, `--rail-fg` and friends) and switches to a
dark ground in dark mode; the masthead tokens follow that pattern. The app's contrast arithmetic
is `contrastRatio` in `apps/web/src/settings/settings-appearance-pane.tsx`. **Replaced:** the oat
page and its surfaces. **New:** the font files, the `@font-face` rules, seven masthead tokens
(`--masthead-bg`, `--masthead-fg`, `--masthead-fg-muted`, `--masthead-accent`, `--masthead-rule`,
`--masthead-action-bg`, `--masthead-action-fg`) and the test that keeps them readable.

Files:

- `apps/web/public/fonts/archivo/` - Archivo woff2, latin subset, weights 400, 500, 700, 800, with
  the OFL licence file beside them. Openly licensed; check the licence text is the one that ships
  with the font.
- `apps/web/src/styles/tokens.css` - the `@font-face` rules in the reserved slot;
  `--font-display: "Archivo", var(--font-sans);` (never a hand-typed fallback list); retone
  `--paper`, `--surface`, `--surface-2`, `--line`, `--line-subtle` to the spec's table. Do not touch
  `--border` and `--border-subtle` (they alias `--line`), `--surface-3`, or any dark-mode paper or
  surface value. Then the masthead tokens, exactly as the spec's first masthead table gives them:
  the seven in the light `:root` block beside the rail tokens (field `var(--forest)`, text
  `var(--rail-fg)`, quieter text as the 0.85 wash, eyebrow `var(--gold-soft)`, rule `var(--gold)`,
  button `var(--gold)` and `#241a06`); in the dark block, field `var(--forest-soft)` and eyebrow
  `var(--gold-ink)`; in the Canyon block the quieter text at 0.9; in the Teal block the quieter text
  aliased to `var(--masthead-fg)`. Every value is an alias of an existing token or one of the two
  literals the spec names; no theme block names a colour for the field.
- `tests/unit/masthead-tokens-contrast.test.ts` (new) - reads `tokens.css`, finds every theme block
  (`:root`, each `[data-theme=...]`, the dark block, and each dark-plus-theme block), resolves the
  masthead tokens through their `var()` chains the way the browser would for that block (block
  first, then the dark block if the block is a dark one, then `:root`), composites any transparency
  onto the field, and asserts heading, quieter text and eyebrow are at least 4.5:1 on the field.
  The spec's second masthead table gives the numbers it should find; assert on the 4.5 line, not on
  those exact numbers. Use `contrastRatio` from the appearance pane, or move it to a small helper if
  importing the pane drags React into the test. A theme block added later is picked up without
  editing the test.

Acceptance: `pnpm check:design-tokens`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:unit` running
the new test (through the `verify-gate` skill; the module worker suite fails locally and is not
yours). `grep -n 'Helvetica' apps/web/src/styles/tokens.css` must show the font name only inside
`--font-sans`.

Live proof: on the dev instance, a heading's computed font is Archivo (browser dev tools, computed
styles) and the page colour is `#f2eee4`; the console shows no content-security violation; walk
Today, Settings, the chat drawer and one module page; check text inputs and Moss's chat bubble read
as sunken, not raised, now that `--surface-2` is lighter than the page; in Settings switch through
the four accent themes and dark mode and confirm the page follows and nothing regresses; in dev
tools read the computed value of `--masthead-bg` on the page in the default theme, in Canyon, and in
dark mode, and confirm it is the theme's accent, then the theme's dark ground; screenshots of Today
and the chat drawer before and after on the pull request. The tokens have no screen using them
yet; that is deliberate, and the masthead that uses them is slice 2.

App map: none (no screen, setting or path changes). Release note: Changed, "A new display
typeface and a lighter page colour across the app."

Must not: use a Google Fonts `@import` (that is what tripped the content-security policy on
2026-08-01); commit a licensed font (the repo is public); touch any Workshop file; write a colour
into a masthead token where an existing token will do (the two literals the spec names are the
only ones); reuse the rail tokens directly for the masthead (the rail's field is a darker ground
and the two must stay separately tunable).

---

## PR B - after PR 2307 merges

Branch from `main` once PR 2307 is in. One worktree, one pull request, slices 2 to 7 in order.

### Slice 2 - the green masthead, the row index, and the Workshop home page on them

Spec: "The masthead", "Lists", "Words", "Names on screen". Mockup: `screens/list.html`.

**Already there:** `Masthead` in `packages/ui/src/masthead.tsx` (eyebrow, title, lede, aside; ink
on paper; styled by `jds-masthead__*` in `packages/ui/src/styles/components-moss-today.css`; used
only by Today); a `jds-tab` primitive; the Workshop list page as a card grid with an in-page
heading and a footer link to the older `/workshop/legacy` page. **Replaced:** the Workshop home
page's heading and card grid. **Deleted:** the footer link, the older page, its route and its
tests (nothing replaces them; there are no earlier builds anywhere). **New:** a green-field
variant of `Masthead`; a row index primitive; the state on every row.

Files:

- `packages/ui/src/masthead.tsx` - a `tone` (or similar) prop with the reversed treatment: field
  touching the top bar, rule at the bottom, reversed text, full-bleed, no stripe or hatch. Every
  colour in the variant is one of slice 1's masthead tokens (`--masthead-bg` for the field,
  `--masthead-fg` for heading and lede, `--masthead-fg-muted` for meta, `--masthead-accent` for the
  eyebrow, `--masthead-rule` for the rule, the two action tokens for the one button on the field);
  the variant has no dark-mode rule of its own and no theme rule of its own, because the tokens
  carry both. The button on the field is a `jds-btn` variant coloured by the action tokens (there
  is no gold button variant today; `jds-btn--accent` is a soft fill and will not read on the field).
  Today keeps rendering the ink-on-paper default and is not touched.
- `packages/ui/src/styles/components-moss-today.css` (or a new `components-masthead.css` if the
  file is already at its size limit) - the variant's rules.
- `packages/ui/src/index-list.tsx` (working name `jds-index`; pick the name with the
  `design-system` skill) and its styles - full width, heavy ink rule on top, hairline per row, name
  column, excerpt column, right-aligned meta, hover is a gold rule down the left edge plus a forest
  title, never a filled block. Export it from `packages/ui/src/index.ts`; add it to
  `packages/ui/catalogue.json`.
- `packages/workshop/src/web/project-pages.tsx` (`WorkshopProjectList`) - render `Masthead` with
  the green tone, eyebrow, "Your projects" and the lede from the mockup; the list as the row index;
  each row: name (link), the opening request as the excerpt, and at the right a `jds-badge` state
  chip and the date of last activity. In this slice every project is "Talking it through"
  (neutral), because no build is attached to a project yet; the full state table arrives in slice
  8. Remove the "Earlier builds and installed modules" footer link. Remove the copy that leans on
  privacy.
- Delete `packages/workshop/src/web/workshop-page.tsx`, `workshop-groups.tsx`, the `legacy` route
  in `project-routes.tsx`, and the three unit tests that cover them
  (`tests/unit/workshop-page.test.tsx`, `tests/unit/workshop-groups-actions.test.tsx`,
  `tests/unit/workshop-groups.test.tsx`). Nothing else on the branch imports them (checked
  2026-09-05; the `draft-workshop-page` class in `apps/web` is the draft preview, not this page).
  There is no data to carry over and no one-off step to write.
- `packages/workshop/src/web/workshop.css` - drop the card-grid rules and the `.workshop-groups`
  rules; layout only.
- `packages/workshop/src/manifest.ts` - navigation description and `workshop.view` description to
  match the new page (drop "private" and "see your earlier module builds"); `workshop.projects`
  unchanged.

Acceptance: `pnpm check:ui-catalogue` passes with the new primitive; the existing integration tests
still pass (`tests/integration/workshop-projects.test.ts`); a unit test for the row index renders
name, excerpt and meta in that order; `pnpm build:app-map` passes with the wording changed; a
search of the branch for `workshop/legacy`, `workshop-page` and `workshop-groups` finds nothing.

Live proof: on the dev instance, `/workshop` shows the green field touching the top bar with the
gold rule, the row index with one hairline per row, a hover that draws the gold edge, and the
chip "Talking it through" on each row; the footer link is gone and `/workshop/legacy` shows the
not-found state; at 800px and 375px the rows stack sensibly; Today is unchanged; switch to Canyon
and to dark mode in Settings and the field follows the theme with the text still readable.
Screenshots at desktop and phone width, plus one in Canyon and one in dark mode for Ben, on the
pull request (Ben, 2026-09-05: he has not seen the dark field and wants to; the dark screenshot is
the one he decides on).

Must not: put the field or the rules in `workshop.css`; name a colour anywhere in the variant
(tokens only; the contrast test guards the tokens, not a literal); give Today or any other page
the green field (Ben, 2026-09-05: later, as its own work); add a second masthead component; keep
the older page "for now" behind a flag or a hidden route.

### Slice 3 - the top bar carries the trail

Spec: "Names on screen", "What this needs from the shell". Mockup: the top bar on
`screens/detail.html`.

**Already there:** the top bar title comes from `resolvePageHeading` in
`apps/web/src/app-route-metadata.ts`, rendered in `apps/web/src/shell/app-shell.tsx` (`.topbar`
rules in `apps/web/src/styles.css`); Moss's page context in `apps/web/src/chat/page-context.ts`
uses the same lookup; the Workshop detail page has its own in-page heading, back link and "Only
you" badge. **Replaced:** that heading, back link and badge. **New:** a way for the page on screen
to set the trail.

Files:

- `apps/web/src/shell/page-trail.tsx` (new) - a small provider and a `usePageTrail({ name, meta })`
  hook: while the calling page is mounted the top bar shows section (as a link to the section's
  path) / name / meta; on unmount it clears. Name truncates with an ellipsis; meta hidden below
  900px. Use `resolvePageHeading` for the section label and path.
- `apps/web/src/shell/app-shell.tsx`, `apps/web/src/styles.css` - render the trail when one is set,
  in place of the plain title.
- `packages/module-web-sdk/src/index.ts` and `runtime.ts` - expose the hook to modules the same
  way the SDK exposes the host's React (a runtime-captured function, not an import of the web app).
- `apps/web/src/chat/page-context.ts` - include the trail's name in the page context so Moss knows
  which project you are in.
- `packages/workshop/src/web/project-pages.tsx` - the detail page calls the hook with the project
  title and "Started <date>", and drops its heading, back link and badge; `workshop.css` loses
  their rules.
- `packages/shared/src/app-map-core.ts` - if the map describes the top bar, say the section name is
  the way back inside a project.

Acceptance: a unit test in `tests/unit/` for the provider (set on mount, cleared on unmount, section
link resolves for `/workshop/abc`); the existing shell tests pass; `tests/integration/module-web-assets.test.ts`
still passes (SDK surface).

Live proof: open a project on the dev instance; the top bar reads "The Workshop / <name> ·
Started <date>", "The Workshop" is a link that returns to the list, no heading or back link is on
the page; ask Moss in the drawer "where am I" and it names the project; below 900px the meta is
gone. Screenshots on the pull request.

Must not: import anything from `apps/web` inside `packages/workshop`; keep the hidden heading
markup around (remove it).

### Slice 4 - the workspace is a chat window

Spec: "It is a chat window", "Sharing the parts for real", "States the window keeps from PR 2307",
"On a phone". Mockup: `screens/detail.html`.

**Already there:** `Thread` and `ActivityPeek` in `apps/web/src/chat/message-row.tsx` (used by
`chat-drawer.tsx` and `assistant-surface/surface.tsx`), taking `TranscriptRecord[]` from
`apps/web/src/chat/use-chat-stream.ts`; the message parts' styles in
`packages/ui/src/styles/components-chat.css`; the Workshop detail page rendering the idea and each
message as a `Card`, the "Project work" pane, the phone switch, "earlier messages" paging, the
awaiting-delivery caption, send failure keeping the text, and the load-error-with-retry state.
**Replaced:** the card transcript, the "Project work" pane, the visible label on the composer.
**New:** the shared transcript in the module, the pinned composer, the reading measure.

Files:

- `packages/ui/src/chat-thread.tsx` (new) - `Thread` and `ActivityPeek` moved here, exported from
  `packages/ui/src/index.ts`; the `TranscriptRecord` type moves to `packages/shared` (or with the
  component) so it is defined once. `apps/web/src/chat/chat-drawer.tsx` and
  `assistant-surface/surface.tsx` import from `@moss/ui`. `message-row.tsx` keeps only what the
  drawer alone needs, or goes.
- `packages/workshop/src/web/project-pages.tsx` (`WorkshopProjectContent`) - map the opening
  request plus the feed entries into transcript records (your turns; Moss turns once they exist);
  render `Thread`, `ActivityPeek` while a send is in flight, the "Earlier messages" link at the top,
  the awaiting-delivery caption, the composer pinned at the foot with the label kept for screen
  readers only, Send inside the box; the pane fixed to the viewport with only the transcript
  scrolling; a 56rem measure while there is no panel. Delete the "Project work" pane and the
  "Already decided" card. Do not render the phone switch (there is no panel yet); keep its code
  path for slice 8.
- `packages/workshop/src/web/workshop.css` - the fixed pane, the scroll, the composer pin, the
  measure; layout only.
- `packages/ui/src/styles/components-chat.css` - only if a genuinely missing visual primitive turns
  up (the step tick and dot inside a Moss turn, if not already there).

Acceptance: the drawer's existing tests still pass after the move; a unit test that Workshop's
mapping turns the opening request plus two entries into three records in order; the integration
tests pass; `pnpm check:ui-classes`.

Live proof: on the dev instance, open a project with several messages; only the transcript
scrolls; your turns are bubbles on the right, the opening request is the first; send a message and
see the caption under it; turn the network off in dev tools, send, and see the error with your text
kept; at 375px the window is the chat alone with no switch. Screenshots on the pull request.

Must not: copy the transcript markup into Workshop; render a "No plan yet" or any empty panel;
change the chat drawer's behaviour while moving its components.

### Slice 5 - starting a project has no form

Spec: "Starting a project has no form", "How the name happens". Mockup: `screens/new.html`.

**Already there:** `WorkshopProjectCreate` (name, idea, "Already decided" fields) at
`/workshop/new`; create requires `title`; the chat handoff tool in
`packages/workshop/src/assistant-tools.ts` creates projects with a title of its own;
`workshop.chat_handoff`'s remediation names the form. **Replaced:** the form and the remediation
text. **New:** the empty chat window with the invitation; the provisional name.

Files:

- `packages/shared/src/workshop-api.ts` - `title` optional on `CreateWorkshopProjectInput` and in
  `createWorkshopProjectInputSchema`; `context` stays in the contract (the handoff tool still sends
  it) but no screen offers it.
- `packages/workshop/src/project-service.ts` - when `title` is absent, derive it: first line of
  `initialRequest`, trimmed to about sixty characters.
- `packages/workshop/src/web/project-pages.tsx` - `/workshop/new` renders the same chat window with
  an empty transcript and the invitation (Moss mark, "What would you like to make?", the one
  sentence, three fixed example pills that write into the box and do not send). The first send
  calls `createProject` with the text as `initialRequest`, then replaces the URL with
  `/workshop/<id>` without a reload and shows the request as the first turn.
- `packages/workshop/src/web/project-client.ts` - `createProject` without a title.
- `packages/workshop/src/manifest.ts` - `workshop.chat_handoff` remediation: "Start a new project
  and say what you want in your own words", path `/workshop/new`; the `workshop.projects`
  description if it mentions the form.
- `tests/integration/workshop-project-routes.test.ts` - create without a title succeeds and
  derives the name; create with a title still works (the handoff tool).
- `tests/uat/specs/workshop-chat-handover.uat.spec.ts` - update the expectations that looked for
  the form.

Moss naming the project in its first reply is not in this slice: there are no Moss replies until
PR 2307's planning work lands. The provisional name stands, and slice 6 lets you change it. Say so
in the pull request.

Acceptance: the two tests above; `pnpm typecheck` (the handoff tool still compiles with a title).

Live proof: on the dev instance, press "New project", see the invitation, press a pill and see the
text land in the box unsent, type a request and send; the URL becomes `/workshop/<id>` with no
reload, the request is your first turn, the list shows the project with the first line of your
request as its name. Screenshots on the pull request.

Must not: keep the form reachable anywhere; send when a pill is pressed; let the handoff tool
break (it must still pass a title).

### Slice 6 - rename in place from the top bar, and the "More" button with delete

Spec: "Renaming a project"; the "More" bullet under "Names on screen". Mockup:
`screens/detail-rename.html`; the "More" icon at the right of the top bar on the workspace screens.

**Already there:** nothing - PR 2307 cannot change a title or delete a project (its plan promises
delete and export later, in its export and removal work). **New:** the rename call and the editing
state in the top bar; the delete call; the "More" button at the right of the top bar holding
"Delete this project", and "Export this project" only once PR 2307's export exists.

Files:

- `packages/shared/src/workshop-api.ts` - `RenameWorkshopProjectInput { title }`, its schema, and
  the response (the updated project).
- `packages/workshop/src/projects-repository.ts`, `project-service.ts`, `project-routes.ts` - PATCH
  `/api/workshop/projects/:projectId` with `{ title }`; owner only through the existing data
  context; blank titles rejected with the usual error shape; `updatedAt` moves.
- `packages/workshop/src/manifest.ts` - declare the route (the server refuses to start otherwise);
  add a `workshop.projects` remediation or error for a rename that fails.
- `packages/shared/src/workshop-api.ts`, `projects-repository.ts`, `project-service.ts`,
  `project-routes.ts`, `manifest.ts` - DELETE `/api/workshop/projects/:projectId`; owner only
  through the existing data context; removes the project and its messages (the feed rows from
  `sql/0224_workshop_project_feed.sql`) in one transaction; another user gets the same 404 as a
  missing project. It ships before any build can be attached to a project, so there is nothing
  else to clean up; when PR 2307's build link lands, its removal work extends this route to the
  attached build, and until that lands the route refuses a project with a build attached (409,
  "Stop the build first") rather than orphaning it. Declare the route in the manifest.
- `packages/workshop/src/web/project-client.ts` - `renameProject`, `deleteProject`.
- `apps/web/src/shell/page-trail.tsx`, `app-shell.tsx`, `apps/web/src/styles.css` - the hook takes
  an optional `actions` list; when given, a small "More" `icon-button` (three dots, label "More")
  sits at the bar's right beside the assistant button and opens a `jds-menu` with those items and
  nothing else. The shell owns the button so every module gets the same one. The hook also takes
  an optional `onRename(name)`; when given, the name is a button that looks like text (hover: a
  hairline gold underline, text cursor, tooltip "Click to rename"); click or Enter swaps it for a
  text field in place, pre-filled and selected, with Save and Cancel; the meta steps out while
  editing; Enter or Save saves, Escape or Cancel restores, clicking elsewhere saves if changed and
  cancels if not; a blank name cannot be saved (Save disabled, focus stays); while saving the new
  name shows in the resting style; on refusal the old name returns and a small red line under the
  trail says "Could not rename. Try again." until the next click. On a phone the field takes the
  bar and Save and Cancel sit under it. The shell owns this so every module renames the same way.
- `packages/workshop/src/web/project-pages.tsx` - pass `onRename` that calls `renameProject`,
  updates the query cache for the project and the list, and lets the trail (and Moss's page
  context) pick up the new name; pass one action, "Delete this project", which asks "Delete
  <name> and its conversation? This cannot be undone." with Delete and Cancel (`jds-dialog` or the
  app's existing confirm), calls `deleteProject`, drops the project from the list cache, and
  navigates to `/workshop`. Do not add "Export this project" in this slice: PR 2307's export does
  not exist yet, and a menu item that does nothing is not shown.
- `tests/integration/workshop-project-routes.test.ts` - rename as owner succeeds, blank is
  rejected, another user gets the same 404 as a missing project; delete as owner removes the
  project and its messages, a second delete is 404, another user gets 404 and the project is still
  there.
- `tests/unit/` - the trail's editing state machine (click, Enter, Escape, blur, blank, failure);
  the "More" button renders only when actions are given and lists exactly them.

Acceptance: those tests; `pnpm check:ui-classes` (the field is `jds-input`, the buttons `jds-btn`,
the menu `jds-menu`, the confirm `jds-dialog`; if the audit names a different existing primitive,
use that one and never invent a class).

Live proof: on the dev instance, click the name, type a new one, press Enter; the top bar, the
list row and Moss ("which project am I in?") all say the new name after a reload; press Escape
mid-edit and the old name is back; try a blank name and Save is disabled; stop the API and try a
rename to see the red line; open "More", choose "Delete this project", cancel and the project is
still there, do it again and confirm, and land on the list without it (and it is still gone after
a reload). Screenshots on the pull request.

Must not: rename by chat; make the section link editable; keep an edit alive across navigation;
delete without the confirm; show "Export this project" before there is an export; put the "More"
button anywhere but the bar's right.

### Slice 7 - PR B live proof and merge

Not a build slice: the whole of PR B walked end to end on the dev instance by someone who did not
build it, recorded on the pull request, then merged. The walk: start a project by typing, see it
named and listed with its state, rename it from the top bar, send a message, reload and find it,
the top bar reads section / project, the phone widths behave, Today is unchanged, the console is
clean. Run the gate through the `verify-gate` skill first. Fill the release note in plain English.

---

## PR C - after PR 2307's planning and build-link work has landed

### Slice 8 - the artifact panel and the Plan tab

Spec: "The artifact panel", "What the panel shows in each state", "Which tab is open", "A tab you
look at takes the room", "On a phone". Mockup: `screens/detail-artifact.html`.

**Already there (by then):** a build linked to its project with a status and a plan; approve and
ask-for-changes calls; the seven build statuses; the `jds-tab` and `jds-badge` primitives; the
phone switch code path from slice 4. **Replaced:** nothing on screen (the panel did not exist).
**New:** the panel, the Plan tab, the state chip and foot, the row states on the list.

Files:

- `packages/workshop/src/web/artifact-panel.tsx` (new) - rendered only when the project has an
  artifact; a tab strip of `jds-tab`s where a tab exists only with content; the chip; the body; the
  foot; the width rule (Plan and Files are a side column, 320px to 460px, about a quarter of the
  window). The Plan tab renders the plan's parts as short headed sections in the mockup's style
  (five parts today; numbered steps when planning produces them), "just added" on what changed
  since you last looked, and the foot "Approve and build" / "Ask for changes" with the pending
  pattern and the server's answer.
- `packages/workshop/src/web/project-pages.tsx` - the two-pane layout when a panel exists, the
  phone switch rendered only then ("Conversation" / the open tab's name), the chip and foot driven
  by the state table in the spec, the panel rebuilt from the server on reload; the list rows take
  the state words from the same table (gold for anything waiting on you, red for failed, green for
  installed) and the date of last activity.
- `packages/workshop/src/web/workshop.css` - the two-pane grid, the panel column widths, the
  phone rule; layout only. Any new visual (the "just added" mark) goes to `packages/ui` first.
- `packages/workshop/src/manifest.ts` - a `features` entry for the panel: what it shows in each
  state, the errors (approval refused, superseded plan) and remediations, in plain English.
- `tests/unit/` - the state table: for each build status, which tabs exist, the chip, the foot.
- Integration tests for approve / ask-for-changes through the project.

Acceptance: those tests; the checks; no empty panel ever renders (a test asserts it).

Live proof: on the dev instance, start a project, let Moss write a real plan, see the panel appear
on Plan with "Waiting on you"; press "Approve and build" and see the server status change and the
chip follow; on a project with no plan the panel is absent; at 375px the switch names "The plan"
and switching keeps unsent text. Screenshots on the pull request.

Must not: show a tab with nothing in it; make a tab open a page; render the panel from what the
browser remembers.

---

## Later pull requests - each gated on build-side work

### Slice 9 - the Design tab and the design step

Spec: "Moss designs before it codes", "The Design tab". Mockup: `screens/detail-design.html`.
Gate: PR 2307's mockup work (the manifest of screens, the confined capture, image serving) and a
new build status "waiting for design approval" - and **a spec of its own for the design step in a
build**, written and approved first. This plan only names the shape: `artifact-panel.tsx` gains a
Design tab rendering the pictures with title and description under each frame, the state and phone
switch under the frame where drawn, "just redrawn" when an image changed since approval; the
looking-tab width rule (panel takes most of the window, chat narrows to 300px to 400px); the foot
"Approve the design and build" / "Ask for changes"; the expand button and "Back to the
conversation"; `ModuleBuildStatus` gains the new value in `packages/shared/src/workshop-api.ts`
and every switch over it is updated; the manifest's panel feature gains the state. Live proof: a
real drawing appears, approval changes the status, no code is written before it.

### Slice 10 - the Files tab

Spec: the Files row of the panel table. Mockup: `screens/detail-files.html`, `detail-file.html`.
Gate: a supervised build that writes files and reports them. Shape: the list of what Moss wrote
with what each file is for, changes since Moss's last reply marked in gold, click to read in the
same column with a back arrow, read-only monospace block (the one place the mono face is right).
The tab exists from the first file written, including while building and after a failure. Live
proof: a real build's files appear as it writes them; one opens and reads.

### Slice 11 - Preview and Install

Spec: the Preview row, "Preview, technically", "After it is installed". Mockup:
`screens/detail-preview.html`. Gate: verified drafts loadable through the module loader and the
private-finish route. Shape: the draft mounted through the loader the rail already uses, only after
the host's checks pass; the caption naming the screen, a switch for a module with several; the
looking-tab width; "Install in Moss" / "Ask for changes"; after install, "Open it" and the Preview
tab keeps showing the copy under review. Live proof: the real draft runs in the panel, installs,
appears in the rail, and the panel still shows the same copy.

### Slice 12 - expanding and the divider

Spec: "Expanding", "The divider". Mockup: `screens/detail-preview-wide.html`. Gate: slice 11. Shape:
Design and Preview expand to the whole area under the top bar with "Back to the conversation"; the
divider drags, one remembered width for reading tabs and one for looking tabs, forgotten on
leaving the project. Last thing in the panel to build. Live proof: drag, switch tab kinds, see each
width return; expand and come back.

---

## Decisions this plan could not make

- The masthead's dark field is `--forest-soft`, which passes every check but which Ben has not
  seen; `--forest-soft-2` also passes and stands out more from the page, at the cost of matching
  the rail's dark ground. Slice 2's pull request shows him a dark-mode screenshot and lets him
  choose (Ben, 2026-09-05: agreed); changing it is a one-line token edit. Dark mode is not a
  special case in the tokens: it sets the same seven names as every other theme, so there is no
  separate dark rule to drop once he has chosen.
