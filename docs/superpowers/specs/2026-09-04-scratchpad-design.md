# Scratchpad: a persistent Markdown notepad beside the chat drawer

- Date: 2026-09-04
- Status: ready for build; all open questions answered by Ben on 2026-09-04
- Task issue: [#2236](https://github.com/motioneso/moss/issues/2236)
- Related: chat drawer (`apps/web/src/chat/chat-drawer.tsx`), notes module (`packages/notes`)

## What you will get

1. As a user, I can open a small notepad from a pencil button in the top bar, on every page.
2. As a user, I can open and close it with Cmd/Ctrl + Shift + S, and change that key in Settings.
3. As a user, I can type in it and move between pages or reload without losing a word.
4. As a user, I can see "Saved" or "Saving" so I know my text is safe.
5. As a user, I can keep the notepad and the chat drawer open at once on a desktop; the one I opened last sits on top.
6. As a phone user, I get the notepad as a full-screen sheet, and opening chat closes it.
7. As a user, I can make bullet lists, numbered lists and checkboxes that continue when I press Enter.
8. As a user, I can indent and outdent lines with Tab and Shift+Tab, or with small buttons on my phone.
9. As a user, I can make text bold or italic with Cmd/Ctrl + B and Cmd/Ctrl + I.
10. As a user, I can ask Moss "what is on my scratchpad" and it reads it back.
11. As a user, I can tell Moss "add milk to my scratchpad" and the line appears while I watch.
12. As a user, I am never surprised by Moss rewriting or deleting my notes; it can only add lines.
13. As a user, I can tick one box to also keep a copy as a "Scratchpad" note in my Notes folder.
14. As a user, I get a clear "Changed elsewhere" notice instead of a silent overwrite if I edit in two tabs.
15. As a user, my notepad is private: no other user, and no admin, can read it.

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
- Markdown-backed: the stored value is plain Markdown text. Entry is fast: bullets, numbered
  lists, indent and outdent, bold and italic, and nothing heavier.
- Keyboard shortcut to toggle it, working from anywhere in the app, and changeable in Settings.
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
- A card or preview on the Today screen. Ben's ruling 2026-09-04: the scratchpad is a pocket
  notebook you pull out when you need it, not something on display. It lives only behind the
  pencil button and the shortcut. Moss can still read it at any time (decision 6).

## Resolved Decisions

### 1. Storage is a core-app table, not a notes-module file

The scratchpad is a core shell feature, like the chat drawer, so its data lives in the core
schema as a new owner-only table (`app.scratchpads`, one row per user). It does not create a
file in the notes folder.

Why: the notes module is a required module, but it is still a module. A core shell button that
depends on a module's tables would break module isolation, and it would drag a file-sync round
trip into every keystroke. A single row keyed by user is the simplest thing that survives
navigation, reloads, and other devices.

Ben's ruling 2026-09-04: one pad, stored inside the app by default, plus an optional
checkbox that also mirrors the pad into a "Scratchpad" note in the user's Notes folder. See
decision 9 for how the mirror works and which side wins.

### 2. Markdown text is the stored format; the editor is a plain text box with list helpers

Ben's ruling 2026-09-04: fast entry plus light formatting (bullets, indentation and the like),
and pick the simplest thing that gives that.

Checked 2026-09-04: the notes module has no editor component of its own (it mirrors files on
disk and has no web editing screen), and the app carries no editor library today. Every text
entry in the app is a plain text box. So there is nothing to reuse, and the simplest thing is
to stay with a plain text box and add a small keystroke helper on top of it.

The database column is `body text` holding Markdown. The editor is a standard multi-line text
box styled from `tokens.css`, plus one small helper (about 150 lines, no dependency) that
handles:

- Enter on a line starting with `- `, `* `, `1. ` or `- [ ] ` continues the list on the next
  line; Enter on an empty list line ends the list.
- Tab and Shift+Tab indent and outdent the current line or selected lines by two spaces.
- Ctrl/Cmd + B and Ctrl/Cmd + I wrap the selection in `**` and `_`.
- A short toolbar under the text: bullet, numbered, checkbox, indent, outdent, bold, italic,
  as small quiet icon buttons, mainly for phone where Tab does not exist.

What the user sees is the Markdown itself, with the list markers visible. No live preview and
no rendering while typing. That is a deliberate trade: it keeps the pad instant, keeps the
bundle at zero extra bytes, and the text pastes cleanly anywhere.

Heavier options that were considered and set aside, for the record: CodeMirror 6 with the
Markdown pack (MIT, about 130 KB gzipped, formats as you type) and Milkdown or TipTap (MIT,
250 to 300 KB, true WYSIWYG that rewrites the user's Markdown). If Ben later wants headings and
bold shown as styled text while typing, CodeMirror is the upgrade path; the storage and API do
not change.

### 3. The window lives in the app shell beside the chat drawer, and it is small

The shell gets a second piece of state, `scratchpadOpen`, next to `chatOpen`. The scratchpad
panel is rendered exactly once, outside the routed page, so route changes never unmount it.
Its text lives in a small store in the shell (loaded once, then kept in memory) so it survives
navigation even mid-save.

Ben's ruling 2026-09-04: the scratchpad is a little notepad-sized panel, not a full drawer. On
desktop it is 340px wide and 420px tall, anchored bottom right, above the page and above the
chat drawer's lower corner. The chat drawer and the scratchpad may overlap. Whichever one was
opened most recently sits on top; clicking into the other brings it forward. Both can stay open.

On phone it is a full-screen sheet, exactly like chat, and opening one closes the other. Ben's
ruling from 2026-08: phone chat stays a drawer, one thing at a time. Same rule here.

### 4. Autosave with a conflict guard

- The client saves 800 ms after the last keystroke, and on blur, and on close.
- Every save sends the `revision` it loaded. The server bumps the revision on write and
  rejects a save whose revision is stale with `409 scratchpad_conflict` and the current body.
- On conflict the client keeps the user's local text, shows "Changed elsewhere" with a
  "Reload" action, and does not overwrite. This is the only conflict handling in slice 1.

### 5. Keyboard shortcut, changeable in Settings

Default `Cmd + Shift + S` on a Mac, `Ctrl + Shift + S` on Windows and Linux. Checked
2026-09-04: the only app-level modifier shortcut today is Cmd/Ctrl + K for the command palette
(`apps/web/src/shell/command-palette.tsx`), so this key is free. Ben's ruling 2026-09-04.

The shortcut is registered in the same key handler as the command palette so it works on every
page. When the panel opens, focus moves into the text box. `Esc` inside the text box closes the
panel. The command palette also lists "Open scratchpad" with the current shortcut shown.

The user can change it: the Scratchpad settings section has a shortcut field. Click it, press
the key combination, and it is recorded. The value is stored per user as a small string such as
`mod+shift+s` ("mod" means Cmd on Mac and Ctrl elsewhere). The field refuses a combination with
no modifier, and refuses Cmd/Ctrl + K because the palette owns it. A "Reset to default" link
puts the default back. The handler reads the stored value, so the change applies immediately.

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

### 9. Optional mirror to a "Scratchpad" note in the Notes folder

A checkbox, "Also keep a copy in my Notes folder", off by default. When ticked, every
successful autosave also writes the whole pad to a note called `Scratchpad.md` at the top of
the user's notes folder, through the notes module's public `notesCreate` tool in overwrite mode.
The scratchpad never imports the notes module's code or reads its tables; it calls the declared
tool as the user, with the user's own `notes.create` permission.

Conflict rule: the app copy wins. The note is a mirror, not a second editor. If the note file is
edited outside the app, that edit lives until the next autosave, which overwrites it. The
scratchpad never reads the note back. This is stated in the checkbox's help text so nobody is
surprised: "The app copy is the master. Edits made to the note file are replaced on the next
save."

Why app-wins and not merge: a two-way merge between a database row and a file that the notes
sync job rewrites on its own schedule is exactly the kind of quiet data loss this feature exists
to avoid. One direction, always the same direction, is predictable.

The checkbox is shown greyed out with "Set up a notes folder first" (linking to the notes
module's settings) until the notes module reports a configured folder. That signal comes from
the notes module's public status, never from its tables; if no such status is declared today,
the sync slice adds it to the notes manifest as a public API.

The mirror write is best effort: if it fails, the pad still saves, the status word stays
"Saved", and a small "Copy to Notes failed" line appears under it with the reason the notes tool
gave. Unticking the box stops future writes and leaves the existing note alone.

The checkbox lives in two places that read and write the same setting: the pad's own menu
(three-dot button in the panel header) and Settings, in a new "Scratchpad" section.

## Open Questions for Ben

None left. Answered 2026-09-04 and folded in above: one pad with the optional Notes copy
(decisions 1 and 9), editor choice (decision 2), placement beside the chat drawer (decision 3),
shortcut and its Settings field (decision 5), and no Today card (Non-Goals). Moss reading the
pad on request stays in (decision 6).

## Architecture

### Data model

New core migration `infra/postgres/migrations/0177_scratchpads.sql`:

```sql
CREATE TABLE app.scratchpads (
  user_id     uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  body        text NOT NULL DEFAULT '',
  revision    integer NOT NULL DEFAULT 1,
  sync_to_notes boolean NOT NULL DEFAULT false,
  shortcut    text NOT NULL DEFAULT 'mod+shift+s',
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
  revision: number; // 0 when no row exists yet
  updatedAt: string | null;
  maxChars: 64000;
  syncToNotes: boolean;
  notesFolderConfigured: boolean; // from the notes module's public status
  shortcut: string; // e.g. "mod+shift+s"
};

// PATCH /api/scratchpad/settings
type ScratchpadSettingsRequest = { syncToNotes?: boolean; shortcut?: string };
type ScratchpadSettingsResponse = { syncToNotes: boolean; shortcut: string };
// 409 { code: "scratchpad_notes_folder_missing" } when turning the copy on without a folder
// 400 { code: "scratchpad_shortcut_invalid" } for no modifier, or a reserved key (mod+k)

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

After any successful PUT or append, if `sync_to_notes` is true, the service calls the notes
module's public `notesCreate` tool with path `Scratchpad.md`, the full body, and overwrite on.
Failures are returned in the save response as `notesMirror: { ok: false, reason }` and never
fail the save itself.

### Web

- `apps/web/src/shell/app-shell.tsx`: add `scratchpadOpen` state, the pencil button (Lucide
  `PencilLine`, size 19, `icon-button`, `aria-pressed`, title "Scratchpad") placed before the
  chat button inside `.topbar-actions`, the shortcut, and one `ScratchpadPanel` render outside
  the routed page.
- `apps/web/src/scratchpad/scratchpad-panel.tsx`: header (pencil mark, "Scratchpad", status
  word, "Ask Moss" button, three-dot menu button, close button), the editor, footer with the
  character count. The "Ask Moss" button is a very small quiet icon button showing only a
  question mark (title "Ask Moss about this"). It is hidden until the pointer hovers over the
  pad; on touch screens, which have no hover, it shows while the pad has focus. Pressing it
  opens the chat drawer with the pad text prefilled as an editable message; nothing is sent
  until the user sends it. Ruled by Ben 2026-09-04. The menu is the `jds` menu primitive with a
  checkbox item, "Also keep a copy in my Notes folder", a "Copy all" item, a "Clear" item
  (confirmed in a `jds` dialog first) and an "Open Settings" item.
- Settings: a new "Scratchpad" section (`/settings?section=scratchpad`) with the same checkbox
  and its help text, and the keyboard shortcut field with a reset link, built from the existing
  settings-ui field and card primitives.
- `apps/web/src/scratchpad/use-scratchpad.ts`: load once, debounce saves, conflict state,
  in-memory body so navigation never loses text.
- `apps/web/src/scratchpad/scratchpad-editor.tsx`: the text box, the list and indent key
  helper, and the small toolbar; styled from `tokens.css` only, no dependency.
- `apps/web/src/scratchpad/shortcut.ts`: parse and match the stored shortcut string against a
  key event; shared by the shell handler, the palette label, and the Settings field.
- `apps/web/src/styles/kit-scratchpad.css`: `.scratch`, `.scratch__head`, `.scratch__body`,
  `.scratch__foot` mirroring `kit-chat.css` (`.chatd`). Phone breakpoint matches chat's.
  All colour, radius, shadow and type from tokens; `pnpm check:design-tokens` must pass.

### Moss integration

- App map (`packages/shared/src/app-map-core.ts`): add a `scratchpad` entry to
  `CORE_APP_SCREENS` (label "Scratchpad", description "Your one private notepad, open from the
  pencil in the top bar or Cmd/Ctrl + Shift + S", path `/?scratchpad=open`, scope `user`). The
  path opens the app with the panel open so Moss can send the user there.
- App map settings: add a `scratchpad` entry to `CORE_APP_SETTINGS` (label "Scratchpad",
  description "Change the keyboard shortcut that opens your scratchpad, and choose whether it is
  also kept as a note in your Notes folder", path `/settings?section=scratchpad`, scope `user`).
  The screen entry's description names the default shortcut, Cmd/Ctrl + Shift + S.
- Tools: `scratchpadRead` and `scratchpadAppend` declared alongside the other core tools with
  the descriptions above. Both act as the requesting user through the normal access context and
  call the same service functions as the routes.
- The chat drawer refreshes the scratchpad store after a successful append so the panel
  updates without a reload.

### Testing

- Unit: revision conflict, size limit, append onto a list item vs onto prose, empty-row read,
  list continuation and indent helper, shortcut parse and reject rules,
  mirror write called only when the setting is on, mirror failure does not fail the save.
- RLS test: user A cannot read or update user B's row through the app role; admin cannot either.
- Web e2e (Playwright): open from the button, type, navigate to another page, panel still open
  with text; reload, text persists; shortcut toggles; phone viewport shows the full-screen sheet;
  chat and scratchpad overlap with the most recently opened on top; on the phone viewport
  opening chat closes the scratchpad and back again.
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
| Sidebar |  Page content ...                                                      |
|         |                                                                        |
| Today   |                                                                        |
| Notes   |                                                                        |
| Sports  |                                                                        |
| ...     |                                                                        |
|         |                                  +----------------------------------+  |
|         |                                  | (/) Scratchpad   Saved  ? ...  x |  |
|         |                                  |----------------------------------|  |
|         |                                  | # Errands                        |  |
|         |                                  | - eggs                           |  |
|         |                                  | - milk                           |  |
|         |                                  |   - the oat kind                 |  |
|         |                                  | - call the dentist 555-0134      |  |
|         |                                  |                                  |  |
|         |                                  |----------------------------------|  |
|         |                                  | [-] [1.] [x] [<] [>] [B] [I]     |  |
|         |                                  | 74 / 64,000                      |  |
|         |                                  +----------------------------------+  |
+----------------------------------------------------------------------------------+
```

Panel is fixed, bottom 18px, right 18px, 340px wide, 420px tall, and can be dragged taller
from its top edge (height remembered in the browser). Header uses the same mark / name /
status layout as `.chatd__head`; the status word is "Saved", "Saving...", "Changed elsewhere"
(with a Reload link) or "Not saved" in the error tone. The "?" is the Ask Moss button: it is
only drawn while the pointer is over the pad (or, on touch, while the pad has focus), so the
header normally reads "(/) Scratchpad Saved ... x". The toolbar row is quiet icon
buttons: bullet, numbered, checkbox, outdent, indent, bold, italic.

### Pad menu open (three-dot button)

```
+-----------------------------+
| (/) Scratchpad  Saved ? ... x |
|          +------------------------------------------+
|          | [x] Also keep a copy in my Notes folder  |
|          |     The app copy is the master. Edits    |
|          |     made to the note file are replaced   |
|          |     on the next save.                    |
|          |------------------------------------------|
|          | Copy all                                 |
|          | Clear...                                 |
|          |------------------------------------------|
|          | Open Settings                            |
|          +------------------------------------------+
| - eggs                      |
```

When no notes folder is configured the checkbox is disabled and the help line reads
"Set up a notes folder first" with a link to the Notes settings. "Clear..." opens a confirm
dialog before emptying the pad. "Ask Moss about this" is not a menu item: it is the hover-only
"?" button in the header (Ben, 2026-09-04).

### Settings, Scratchpad section

```
+-----------------------------------------------------------------+
| Settings > Scratchpad                                           |
|-----------------------------------------------------------------|
| Keyboard shortcut                                               |
| [ Cmd + Shift + S        ]  Reset to default                    |
|   Click the field, then press the keys you want.                |
|                                                                 |
| Notes folder copy                                               |
| [x] Also keep a copy in my Notes folder                         |
|     Writes the whole pad to a note called "Scratchpad" every    |
|     time it saves. The app copy is the master. Edits made to    |
|     the note file are replaced on the next save.                |
+-----------------------------------------------------------------+
```

### Desktop, both open, scratchpad opened last

```
+----------------------------------------------------------------------------------+
| [Moss]  Today                                              [ pencil*] [ chat* ]  |
+----------------------------------------------------------------------------------+
| Sidebar |  Page ...                                +-------------------------+   |
|         |                                          | (M) Moss              x |   |
|         |                                          |-------------------------|   |
|         |                                          |  > add milk to my       |   |
|         |                                          |    scratchpad           |   |
|         |                                          |  Added "milk".          |   |
|         |                            +----------------------------------+    |   |
|         |                            | (/) Scratchpad     Saved  ...  x |    |   |
|         |                            |----------------------------------|    |   |
|         |                            | - eggs                           |    |   |
|         |                            | - milk                           |    |   |
|         |                            |----------------------------------|    |   |
|         |                            | [-] [1.] [x] [<] [>] [B] [I]     |----+   |
|         |                            | 32 / 64,000               [Copy] |        |
|         |                            +----------------------------------+        |
+----------------------------------------------------------------------------------+
```

The two overlap. The one opened most recently is on top; clicking into the other brings it
forward. Both buttons show the active state.

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

Full-screen sheet below 560px, same as chat. The toolbar row sits above the keyboard. Opening
chat closes the scratchpad sheet, and opening the scratchpad closes chat; the scratchpad text
stays in memory and is there when the user comes back.

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
- Shortcut toggles from any page and the command palette lists it; changing it in Settings
  takes effect without a reload and rejects a bare key or Cmd/Ctrl + K.
- Enter continues a bullet, Tab indents it, Shift+Tab outdents it, on desktop; the toolbar
  does the same on phone.
- With the Notes copy ticked, a save produces or updates `Scratchpad.md` in the notes folder
  with the same text; editing that file by hand and saving the pad again overwrites the file.
- The checkbox is disabled with a clear message when no notes folder is configured; the pad
  menu and the Settings section always show the same value.
- App map entries present (screen and setting); `pnpm check:design-tokens` clean; live-path
  proof recorded on the PR.

## Hard Invariants honored

- No admin private-data bypass: owner-only policies, forced RLS, no admin path.
- Private by default: no sharing surface at all.
- Secrets never escape: no secrets involved; body never enters logs or job payloads.
- Metadata-only job payloads: no jobs.
- Vault I/O: the pad itself is a database row. The optional Notes copy is written by the notes
  module's own tool, which already goes through `VaultContext`; the scratchpad never touches
  the filesystem.
- AccessContext unchanged: tools and routes use the existing actor id.
- Provider-agnostic AI: tools are declared capabilities; no model named.
- Module isolation: core feature, own table; the Notes copy uses the notes module's declared
  `notesCreate` tool and public status only, never its code or tables.
- Never edit an applied migration: new file 0177.
- No new required settings or env vars; nothing to configure.
- App map updated in the same PR as the button.

## Slice plan (one session each)

1. **Storage and API.** Migration, contracts file, three routes in the core manifest, service
   functions, unit and RLS tests. No UI.
2. **Panel and shell wiring.** Button, panel, store, autosave, conflict state, shortcut, command
   palette entry, CSS, app map entry, Playwright tests for open/navigate/reload and the phone
   sheet. Uses a plain textarea inside the panel so the slice stands on its own.
3. **Entry helpers and shortcut setting.** The list-continuation and indent key helper, the
   toolbar, bold and italic keys, character count and amber threshold, the shortcut field in
   Settings with the parse and reject rules, design-token check.
4. **Moss tools.** `scratchpadRead`, `scratchpadAppend`, list-item append rule, panel refresh
   after append, the "Moss added a line" toast.
5. **Notes copy and live proof.** The `sync_to_notes` column and settings route, the mirror
   write through `notesCreate`, the notes-folder-configured status (adding it to the notes
   manifest if missing), the pad menu checkbox, the rest of the Settings section, the app map settings entry,
   live-path proof on dev of typing, a Moss append, and the note file updating, then merge.

Slices 2 to 5 share one worktree and one PR per the 2026-08-25 ruling; slice 1 can be its own PR
since it ships nothing visible. The `sync_to_notes` and `shortcut` columns ship in slice 1's
migration so no second migration is needed.

## Self-review

- Every screen the feature ships has a mockup above (desktop, pad menu, Settings section,
  both-open, phone).
- Nothing here requires a hand-edited settings file.
- No open questions remain; every slice can start.
