# Design: finishing Park Press, and the Workshop project workspace

Status: approved by Ben 2026-09-05 ("Ok, write this up, looks great!")
Direction: PARK PRESS, approved 2026-07-03 — `2026-07-03-park-press-design-language-design.md`, EPIC #726
Mockup: `docs/superpowers/specs/assets/2026-09-05-park-press-finish/`

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
review shell `index.html` switches screen, display face, page colour, and before/after.

The artifact screens (`detail-artifact`, `detail-design`, `detail-files`, `detail-file`,
`detail-preview`, `detail-preview-wide`) do contain invented content — a plausible plan, file list and preview for
the word-of-the-day project — because no real build exists yet.

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
weights 400/500/700/800.

`--font-display` must keep the exact fallback chain of `--font-sans` (Ben, 2026-07-08).

### Page colour: bone

| Token | Today | New |
| --- | --- | --- |
| `--paper` | `#ece4d1` (oat) | `#f2eee4` (bone) |
| `--surface` | | `#fffdf7` |
| `--surface-2` | | `#f7f3e9` |
| `--border` | | `#d9d1bf` |
| `--border-subtle` | | `#e6dfd0` |

The old flatness came from page and card being nearly the same oat. Bone plus warm-white surfaces
gives a card something to sit on. Dark mode is unchanged by this spec and needs its own pass.

### The masthead

A page heading is a committed green field that **touches the top bar** — no strip of page colour
above it — with a gold rule along its bottom edge. It carries an eyebrow, the page name in Archivo
at a display size, an optional lede, and any page-level action or meta on the right. Text on it
uses the reversed palette (`#fbf7ec` heading, `rgba(244,239,226,0.72)` meta, translucent light
badge with a gold dot). Full-bleed: it ignores the content measure that everything below it keeps.

No angled stripe or hatch textures. The existing riso grain stays.

**A masthead belongs to a section's home page, not to every page.** Ben, 2026-09-05: inside a
project it is a title bar over a title bar and earns nothing. So the Workshop home page keeps its
masthead; a project workspace has none, and the whole area under the top bar is the conversation
and what Moss made.

### Names on screen

- A page's name lives in the **top bar**, and that name is the link back to the section. There is no
  separate back link.
- Inside a thing that belongs to a section, the top bar carries the trail: the section name as a
  link, then the name of what you are in, then any small meta ("Started Sep 5"). The "Only you"
  badge moves to the top bar's right, beside the assistant button, and both meta and badge drop out
  below 900px.
- The masthead says what the page is about in the page's own words ("Your projects"), not the
  section name again.
- Nothing is said twice. Ben flagged the word "Workshop" appearing three times on one screen as
  what makes a screen look amateur.

### Lists

A card grid leaves empty tracks whenever the item count does not fill a row, which is the
marooned-card complaint. Lists become a **ruled row index**: full width, a heavy ink rule on top,
one hairline per row, name in one column, excerpt in the next, meta right-aligned. Hover is a gold
rule down the left edge plus a forest-green title — never a filled block, which reads as
"selected".

### Words

No branding that leans on privacy. "Keep your projects and their conversations here" and "this
project is private to you" are out. The "Only you" badge already says it. Ben: "I like the feature,
but I don't want the branding to lean into it."

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
  a turn get gold ticks rather than becoming boxed cards.
- **You** — a bubble on the right in `--surface-2` with a hairline border, corner squared on the
  side it came from.

The composer is pinned to the foot of the pane: one bordered box, placeholder instead of a visible
label, **Send** inside the box at the bottom right. The label stays in the markup for screen
readers.

**When the chat has the width to itself** — a new project, or any project before Moss has made
anything — the transcript and the composer keep a reading measure rather than running the full
window. Once the panel appears the column is narrow enough to need all of it.

### Starting a project has no form

The new-project form is gone, including the "Already decided (optional)" field. "New project" opens
the same chat window with an empty transcript and one place to type. **The project takes its name
from the first thing you say**, and can be renamed later. This replaces the name/idea/context form
that PR 2307 ships.

### The artifact panel

When Moss makes something, it appears in a column beside the chat — the plan first, then
what it built. Ben confirmed it stays a side panel rather than opening over the chat by default.

The panel is one column with a tab strip. **Tabs swap what is in the column; no tab opens a page.**
A tab exists only once it has content: no Files until Moss has written a file, no Preview until it
runs.

| Tab | What it holds |
| --- | --- |
| **Plan** | Numbered steps, each a title and a sentence. Newest step marked "just added". Foot: Approve and build / Ask for changes. |
| **Design** | A picture of each screen the module will have, drawn before any code. Takes most of the width; the chat narrows to a column. A redrawn screen is marked "just redrawn". Foot: Approve the design and build / Ask for changes. See below. |
| **Files** | What Moss wrote, name plus what it is for, changes since your last look marked in gold. Click one to read it in the same column; a back arrow returns to the list. |
| **Preview** | The module itself, running. Takes most of the width, exactly as Design does — it is the same thing one step later, a screen you are looking at rather than a list you are reading. Foot: Install in Moss / Ask for changes. |

The panel bar also carries a state chip ("Waiting on you", "Built, not installed") and the foot
carries the action that matters at that moment (Approve and build, then Install in Moss).

### Moss designs before it codes

The same order applies inside Workshop, to the way Moss builds for you. After the plan is agreed,
Moss's next move is a **design**, not code: a mockup of the screens the module will have, shown in
the artifact panel and approved before anything is written. Ben's ruling, 2026-09-05 — designing
the screens decides what the thing actually does, and that is as true of a module Moss builds as it
is of a feature we build.

So the artifact panel gains a **Design** tab, and the run order is:

| Step | Tab | What you do |
| --- | --- | --- |
| 1 | Plan | Approve the steps, or ask for changes |
| 2 | **Design** | Look at the screens Moss proposes. Approve, or say what to change. Nothing is coded until this is approved. |
| 3 | Files | Read what it wrote |
| 4 | Preview | Use the real thing |

**A tab you look at takes the room; a tab you read does not.** Plan and Files are a side column
beside a wide chat. Design and Preview are the other way round: they take most of the space and the
conversation narrows to a column on the left, the way Claude Design works. Ben, 2026-09-05, on
Preview: "basically the same thing" as Design.

**The design takes the room, and the chat gives it up.** While you are still talking about the
project the chat is full width. When it is time to design, the drawing appears and takes most of the
space on the right, and the conversation moves to a narrow column on the left — the way Claude
Design works. So the panel's width is a property of what is in it, not one fixed number: the Plan
tab is a side column beside a wide chat; the Design tab is the other way round.

The Design tab holds a picture of each screen, not a running module — it is cheap to redraw, which
is the whole point of showing it before the build. Once the build starts, the Design tab stays as
the record of what was agreed, and Preview becomes the live version. Same rule as every other tab:
Design does not exist until Moss has drawn something.

For a module with no screens (a background job, a connector), Moss says so and goes straight from
Plan to the build rather than showing an empty Design tab.

**Expanding.** The preview can take the whole area under the top bar; "Back to the conversation"
replaces the expand button. The top bar still names the project, so you always know where you are. The
divider between chat and panel is draggable.

**After it is installed** the module lives in the left rail like any other. The Preview tab keeps
showing the copy under review, so there are never two live versions.

## What this changes in code

App-wide, in `apps/web/src/styles/tokens.css` and the shared styles:

- Self-host Archivo as woff2 in-repo and point `--font-display` at it, keeping the `--font-sans`
  fallback chain.
- Retone `--paper`, `--surface`, `--surface-2`, `--border`, `--border-subtle` to the bone set.
- Add the masthead treatment to the shared page-heading pattern, on section home pages only.
- Make the top-bar page name a link back to its section, and let a page inside a section add its own
  name, meta and a badge to that bar.

Workshop, in `packages/workshop/src/web/`:

- The project list becomes a ruled row index; the "Earlier builds and installed modules" footer link
  moves out of the page foot (account menu or an overflow beside "New project" — still to decide).
- `project-pages.tsx` renders the workspace as a chat window using the chat drawer's message parts,
  with the composer pinned.
- New project routes into the empty workspace; the create form is removed and the name is derived
  from the first message.
- The artifact panel is added, rendered only when there is an artifact, with the Plan tab first. Its
  width follows the open tab: a side column for Plan and Files, most of the width for Design and
  Preview. Design, Files and Preview follow the build work and are out of scope until there is something to
  show.
- The build side gains a design step between plan approval and code, which is a change to how a
  supervised build runs, not only to how it looks. It needs its own spec work under the Workshop
  build milestone.

Every one of these is a product change, so the app map declarations move in the same pull request.

## Sequencing

1. **Tokens and type, app-wide.** Archivo self-hosted, bone page colour, masthead. Its own pull
   request, its own live proof, because it changes every screen.
2. **Workshop list and workspace.** Row index, chat window, no-form new project.
3. **The artifact panel, Plan tab.** Needs the build side to produce a plan first.
4. **Design tab, and the design step in a build.** Moss draws the screens and waits for approval
   before writing code. This is build behaviour as much as UI, so it needs its own spec.
5. **Files and Preview.** After a build actually writes files and can run.

This must not ride in on PR 2307.

## Open

- Where "Earlier builds and installed modules" goes.
- Dark mode against the bone/warm-white set.
- Whether a project can be renamed from the masthead, given the name now comes from the first
  message.
