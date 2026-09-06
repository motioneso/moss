# Design: finishing Park Press, and the Workshop project workspace

Status: approved by Ben 2026-09-05 ("Ok, write this up, looks great!"); build-readiness review by
Fable 5.1, 2026-09-05, folded in below; Ben's rulings of 2026-09-05 on the four open items (renaming,
the "Only you" badge, earlier builds, the green field app-wide) folded in; his fifth, that the
masthead's colours are tokens the themes set, folded in the same day; his answers of the same day
on the two things left open (export and delete live in a "More" button in the top bar; there are no
earlier builds anywhere) folded in
Direction: PARK PRESS, approved 2026-07-03 — `2026-07-03-park-press-design-language-design.md`, EPIC #726
Mockup: `docs/superpowers/specs/assets/2026-09-05-park-press-finish/`
Builds on: `2026-09-04-workshop-projects-and-supervised-builds.md` (PR 2307's spec) — its build
statuses, its mockup format, and its slice plan are the substrate this spec lays a design over.

Plain English, no jargon, in every message and every prompt written for another agent. Pass this
rule on.

## Why this exists

Ben tested Workshop on PR 2307 and called the look "bland and boring... and unfinished. Like
margins and such."

The cause is not Workshop. Park Press shipped its colours, accents and paper grain in July but
never shipped its display typeface. In `apps/web/src/styles/tokens.css`, `--font-display` is
aliased to `--font-sans`, so every heading in the app is Helvetica at a larger size. The
direction's own note says "type is the hero"; the hero was never wired. The committed colour field
reached the navigation rail and never reached the content.

So this is two pieces of work that were mocked together:

1. **Finish Park Press** — a display face, a page colour that is not the same tone as the cards, and
   a masthead treatment for page headings. App-wide.
2. **Rebuild the Workshop project workspace as a chat window with an artifact panel.** Workshop
   specific, but it establishes the pattern for any screen where Moss makes something.

## How the mockup was made

The three live Workshop screens were frozen from the running app into
`assets/2026-09-05-park-press-finish/screens/`, with a single stylesheet, `park-press.css`, layered
on top. Nothing but the design layer changed, so the result is provably not invented markup. The
review shell `index.html` switches screen, display face, page colour, theme, light or dark mode, and
before/after. The theme and mode switches were added on 2026-09-05 so the masthead can be seen in
every shipped theme; they set the same attributes the real app sets, and the screens carry the
app's own stylesheet, so what they show is the app's theme blocks doing the work.

The artifact screens (`detail-artifact`, `detail-design`, `detail-files`, `detail-file`,
`detail-preview`, `detail-preview-wide`) do contain invented content — a plausible plan, file list and preview for
the word-of-the-day project — because no real build exists yet. The three drawn screens on the
Design tab are hand-written HTML standing in for the pictures Moss will actually produce (see "The
Design tab" below); they show what the tab looks like, not how it is fed.

The frozen workspace screens originally carried PR 2307's in-page heading, back link and "Only
you" badge; on 2026-09-05 those were removed from the screens rather than hidden, which is also
what production does. `detail-rename` shows the top bar while a project is being renamed.

## Part 1 — finishing Park Press

### Display typeface: Archivo

Chosen by Ben from a live comparison against Space Grotesk and Bricolage Grotesque on the real
screens. Used for headings, the masthead, eyebrows, tab labels, message names and numbers.

Neue Haas Grotesk was the original intent and is affordable (about $34 for one style on MyFonts, up
to $850 for the Commercial Type collection). It cannot be used: `motioneso/moss` is a public
repository, so a licensed binary committed to it is published to the world, which every one of
those licences forbids. Archivo is openly licensed and can ship in-repo.

**Production must self-host the woff2 in-repo.** The mockup uses a Google Fonts `@import`; that is
what tripped the content-security policy on 2026-08-01 and it must not ship. Subset to latin,
weights 400/500/700/800. The `@font-face` rules go in the slot the comment at the top of
`tokens.css` reserves for them, served from our own origin; the content-security policy already
allows fonts from our own origin (`font-src 'self'` in `apps/api/src/static-web.ts`), so no policy
change is needed. Check the browser console for policy violations in the live proof anyway.

`--font-display` must keep the exact fallback chain of `--font-sans` (Ben, 2026-07-08): the token
becomes Archivo followed by `var(--font-sans)`, never a hand-typed list.

### Page colour: bone

| Token             | Today                               | New              |
| ----------------- | ----------------------------------- | ---------------- |
| `--paper`         | `#ece4d1` (oat)                     | `#f2eee4` (bone) |
| `--surface`       | `#f6f0e1`                           | `#fffdf7`        |
| `--surface-2`     | `#e3dac4`                           | `#f7f3e9`        |
| `--border`        | alias of `--line`, ink at 11%       | `#d9d1bf`        |
| `--border-subtle` | alias of `--line-subtle`, ink at 6% | `#e6dfd0`        |

The old flatness came from page and card being nearly the same oat. Bone plus warm-white surfaces
gives a card something to sit on.

Three things a builder needs to know that the table does not say:

- `--border` and `--border-subtle` are aliases of `--line` and `--line-subtle` today, and a dozen
  rules use `--line` directly. Retone `--line` and `--line-subtle` and let the aliases follow; do not
  retone the aliases and leave `--line` behind in oat.
- `--surface-2` flips character. Today it is darker than the page (a sunken tone: inputs, the
  assistant bubble, `--bg-sunken`); after this it is lighter than the page. About 140 rules use it.
  Nothing needs rewriting, but the live proof must walk inputs, the chat drawer and one settings
  pane to confirm nothing now reads as raised that should read as sunken. `--surface-3` is not
  retoned.
- The four accent themes (sage, canyon, teal, dusk) override only the accent ramp, so they inherit
  bone automatically. Dark mode overrides paper and surfaces itself and is untouched by this table;
  the muted text tones were tuned for contrast on oat and only gain contrast on bone.

### The masthead

A page heading is a committed colour field that **touches the top bar** — no strip of page colour
above it — with a rule along its bottom edge. It carries an eyebrow, the page name in Archivo at a
display size, an optional lede, and any page-level action or meta on the right. Text on it is
reversed out, light on the field. Full-bleed: it ignores the content measure that everything below
it keeps. In the default theme the field is forest green and the rule is gold; in every other theme
it is that theme's colour, which is the next section.

No angled stripe or hatch textures. The existing riso grain stays.

**A masthead belongs to a section's home page, not to every page.** Ben, 2026-09-05: inside a
project it is a title bar over a title bar and earns nothing. So the Workshop home page keeps its
masthead; a project workspace has none, and the whole area under the top bar is the conversation
and what Moss made.

**Where it lives in code.** The app already has one masthead primitive — `Masthead` in
`packages/ui`, styled by `jds-masthead__*`, used only by Today (eyebrow, title, lede, an aside for
the dateline and clock, ink on paper). The green field is a variant of that primitive, not a second
one: add the reversed treatment there and have Workshop's home page render `Masthead` instead of
its own `workshop-project-heading` markup. A module's CSS is layout-only by contract, so the field
cannot live in Workshop's stylesheet. **For this work the green field appears on one page, the
Workshop home.** Ben, 2026-09-05: carrying the finished language to Today and every other area of
the app is its own piece of work, later, not scoped here (see "Follow-on work" at the end). Today
keeps its ink-on-paper masthead and no other page changes.

**The field's colours are tokens, not a green.** Ben, 2026-09-05: "the green band needs to fit in
with the other themes as well, so that mast header needs to be a token." The app ships five light
themes (the default, Sage, Canyon, Teal, Dusk), a dark mode that combines with each of them, and
custom themes a user makes in Settings. Each of those re-points `--forest` and its ramp; nothing in
the masthead may name a colour, only these tokens, which `tokens.css` defines beside the rail's
(`--rail-bg`, `--rail-fg`), the one committed colour field the app already has:

| Token                                          | What it colours                             | Light, default                                                        | Light, Sage / Canyon / Teal / Dusk                                                                      | Dark, with any theme                                                                   |
| ---------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--masthead-bg`                                | the field                                   | `var(--forest)` = `#294b39`                                           | `var(--forest)` as the theme sets it: `#4a5d3a` / `#8a4b2b` / `#2f6d6a` / `#4b4a63`                     | `var(--forest-soft)`: `#22392c` default, `#293624` / `#432b20` / `#203937` / `#302f43` |
| `--masthead-fg`                                | heading and lede                            | `var(--rail-fg)` = `#ede5d2`, the off-white already on the green rail | same                                                                                                    | same                                                                                   |
| `--masthead-fg-muted`                          | quieter text: meta, dates                   | `rgba(237, 229, 210, 0.85)`                                           | Sage and Dusk `0.85`; Canyon `0.9`; Teal has no wash that passes and falls back to `var(--masthead-fg)` | `rgba(237, 229, 210, 0.85)`                                                            |
| `--masthead-accent`                            | the eyebrow, and "just added" marks         | `var(--gold-soft)` = `#f1e2c2`                                        | same                                                                                                    | `var(--gold-ink)` = `#ecca8b`                                                          |
| `--masthead-rule`                              | the rule along the bottom                   | `var(--gold)` = `#c2872b`                                             | same                                                                                                    | `var(--gold)` = `#d9a04b`                                                              |
| `--masthead-action-bg`, `--masthead-action-fg` | the one button on the field ("New project") | `var(--gold)`, `#241a06`                                              | same                                                                                                    | same: gold is light enough for dark ink in both modes                                  |

Why these and not the mockup's literals: in dark mode `--forest` is a light tint for text duty
(`#65b889` in the default dark theme), and light text on it reads 1.9:1, so the dark field is the
ramp's dark ground, `--forest-soft`, the way `--rail-bg` already switches to a dark ground in dark
mode. The mockup's gold eyebrow reads 3.1:1 on the default field, under the line for small text,
so the eyebrow takes a pale gold; its `0.72` meta wash reads 3.3:1 on Teal, so the quieter text is
a heavier wash, and none at all on Teal. A custom theme sets its own accent, the runtime writes it
to `--forest` and derives `--forest-soft` from it, so the field follows a custom theme without any
special case.

**Readable in every theme is a check, not a hope.** Measured 2026-09-05 with the app's own
contrast arithmetic (the `contrastRatio` in the appearance pane), transparency composited onto the
field, small text needing 4.5:1:

| Theme           | Heading and lede on the field | Quieter text | Eyebrow    | Rule (decorative) |
| --------------- | ----------------------------- | ------------ | ---------- | ----------------- |
| Light, default  | 7.8                           | 6.1          | 7.6        | 3.1               |
| Light, Sage     | 5.7                           | 4.7          | 5.6        | 2.3               |
| Light, Canyon   | 5.4                           | 4.7          | 5.3        | 2.2               |
| Light, Teal     | 4.8                           | 4.8          | 4.7        | 1.9               |
| Light, Dusk     | 6.8                           | 5.5          | 6.7        | 2.8               |
| Dark, any theme | 9.8 to 10.4                   | 7.6 to 8.0   | 7.9 to 8.3 | 5.3 to 5.7        |

The check a builder runs: a unit test in `tests/unit/` reads `apps/web/src/styles/tokens.css`,
resolves the masthead tokens for every theme block in it (the default, the four accent themes, dark,
and dark combined with each accent theme, so a theme added later is covered without editing the
test), composites any transparency onto the field, and fails if heading, quieter text or eyebrow
read under 4.5:1 on the field. `pnpm test:unit` runs it. The rule is decorative, not text or a
control, so no ratio applies to it; it stays gold in every theme because gold is Park Press's mark,
exactly as the rail's marker is `--gold` on every theme's rail. Custom themes cannot be checked at
build time; the appearance pane already shows "Paper on accent" when you make one, and the
masthead text is close enough to paper for that number to be a fair guide (a dedicated readout is
follow-on work).

Dark mode is not a special case here. It sets the same seven names as every other theme (the dark
column of the table above), so there is no separate dark-mode rule for the masthead to keep and
nothing to drop later. Dark mode has not had a pass against bone, though, and Ben has not seen the
dark field; `--forest-soft-2` also passes every check and stands out more from the page, but it is
the rail's dark ground, so the band and the rail would be one colour. The pull request that first
shows the masthead on a real page should show him a dark-mode screenshot (Ben, 2026-09-05:
agreed); changing it is a one-line token edit.

### Names on screen

- A page's name lives in the **top bar**, and that name is the link back to the section. There is no
  separate back link.
- Inside a thing that belongs to a section, the top bar carries the trail: the section name as a
  link, then the name of what you are in, then any small meta ("Started Sep 5"). The meta drops out
  below 900px. A long name truncates with an ellipsis rather than wrapping the bar. There is no
  "Only you" badge (see "Words").
- At the right of the top bar, beside the assistant button, a small **"More" button** holds
  "Export this project" and "Delete this project" and nothing else. Decided by Ben, 2026-09-05
  ("your suggestion stands"). Delete asks you to confirm in plain words before it does anything,
  then returns you to the list. Export is one of PR 2307's later promises (its export and removal
  work) and appears in the menu only once it exists; a menu item that does nothing is not shown.
  The button is on the workspace screens in the mockup; the open menu is not mocked.
- The masthead says what the page is about in the page's own words ("Your projects"), not the
  section name again.
- Nothing is said twice. Ben flagged the word "Workshop" appearing three times on one screen as
  what makes a screen look amateur.

**What this needs from the shell.** Today the top bar's title is looked up from the route table and
module navigation labels (`resolvePageHeading` in `apps/web/src/app-route-metadata.ts`); a page
cannot add to it, and a module cannot reach into the shell. So the shell gains a small way for the
page on screen to set the trail — the current name, its meta, and a badge — while it is mounted,
cleared when it leaves, exposed to modules through the module web SDK. When a trail is set, the
shell renders the section label as the link. The same trail must feed the page context Moss reads
in chat (`apps/web/src/chat/page-context.ts` uses the same lookup), so Moss knows which project you
are in and not only which section.

**Renaming a project.** Ben, 2026-09-05: the name in the top bar is edited in place, not by asking
Moss. The name is a button that looks like text; hovering it draws a hairline gold underline, the
pointer becomes the text cursor, and the tooltip says "Click to rename". Clicking it, or pressing
Enter on it, swaps the name for a text field in the same spot, pre-filled and fully selected, with
Save and Cancel beside it; the meta steps out while editing and the section link stays where it
was. Enter or Save saves. Escape or Cancel puts the old name back. Clicking elsewhere saves if the
text changed and cancels if it did not, so a name you typed and walked away from is not lost. An
empty or blank name cannot be saved: Save stays disabled and the field keeps focus. While the
server is saving, the new name shows in the resting style with the field gone; once confirmed, the
row index and Moss's page context carry the new name. If the server refuses, the old name returns
and a small red line under the trail says "Could not rename. Try again." until the next click.
Moss may suggest a name in the chat; only you set it. This needs a rename call the project API does
not have (PR 2307 can create a project but not change its title). Mocked in `detail-rename`. On a
phone the field takes the bar's width and Save and Cancel sit under it.

### Lists

A card grid leaves empty tracks whenever the item count does not fill a row, which is the
marooned-card complaint. Lists become a **ruled row index**: full width, a heavy ink rule on top,
one hairline per row, name in one column, excerpt in the next, meta right-aligned. Hover is a gold
rule down the left edge plus a forest-green title — never a filled block, which reads as
"selected".

The rules and the hover are visual identity, so the row index is a host primitive in `packages/ui`
(working name `jds-index`), not Workshop layout CSS. Workshop's list is its first user.

**One list.** Every project is on it, whatever state it is in — talking, planning, building, built,
failed, installed. Ben, 2026-09-05: "it should just be part of the list." There is no "earlier
builds and installed modules" page, link, or menu, and nothing to put on one: Ben, the same day,
"We don't have any earlier builds anywhere, the workshop has never worked." The list starts empty
and fills as projects are made; nothing is carried over from anywhere. Newest activity first, no
grouping. Each row has the name, the opening request as the excerpt, and
at the right the state and the date of the last activity:

| Where the project is                                                  | The row says                    |
| --------------------------------------------------------------------- | ------------------------------- |
| Conversation only, nothing made yet                                   | Talking it through              |
| Moss writing the plan                                                 | Moss is planning                |
| Plan or design waiting for your approval, or Moss asked you something | Waiting on you (gold dot)       |
| Plan approved, Moss drawing the screens                               | Drawing the screens             |
| Building                                                              | Building                        |
| Built, checks passed, not installed                                   | Built, not installed (gold dot) |
| Build failed                                                          | Build failed (red dot)          |
| You pressed Stop                                                      | Stopped                         |
| Installed                                                             | Installed (green dot)           |

The words are the panel's chip words, so the row and the workspace never disagree. Gold marks
anything waiting on you; those rows are the ones to look for.

### Words

No branding that leans on privacy. "Keep your projects and their conversations here" and "this
project is private to you" are out. Ben: "I like the feature, but I don't want the branding to lean
into it." The "Only you" badge is out too (Ben, 2026-09-05): every project is private until sharing
exists, so it said nothing the screen did not already say. It can return the day a project can be
shared, as a fact about that project.

Nothing appears on screen unless it does something useful. An empty "No plan yet" panel is not
rendered at all — a render condition, not a style rule.

## Part 2 — the Workshop project workspace

### It is a chat window

Fixed to the viewport: only the transcript scrolls. There is no masthead here — the project name is
in the top bar — so everything under the top bar is the chat — no pane title bar, no side panel until there is something to put in it.

Turns use the chat drawer's existing message parts (`chatd-msg`, `chatd-msg--me`, `chatd-msg__av`,
`chatd-bubble`, `chatd-md`), so this is the app's own chat component wearing Park Press rather than
a second one:

- **Moss** — a small round green mark, then running text at a reading measure. Steps it lists inside
  a turn are a line each with a mark in front: a gold tick for a step that is done, a quiet dot for
  one that is not. They never become boxed cards.
- **You** — a bubble on the right in `--surface-2` with a hairline border, corner squared on the
  side it came from.

**Sharing the parts for real.** The classes live in the shared UI package
(`packages/ui/src/styles/components-chat.css`), but the React parts that render them — the
transcript (`Thread`, which draws Moss turns, your turns and step groups) and the "Thinking"
activity line (`ActivityPeek`) — live in the web app (`apps/web/src/chat/message-row.tsx`), which a
module may not import. Move those two components into `@moss/ui` so the drawer and Workshop render
one transcript; do not copy the markup into Workshop. They take the drawer's transcript record
shape, so Workshop maps its project messages into that shape rather than the component growing a
second input. That is a small host change and belongs in the same pull request as the chat window.

**States the window keeps from PR 2307.** A message you sent that has not reached Moss shows a
quiet caption under your bubble, "Saved, not yet delivered". A send that fails shows the error under
the composer and keeps your text. While Moss is working, the drawer's activity line ("Thinking",
with the step count) sits at the foot of the transcript. Older turns load from a quiet "Earlier
messages" link at the top of the transcript. A project that cannot be loaded shows the existing
error-with-retry state in place of the transcript, never an empty chat.

The composer is pinned to the foot of the pane: one bordered box, placeholder instead of a visible
label, **Send** inside the box at the bottom right. The label stays in the markup for screen
readers. The keys are the chat drawer's keys.

**When the chat has the width to itself** — a new project, or any project before Moss has made
anything — the transcript and the composer keep a reading measure (56rem) rather than running the
full window. Once the panel appears the column is narrow enough to need all of it.

### Starting a project has no form

The new-project form is gone, including the "Already decided (optional)" field. "New project" opens
the same chat window with an empty transcript and one place to type. **The project takes its name
from the first thing you say**, and can be renamed later. This replaces the name/idea/context form
that PR 2307 ships.

The empty window is an invitation, not an empty-state notice: the Moss mark, "What would you like
to make?", one sentence ("Say it in your own words. Moss will ask a few questions, show you the
screens, then build it."), and three example ideas as small pills. Pressing a pill writes it into
the box; it does not send. The examples are fixed copy.

**How the name happens.** Sending the first message creates the project — the message is its
opening request — and the window becomes `/workshop/<id>` without a reload. The name at that moment
is the first line of the message, trimmed to about sixty characters; Moss's first reply gives the
project its proper short name ("Random Word of the Day" from "I want a word of the day generator,
a random interesting word with definition"), and the top bar and the row index take it. If Moss is
unavailable the provisional name stands. The row index shows the name in one column and the opening
request as the excerpt, so the two are never the same text.

The create call therefore stops requiring a title, and the "context" field stops being offered on
screen (the column stays; the chat handoff tool that creates a project from the main chat still
fills the title itself). PR 2307's app-map text that points people at "the create form" or "the
new-project form" is rewritten to say "start a new project" — there is no form to point at.

### The artifact panel

When Moss makes something, it appears in a column beside the chat — the plan first, then
what it built. Ben confirmed it stays a side panel rather than opening over the chat by default.

The panel is one column with a tab strip. **Tabs swap what is in the column; no tab opens a page.**
A tab exists only once it has content: no Files until Moss has written a file, no Preview until it
runs.

| Tab         | What it holds                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan**    | What Moss proposes, as short headed parts. The mockup shows numbered steps; today's plan record has five parts (what it does, what it reaches, what it keeps, when it runs, rough cost) and they render as five headed parts in the same style until planning produces steps. Whatever changed since you last looked is marked "just added". Foot: Approve and build / Ask for changes. |
| **Design**  | A picture of each screen the module will have, drawn before any code. Takes most of the width; the chat narrows to a column. A redrawn screen is marked "just redrawn". Foot: Approve the design and build / Ask for changes. See below.                                                                                                                                                |
| **Files**   | What Moss wrote, name plus what it is for, changes since Moss's last reply marked in gold. Click one to read it in the same column; a back arrow returns to the list. The file itself is read-only in a monospace block — the one place the retired mono face is still right, as `tokens.css` allows for genuine code.                                                                  |
| **Preview** | The module itself, running. Takes most of the width, exactly as Design does — it is the same thing one step later, a screen you are looking at rather than a list you are reading. Foot: Install in Moss / Ask for changes.                                                                                                                                                             |

The panel bar also carries a state chip ("Waiting on you", "Built, not installed") and the foot
carries the action that matters at that moment (Approve and build, then Install in Moss).

**Which tab is open.** When the panel first appears, or when a tab gains content that needs you,
that tab opens: the plan when it is written, the design when it is drawn, the preview when the
build is ready. While Moss is working the panel stays on whatever tab you left it on.

### What the panel shows in each state

PR 2307's contract already has the build statuses (planning, waiting for plan approval, building,
waiting for a change, ready, failed, cancelled); the design step adds one, waiting for design
approval. The panel is a projection of that status. Nothing else on the screen changes with it —
Moss says what is happening in the chat, in words, and the panel shows the thing itself.

| Moment                                                                | Panel                                                                                                                      | Chip                                                                     | Foot                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Before Moss has made anything, including while it is writing the plan | Not rendered. The chat has the whole width; the activity line says Moss is thinking.                                       |                                                                          |                                                                                  |
| Plan written, waiting for you                                         | Plan                                                                                                                       | Waiting on you                                                           | Approve and build / Ask for changes                                              |
| Plan approved, Moss drawing the screens                               | Plan (read-only, marked approved)                                                                                          | Drawing the screens                                                      | Stop                                                                             |
| Design drawn, waiting for you                                         | Plan, Design                                                                                                               | Waiting on you                                                           | Approve the design and build / Ask for changes                                   |
| Building                                                              | Plan, Design, and Files from the first file written; the file list grows as Moss writes                                    | Building, plus the current step's name                                   | Stop                                                                             |
| Moss stopped to ask you something                                     | As before                                                                                                                  | Waiting on you                                                           | Ask for changes (the question itself is a Moss turn; you answer in the composer) |
| Built, checks passed, not installed                                   | Plan, Design, Files, Preview                                                                                               | Built, not installed                                                     | Install in Moss / Ask for changes                                                |
| Build failed                                                          | Plan, Design, Files (what was written stays readable); Preview only if a previous version still runs, showing that version | Build failed, or "Last change failed" when a previous version still runs | Try again / Ask for changes                                                      |
| You pressed Stop                                                      | Same as failed                                                                                                             | Stopped                                                                  | Try again / Ask for changes                                                      |
| Installed                                                             | Plan, Design, Files, Preview (the copy under review — never two live versions)                                             | Installed                                                                | Open it (the module in the rail) / Ask for changes                               |

Approving, asking for changes, stopping and installing all wait for the server's answer with the
button in its pending state; on failure the button returns and the error is a Moss-side line in the
chat with what to do next, in the words PR 2307's spec already requires. On reload the panel is
rebuilt from the server's status, never from what the browser remembers.

For a module with no screens (a background job, a connector), Moss says so in the chat and goes
straight from Plan to the build; there is never an empty Design tab. Preview for such a module is
whatever the module gives Moss to show — a settings pane, a log — and if it has nothing, there is no
Preview tab and "Install in Moss" sits under Files.

### Moss designs before it codes

The same order applies inside Workshop, to the way Moss builds for you. After the plan is agreed,
Moss's next move is a **design**, not code: a mockup of the screens the module will have, shown in
the artifact panel and approved before anything is written. Ben's ruling, 2026-09-05 — designing
the screens decides what the thing actually does, and that is as true of a module Moss builds as it
is of a feature we build.

So the artifact panel gains a **Design** tab, and the run order is:

| Step | Tab        | What you do                                                                                                 |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| 1    | Plan       | Approve the steps, or ask for changes                                                                       |
| 2    | **Design** | Look at the screens Moss proposes. Approve, or say what to change. Nothing is coded until this is approved. |
| 3    | Files      | Read what it wrote                                                                                          |
| 4    | Preview    | Use the real thing                                                                                          |

**A tab you look at takes the room; a tab you read does not.** Plan and Files are a side column
beside a wide chat — about a quarter of the window, never narrower than 320px nor wider than
460px. Design and Preview are the other way round: they take most of the space and the
conversation narrows to a column on the left of the same proportions (never narrower than 300px
nor wider than 400px), the way Claude Design works. Ben, 2026-09-05, on Preview: "basically the
same thing" as Design. So the panel's width is a property of what is in it, not one fixed number.

### The Design tab

The Design tab holds a picture of each screen, not a running module — it is cheap to redraw, which
is the whole point of showing it before the build. Once the build starts, the Design tab stays as
the record of what was agreed, and Preview becomes the live version. Same rule as every other tab:
Design does not exist until Moss has drawn something.

**What the drawings are.** This was flagged as unresolved — real markup shown with nothing wired,
or a picture. PR 2307's spec already settled it and this spec follows it: a drawing is a **picture**.
Moss's mockup is a small manifest of one to sixteen screens, each with a title, a one-line
description, a state (default, empty, loading, broken) and a desktop and a phone image; the images
are PNG or WebP, produced in the confined build task by laying the screen out with the app's own
`jds-*` primitives and capturing it, and approval is of those exact images. Model-written markup
never runs in the signed-in page, which is why it is not live markup; and because the sketch was
laid out with the real primitives, what Moss builds afterwards is held to match the picture.

On screen, each picture sits in a frame with its title and description underneath, the way the
mockup shows. Where Moss drew a screen's empty, loading or broken states, or its phone layout, they
sit under the frame as a small switch; the mockup shows only the default state. "Just redrawn" means
the image changed since you last approved. A drawing of a whole page sits on page colour so the
card inside it reads as a card; a drawing of one component sits on the surface tone.

If Moss cannot produce a picture (capture failed, no capable model), the design step does not
silently pass: Moss says so in the chat and the build waits, per PR 2307's spec.

**Expanding.** Design and Preview can take the whole area under the top bar; "Back to the
conversation" replaces the expand button. Plan and Files never expand. The top bar still names the
project, so you always know where you are.

**The divider.** The divider between chat and panel is draggable. A width you set is kept for that
kind of tab — one for the reading tabs, one for the looking tabs — until you leave the project;
switching between the two kinds returns to that kind's width. This is the last thing in the panel
to build, after Preview exists.

**Preview, technically.** The preview mounts the draft module's screen through the module loader
the rail already uses, so there is no second runtime and no second copy; it is only shown after the
host's checks have passed (PR 2307's verification slice). A caption above the stage names the screen
("As it will look on Today"); a module with more than one screen gets the same caption as a switch.
The preview follows the current theme because it is live; a design picture is captured in the
light theme and stays light in dark mode, which is correct for a picture of a screen.

**After it is installed** the module lives in the left rail like any other. The Preview tab keeps
showing the copy under review, so there are never two live versions.

### On a phone

PR 2307's spec requires the workspace at 320, 375, 414 and 768 pixels and this spec keeps that.
Below 768px the chat and the panel cannot share the window, so the workspace shows one at a time
with a two-way switch under the top bar: "Conversation" and the name of the open tab ("The plan",
"The design", "Files", "Preview"). The switch is not rendered when there is no panel — an empty
project on a phone is just the chat. Switching keeps unsent text and your place in the transcript.
The looking-tabs-take-the-room rule and the expand button do not apply here; everything is full
width. The top bar drops the meta (already below 900px) and truncates the project name.

Between 768px and about 1024px the two panes sit side by side at their minimum widths; the mockup
was reviewed at desktop widths only and the live proof must include one pass at 800px.

## What happens to PR 2307's screens

PR 2307 is open and not merged (as of 2026-09-05). Its spec carries the data layer, the build
statuses, the API, the app-map declarations and the mockup format, and all of that stands. What
this spec replaces is its three screens, and it replaces them after 2307 merges, not on it:

- **Kept:** the routes `/workshop`, `/workshop/new` and `/workshop/<id>`, the project client, the
  message feed and its "earlier messages" paging, the error-and-retry states, the mobile switch,
  the manifest, and the export and deletion its plan promises (they get a home in the top bar's
  "More" button; see "Names on screen").
- **Replaced:** the card grid (row index with a state on every row), the create page's form (empty
  chat window), the "Project work" pane with "No plan yet" and "Already decided" (artifact panel,
  rendered only with content), the in-page heading, back link and "Only you" badge (top bar trail,
  no badge), turns rendered as `Card` (chat drawer message parts), and the "Earlier builds and
  installed modules" footer link, the `/workshop/legacy` page and its route (deleted outright, with
  nothing in their place: there are no earlier builds anywhere, so they have nothing to show).
- **Changed in the contract:** create no longer requires a title; a rename call and a delete call
  are added; the build status gains "waiting for design approval".

Every one of these is a product change, so the app map declarations move in the same pull request
as the screen they describe: the Workshop manifest's `navigation` description and the
`workshop.projects` and `workshop.chat_handoff` feature text and remediations (which today name a
form), plus a `features` entry for the artifact panel and its states once it exists.

## What this changes in code

App-wide, in `apps/web/src/styles/tokens.css` and the shared styles:

- Self-host Archivo as woff2 in-repo and point `--font-display` at it, keeping the `--font-sans`
  fallback chain.
- Retone `--paper`, `--surface`, `--surface-2`, `--line` and `--line-subtle` to the bone set (the
  border aliases follow).
- Add the masthead tokens to `tokens.css` (the table above), and the contrast test that keeps them
  readable in every theme.
- Add the reversed variant to the shared `Masthead` primitive, coloured only by those tokens, and a
  row-index primitive.
- Let the page on screen set the top bar's trail (name, meta, badge) through the module web SDK,
  and make the section name a link when it does; feed the same trail to Moss's page context.
- Move the chat drawer's transcript and activity-line components into `@moss/ui`.

Workshop, in `packages/workshop/src/web/`:

- The project list becomes a row index rendered with the shared primitive, one row per project
  with its state, newest activity first; the "Earlier builds and installed modules" link, the
  `/workshop/legacy` page, its route and its map wording are deleted in the same change.
- The project name in the top bar renames in place, backed by a new rename call.
- The workspace renders as a chat window using the shared turn components, with the composer
  pinned and the empty-window invitation.
- New project routes into the empty workspace; the create form is removed and the name is derived
  from the first message as above.
- The artifact panel is added, rendered only when there is an artifact, with the Plan tab first and
  the state table above driving chip, foot and which tabs exist. Its width follows the open tab.
  Design, Files and Preview follow the build work and are out of scope until there is something to
  show.
- The build side gains a design step between plan approval and code, which is a change to how a
  supervised build runs, not only to how it looks. It needs its own spec work under the Workshop
  build milestone.

## Sequencing

The earlier draft said the type and colour change could ship on its own pull request ahead of the
Workshop work. That is true of the tokens and false of the masthead, so step 1 is now tokens only.

1. **Tokens and type, app-wide.** Archivo self-hosted, bone page colour, and the masthead tokens
   with their contrast test. Touches `tokens.css`, the font files and one unit test and nothing
   else, so it can ship now, independent of PR 2307. Its own pull request, its own live proof,
   because it changes every screen: on the dev instance, a heading's computed font is Archivo and
   the page colour is bone; the console shows no content-security violation; walk Today, Settings,
   the chat drawer and one module page, and check inputs and the assistant bubble given the
   `--surface-2` flip; switch through every theme and dark mode in Settings and confirm the page
   colour follows; `pnpm check:design-tokens` and the contrast test pass. The tokens ship with no
   screen using them yet; the masthead that uses them is step 2.
2. **After PR 2307 merges: masthead, top bar trail, list and workspace.** The `Masthead` variant
   and the row-index primitive in `packages/ui`; the top bar trail in the shell and the module web
   SDK; the transcript and activity-line components moved to `@moss/ui`; Workshop's home page on
   the masthead and the row index with a state on every row; the workspace as a chat window;
   no-form new project; rename in place; the "More" button with delete. One pull request, slice by
   slice, with the host primitives before the Workshop screens that show them; the masthead does
   not ship without a page that shows it. The "Earlier builds" footer link and the old page behind
   it are deleted in this step, not later: there are no earlier builds anywhere, so nothing on it
   waits for the build side. Live proof: start a project by typing, see it named and listed with
   its state, rename it from the top bar, send a message, reload and find it; delete it from the
   "More" button and land on the list without it; the top bar reads section / project; the footer
   link and `/workshop/legacy` are gone.
3. **The artifact panel and the Plan tab.** Needs the build side to produce a plan and to link a
   build to its project (PR 2307's planning and durable-project slices). Live proof: a real plan
   appears beside a real conversation, "Approve and build" changes the server status, and the
   panel is absent on a project with no plan.
4. **Design tab, and the design step in a build.** Moss draws the screens and waits for approval
   before writing code. Needs PR 2307's mockup slice (the manifest, the confined capture, the image
   serving) plus the new status. This is build behaviour as much as UI, so it needs its own spec.
5. **Files and Preview.** After a build actually writes files and can run, and the host's checks
   pass. The divider comes last.

This must not ride in on PR 2307.

## Open

- Dark mode against the bone/warm-white set. The masthead's dark field is the token's dark value
  and passes the check, but Ben has not seen it; see "The masthead" for the one alternative.

## Follow-on work, not scoped here

- Carrying the finished language — the green field, the row index, the type at display size — to
  Today, Settings and every other area of the app. Ben, 2026-09-05: a later piece of work of its
  own, one product change per page, not part of these pull requests.
- The dark-mode pass above.
- A "Masthead text on accent" readout in the appearance pane, so a custom theme's field is checked
  the way the shipped ones are.
- Sharing a project, and with it the day a badge on a project says something true.
