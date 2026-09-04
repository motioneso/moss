# Scratchpad: a persistent Markdown notepad beside the chat drawer

- Date: 2026-09-04
- Status: draft, awaiting Ben's answers to the open questions below
- Task issue: [#2236](https://github.com/motioneso/moss/issues/2236)
- Related: chat drawer (`apps/web/src/chat/chat-drawer.tsx`), notes module (`packages/notes`)

## Context

Ben asked for a scratchpad: a small notepad window that opens from a pencil button in the top
bar, to the left of the "Chat with Moss" button, and that stays open while he moves around the
app. It is the place to jot a thought, paste a phone number, or keep a running list without
opening the notes module and picking a file. Moss should be able to read what is on it and add
lines to it when asked ("add milk to my scratchpad").

Today the closest thing is the notes module, which mirrors a folder of Markdown files. That is
the right home for durable, titled documents. It is the wrong home for a single always-there
pad: it needs a file name, a folder, and a sync round trip, and it has no fixed spot in the shell.

The chat drawer already solves the "window that survives navigation" problem. Its state lives
in the app shell (`apps/web/src/shell/app-shell.tsx`), it is rendered exactly once, it floats
over the page on desktop and fills the screen on phone. The scratchpad follows that pattern.

## Goals

- One scratchpad per user, private to that user, available on every screen.
- Opens and closes from a pencil icon button in the top bar, immediately left of the chat button.
- Stays open (and keeps its scroll and cursor) while the user navigates between pages.
- Saves itself as the user types. No save button. A small status word shows saved / saving /
  failed.
- Markdown-backed: the stored value is plain Markdown text. The editor shows it with light
  formatting (headings, bold, lists, checkboxes) and never produces anything that is not
  Markdown.
- Keyboard shortcut to toggle it, and the same shortcut works from anywhere in the app.
- Moss can read the scratchpad and append to it through two declared tools.
- Works on phone using the same drawer behaviour as chat: full-screen sheet, one thing at a
  time.
- A size limit, enforced on the server and shown in the editor before the user hits it.

## Non-Goals

- Multiple scratchpads, tabs, or titles. It is one pad.
- Sharing a scratchpad with another user.
- Version history or undo beyond the browser's own undo stack.
- Replacing the notes module. Durable documents still belong there.
- Moss editing or deleting existing scratchpad text. Append only (see decision 6).
- Real-time collaboration or two-browser live sync. Last write wins, with a conflict guard.
- A rich WYSIWYG editor with tables, images, or embeds.

## Resolved Decisions

### 1. Storage is a core-app table, not a notes-module file

The scratchpad is a core shell feature, like the chat drawer, so its data lives in the core
schema as a new owner-only table (`app.scratchpads`, one row per user). It does not create a
file in the notes folder.

Why: the notes module is a required module, but it is still a module. A core shell button that
depends on a module's tables would break module isolation, and it would drag a file-sync round
trip into every keystroke. A single row keyed by user is the simplest thing that survives
navigation, reloads, and other devices.

A later slice may add a "Save to notes" action that hands the current text to the notes module
through its public `notesCreate` tool. That is additive and is not in the first build.

### 2. Markdown text is the stored format; the editor is a thin layer over it

The database column is `body text`. Whatever editor is used, the value that goes to the server
is the Markdown string, and the value that comes back renders the same way in any Markdown
viewer (including the notes module later).

Editor candidates, checked 2026-09-04:

| Library | Gzipped size | Licence | Notes |
| --- | --- | --- | --- |
| Plain `textarea` with a Markdown preview toggle | 0 KB | n/a | No formatting while typing; preview is a second mode. |
| CodeMirror 6 with the Markdown language pack (`@codemirror/lang-markdown`) | about 130 KB | MIT | Syntax-aware, live heading/bold/list styling, keyboard shortcuts, mobile-friendly, tree-shakeable. Value is always the raw text. |
| Milkdown (ProseMirror-based Markdown WYSIWYG) | about 300 KB plus plugins | MIT | True WYSIWYG, but heavier, opinionated CSS that fights the design system, and the Markdown round trip can rewrite the user's text. |
| TipTap with the Markdown extension | about 250 KB | MIT core, some paid extensions | Same WYSIWYG trade-offs as Milkdown; Markdown is an export, not the source of truth. |

Recommendation: CodeMirror 6 with the Markdown language pack. It is MIT, the smallest real
editor that formats as you type, it treats the raw Markdown as the single value, it works on
phones, and its theme is a handful of CSS variables that map straight onto `tokens.css`. The
plain textarea is the fallback if bundle size becomes a concern; the API and storage do not
change between the two.

Loaded lazily: the editor bundle is fetched the first time the scratchpad opens, not on app
load.

### 3. The window lives in the app shell beside the chat drawer

The shell gets a second piece of state, `scratchpadOpen`, next to `chatOpen`. The scratchpad
panel is rendered exactly once, outside the routed page, so route changes never unmount it.
Its text lives in a small store in the shell (loaded once, then kept in memory) so it survives
navigation even mid-save.

On desktop it floats at the same height as the chat drawer, to its left when both are open,
and takes the chat drawer's spot when chat is closed. Both open at once is allowed on screens
wider than 1100px. Narrower than that, opening one closes the other.

On phone it is a full-screen sheet, exactly like chat. Ben's ruling from 2026-08: phone chat
stays a drawer, one thing at a time. Same rule here.

### 4. Autosave with a conflict guard

- The client saves 800 ms after the last keystroke, and on blur, and on close.
- Every save sends the `revision` it loaded. The server bumps the revision on write and
  rejects a save whose revision is stale with `409 scratchpad_conflict` and the current body.
- On conflict the client keeps the user's local text, shows "Changed elsewhere" with a
  "Reload" action, and does not overwrite. This is the only conflict handling in slice 1.

### 5. Keyboard shortcut

`Ctrl/Cmd + Shift + .` toggles the scratchpad. It is registered in the same place as the
command palette shortcut so it works on every page. When the panel opens, focus moves into the
editor. `Esc` inside the editor closes the panel. The shortcut is also listed in the command
palette as "Open scratchpad".

Chosen because `Ctrl/Cmd + .` and `Ctrl/Cmd + K` are already taken in the shell and by
browsers. Confirmed in the open questions in case Ben prefers another key.

### 6. Moss gets a read tool and an append tool, not an edit tool

Two core tools, declared in the core app map and available to chat on every surface:

- `scratchpadRead`: returns the body and a character count.
- `scratchpadAppend`: takes `text` and appends it on a new line at the end. If the last line is a
  list item and the new text is a short phrase, it is added as a matching list item ("add milk
  to my scratchpad" on a pad that ends in `- eggs` becomes `- milk`).

No replace or delete tool. The scratchpad is the user's own working text; a model rewriting
it would be the single most annoying failure this feature could have. If Ben later wants "tidy
my scratchpad", it should be a preview-and-accept flow, which is its own spec.

Append is not a destructive action, so under the installed-means-usable ruling of 2026-08-19 it
does not prompt. The scratchpad panel shows a one-line "Moss added a line" toast when a tool
append lands while the panel is open.

### 7. Size limit

64,000 characters (about 12 pages). The server rejects anything larger with
`413 scratchpad_too_large`. The editor shows a character count once the pad passes 50,000 and
turns it amber past 60,000. The append tool refuses (with a plain message Moss can relay) rather
than truncating.

### 8. Owner-only, no admin bypass

Row level security: a user sees and writes only their own row. Admins have no read path to
another user's scratchpad. Scratchpad text never goes into job payloads, logs, or the
usefulness-feedback capture. It reaches Moss only through the read tool at the moment of a
request, the same way any tool result does.

## Open Questions for Ben

1. Both open at once on desktop: when chat and the scratchpad are both open, should the
   scratchpad sit left of chat (recommended, keeps chat where it is today) or should opening one
   always close the other?
2. Keyboard shortcut: `Ctrl/Cmd + Shift + .` is the recommendation. Any key you would rather
   use?
3. Editor: the recommendation is a real Markdown editor (CodeMirror, about 130 KB, loaded only
   when the pad first opens). If you would rather keep the app lighter, a plain text box with a
   preview switch is the fallback and everything else stays the same.
4. Should the scratchpad also appear in the Today screen as a small card (read-only preview,
   click to open)? Not in this spec; easy to add later if wanted.

## Architecture

### Data model

New core migration `infra/postgres/migrations/0177_scratchpads.sql`:

```sql
CREATE TABLE app.scratchpads (
  user_id     uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  revision    integer NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scratchpads_body_size CHECK (length(body) <= 64000)
);

ALTER TABLE app.scratchpads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scratchpads FORCE ROW LEVEL SECURITY;

CREATE POLICY scratchpads_owner_select ON app.scratchpads FOR SELECT
  USING (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_owner_insert ON app.scratchpads FOR INSERT
  WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_owner_update ON app.scratchpads FOR UPDATE
  USING (user_id = app.current_actor_user_id())
  WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_owner_delete ON app.scratchpads FOR DELETE
  USING (user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.scratchpads TO jarvis_app_runtime;
```

The actor function name must match the one the existing owner-only tables use (check
`0045_auth_secret_rls.sql` and the shares migration before writing the file; do not invent a
new helper). Classification: owner-only. The worker role gets no grant; nothing in the
scratchpad runs in a job. A deleted user takes the row with them (cascade), which also covers
the user-export and account-deletion paths.

No row exists until the user first types or Moss first appends. Reading a missing row returns
an empty body with revision 0.

### API

Core Fastify routes under `/api/scratchpad`, declared in the core route manifest (a route that
is not declared will stop the server from starting). Contracts in
`packages/shared/src/scratchpad-api.ts`.

```ts
// GET /api/scratchpad
type ScratchpadGetResponse = {
  body: string;
  revision: number;        // 0 when no row exists yet
  updatedAt: string | null;
  maxChars: 64000;
};

// PUT /api/scratchpad
type ScratchpadPutRequest = { body: string; revision: number };
type ScratchpadPutResponse = { revision: number; updatedAt: string };
// 409 { code: "scratchpad_conflict", body, revision, updatedAt }
// 413 { code: "scratchpad_too_large", maxChars }

// POST /api/scratchpad/append   (used by the Moss tool; also usable by the UI)
type ScratchpadAppendRequest = { text: string };
type ScratchpadAppendResponse = { revision: number; updatedAt: string; appended: string };
// 413 as above
```

PUT is an upsert: revision 0 with no row inserts; otherwise it is
`UPDATE ... WHERE user_id = $1 AND revision = $2` and a zero row count is a 409. Append is a
single statement that concatenates on the server so two appends cannot lose each other.

### Web

- `apps/web/src/shell/app-shell.tsx`: add `scratchpadOpen` state, the pencil button (Lucide
  `PencilLine`, size 19, `icon-button`, `aria-pressed`, title "Scratchpad") placed before the
  chat button inside `.topbar-actions`, the shortcut, and one `ScratchpadPanel` render outside
  the routed page.
- `apps/web/src/scratchpad/scratchpad-panel.tsx`: header (pencil mark, "Scratchpad", status
  word, close button), the editor, footer with the character count and a "Copy" quiet button.
- `apps/web/src/scratchpad/use-scratchpad.ts`: load once, debounce saves, conflict state,
  in-memory body so navigation never loses text.
- `apps/web/src/scratchpad/scratchpad-editor.tsx`: lazy-loaded CodeMirror wrapper; theme from
  `tokens.css` variables only.
- `apps/web/src/styles/kit-scratchpad.css`: `.scratch`, `.scratch__head`, `.scratch__body`,
  `.scratch__foot` mirroring `kit-chat.css` (`.chatd`). Phone breakpoint matches chat's.
  All colour, radius, shadow and type from tokens; `pnpm check:design-tokens` must pass.

### Moss integration

- App map (`packages/shared/src/app-map-core.ts`): add a `scratchpad` entry to
  `CORE_APP_SCREENS` (label "Scratchpad", description "Your one private notepad, open from the
  pencil in the top bar or Ctrl/Cmd + Shift + .", path `/?scratchpad=open`, scope `user`). The
  path opens the app with the panel open so Moss can send the user there.
- Tools: `scratchpadRead` and `scratchpadAppend` declared alongside the other core tools with
  the descriptions above. Both act as the requesting user through the normal access context and
  call the same service functions as the routes.
- The chat drawer refreshes the scratchpad store after a successful append so the panel
  updates without a reload.

### Testing

- Unit: revision conflict, size limit, append onto a list item vs onto prose, empty-row read.
- RLS test: user A cannot read or update user B's row through the app role; admin cannot either.
- Web e2e (Playwright): open from the button, type, navigate to another page, panel still open
  with text; reload, text persists; shortcut toggles; phone viewport shows the full-screen sheet;
  chat and scratchpad coexistence rule at wide and narrow widths.
- Live-path proof on the dev instance before merge: type on desktop, ask Moss in chat to add a
  line, see it appear; open on a phone-sized window.

## Mockups

Only existing shell classes and `jds-*` primitives. No new visual language; the panel is the chat
drawer's twin.

### Desktop, scratchpad open, chat closed

```
+----------------------------------------------------------------------------------+
| [Moss]  Today                                              [ pencil ] [ chat ]   |
+----------------------------------------------------------------------------------+
| Sidebar |  Page content ...                       +-----------------------------+ |
|         |                                         | (/) Scratchpad     Saved  x | |
| Today   |                                         |-----------------------------| |
| Notes   |                                         | # Errands                   | |
| Sports  |                                         | - eggs                      | |
| ...     |                                         | - milk                      | |
|         |                                         | - call the dentist 555-0134 | |
|         |                                         |                             | |
|         |                                         | Ideas for the sports desk:  | |
|         |                                         | photos next to each story   | |
|         |                                         |                             | |
|         |                                         |-----------------------------| |
|         |                                         | 214 / 64,000        [Copy]  | |
|         |                                         +-----------------------------+ |
+----------------------------------------------------------------------------------+
```

Panel geometry is the chat drawer's: fixed, top 72px, right 18px, bottom 18px, width 404px.
Header uses the same mark / name / status layout as `.chatd__head`; the status word is
"Saved", "Saving...", "Changed elsewhere" (with a Reload link) or "Not saved" in the error tone.

### Desktop, both open (screens wider than 1100px)

```
+----------------------------------------------------------------------------------+
| [Moss]  Today                                              [ pencil*] [ chat* ]  |
+----------------------------------------------------------------------------------+
| Sidebar |  Page ...      +-----------------------+ +-------------------------+   |
|         |                | (/) Scratchpad  Saved x| | (M) Moss              x |   |
|         |                |-----------------------| |-------------------------|   |
|         |                | - eggs                | |  Here when you need me  |   |
|         |                | - milk                | |                         |   |
|         |                |                       | |  > add milk to my       |   |
|         |                |                       | |    scratchpad           |   |
|         |                |                       | |  Added "milk".          |   |
|         |                |-----------------------| |-------------------------|   |
|         |                | 32 / 64,000    [Copy] | | [ Ask Moss...        ] |   |
|         |                +-----------------------+ +-------------------------+   |
+----------------------------------------------------------------------------------+
```

Scratchpad sits at right 440px (chat width plus the gutter). Both buttons show the active state.

### Phone

```
+---------------------------+      +---------------------------+
| = Moss        (/)  (chat) |      | (/) Scratchpad   Saved  x |
|---------------------------|      |---------------------------|
| Today                     |      | # Errands                 |
| ...                       |  ->  | - eggs                    |
|                           |      | - milk                    |
|                           |      |                           |
|                           |      |                           |
|                           |      |---------------------------|
|                           |      | 32 / 64,000        [Copy] |
+---------------------------+      +---------------------------+
```

Full-screen sheet below 560px, same as chat. Opening chat from inside the sheet swaps to chat;
the scratchpad text stays in memory and is there when the user comes back.

## Exit Criteria

- Pencil button is in the top bar left of the chat button on every page, desktop and phone.
- Typing, navigating to three other pages, and reloading loses nothing.
- Saves land within one second of the last keystroke; status word reflects it.
- Two tabs: editing in both produces the "Changed elsewhere" state in the stale one, never a
  silent overwrite.
- "Add milk to my scratchpad" in chat appends a list item and the open panel shows it.
- "What's on my scratchpad?" in chat reads it back.
- A second user cannot read the first user's row through the API or the database app role.
- 64,001 characters is rejected by the server; the count turns amber before that.
- Shortcut toggles from any page and the command palette lists it.
- App map entry present; `pnpm check:design-tokens` clean; live-path proof recorded on the PR.

## Hard Invariants honored

- No admin private-data bypass: owner-only policies, forced RLS, no admin path.
- Private by default: no sharing surface at all.
- Secrets never escape: no secrets involved; body never enters logs or job payloads.
- Metadata-only job payloads: no jobs.
- Vault I/O: none; this is a database row, not a vault file.
- AccessContext unchanged: tools and routes use the existing actor id.
- Provider-agnostic AI: tools are declared capabilities; no model named.
- Module isolation: core feature, own table; the later notes hand-off uses the notes public
  tool only.
- Never edit an applied migration: new file 0177.
- No new required settings or env vars; nothing to configure.
- App map updated in the same PR as the button.

## Slice plan (one session each)

1. **Storage and API.** Migration, contracts file, three routes in the core manifest, service
   functions, unit and RLS tests. No UI.
2. **Panel and shell wiring.** Button, panel, store, autosave, conflict state, shortcut, command
   palette entry, CSS, app map entry, Playwright tests for open/navigate/reload and the phone
   sheet. Uses a plain textarea inside the panel so the slice stands on its own.
3. **Editor.** Swap the textarea for the lazy-loaded CodeMirror Markdown editor with the token
   theme; character count and amber threshold; design-token check.
4. **Moss tools and live proof.** `scratchpadRead`, `scratchpadAppend`, list-item append rule,
   panel refresh after append, the "Moss added a line" toast, live-path proof on dev, merge.

Slices 2 to 4 share one worktree and one PR per the 2026-08-25 ruling; slice 1 can be its own PR
since it ships nothing visible.

## Self-review

- Every screen the feature ships has a mockup above (desktop, both-open, phone).
- Nothing here requires a hand-edited settings file.
- The only judgement calls left are the four open questions; none blocks slice 1.
