# Scratchpad build plan

Spec: `docs/superpowers/specs/2026-09-04-scratchpad-design.md` (PR 2238, approved by Ben in chat
2026-09-04). Task issue: #2236.

Written for the agent who builds it, not for the person reading status. Chat, PR comments and
handoffs stay in plain English with ASCII punctuation (see the box-wide CLAUDE.md rule).

## How this plan differs from the spec

Two things the seams check found that the spec got wrong. The spec's user-facing behaviour is
unchanged; only where the code lives moves.

1. **The scratchpad is a built-in module package, not core code.** The spec puts the table in
   `infra/postgres/migrations/0177_...` and says the Moss tools are "declared alongside other core
   tools". The tree has no core tool list: every assistant tool comes from a module manifest
   (`packages/ai/src/assistant-tools.ts:7`), and built-in features such as Settings, Notes and Tasks
   are packages with a manifest registered in `BUILT_IN_MODULES`
   (`packages/module-registry/src/index.ts:1349`) and their own `sql/` directory. CLAUDE.md: module
   SQL lives in the owning module's `sql/`, never in `infra/postgres/migrations/`. So: new package
   `packages/scratchpad`, table still `app.scratchpads`.
2. **Migration numbers are one sequence across every `sql/` directory.** Latest file anywhere is
   `packages/sports/sql/0213_sports_reddit_sources.sql`, not 0176. The scratchpad migration is
   `packages/scratchpad/sql/0214_scratchpads.sql`. The builder re-checks the highest number at
   build time (command in Slice 1) because other lanes are merging.

## Seams check

Every platform capability the spec assumes, with where it exists today.

| Capability assumed                          | Where it is                                                                                                                                                                                                                                                                                                    | What it means for the build                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A shell-level panel outside the routed page | `apps/web/src/shell/app-shell.tsx:69` `const [chatOpen, setChatOpen] = useState(false);`, `:20` ChatDrawer import, `:294-302` exactly one `<ChatDrawer open={chatOpen} ...>` (issue #1756)                                                                                                                     | Scratchpad panel is a sibling of ChatDrawer with the same open-state pattern. One element, ever.                                                                                                                           |
| Global keyboard shortcut handling           | `apps/web/src/shell/command-palette.tsx:154-155` `document.addEventListener("keydown", onKeyDown, { capture: true })`; `:452-460` palette matches `(metaKey \|\| ctrlKey) && (key === "k" \|\| code === "KeyK")`                                                                                               | Same pattern: a capture-phase keydown listener owned by the shell. Cmd/Ctrl+K is the only existing app shortcut, so Cmd/Ctrl+Shift+S is free.                                                                              |
| Personal settings sections                  | `apps/web/src/settings/settings-page.tsx:148-195` hardcoded section ids (`profile`, `appearance`, ..., `released`), `:249` `PERSONAL_SECTIONS`, `:376` `searchParams.get("section")`                                                                                                                           | Settings sections are a hardcoded list in the web app, not read from manifests. Add `scratchpad` to that list with its own pane file. The manifest `settings` entry exists for the app map only.                           |
| App map declarations                        | `packages/shared/src/app-map-core.ts:41` `CORE_APP_SCREENS`, `:70` `CORE_APP_SETTINGS`; module manifests carry `navigation`, `settings`, `features` (`packages/module-sdk/src/index.ts:659-676`)                                                                                                               | Because the scratchpad is a module, its screen, setting and feature live in the manifest, not in app-map-core.                                                                                                             |
| Notes folder configured signal              | `packages/settings/src/notes-source-routes.ts:160,175` GET and `:192` PUT `/api/me/notes-source`, declared at `packages/settings/src/manifest.ts:233,243`                                                                                                                                                      | "Notes folder configured" = that route returns a folder. The scratchpad module must not read the settings module's tables; it calls a service (decision below).                                                            |
| Writing a note file                         | `packages/notes/src/manifest.ts:111-131` tool `notes.create` (`requiresServices: ["notesSync"]`, `requiresConfirmation: input.overwrite === true`); `packages/chat/src/gateway-services.ts:88` `services.notesSync`; `packages/notes/src/daily-archive-writer.ts:44,85` `notesSync.enqueue(actorUserId, root)` | The daily archive writer already writes a file into the notes root from server code and enqueues a sync. The mirror follows that pattern, not the `notes.create` tool (see open question 1).                               |
| Moss tool exposure                          | `packages/module-sdk/src/index.ts:573` `ModuleAssistantToolManifest`, `:143` `ToolExecute`; `packages/ai/src/gateway/gateway.ts:696-712` `executeTool` runs `found.execute(scopedDb, input, ctx, services)` inside `runner.withDataContext(access, ...)`; read tools pass `readToolTrustBoundary`              | Declare `scratchpad.read` (risk `read`) and `scratchpad.append` (risk `write`, `executionPolicy: "auto"`, `selfOperationGrant: "granted_at_install"`) in the manifest. Their `execute` uses the scoped db, so RLS applies. |
| Routes must be declared                     | `packages/module-registry/src/route-guard.ts:153,214,220` fails start-up for routes not in any manifest `routes[]` and for declared routes never registered                                                                                                                                                    | Every scratchpad route appears in the manifest `routes` list (`packages/module-sdk/src/index.ts:434` shape) and is registered by `registerRoutes` in `BUILT_IN_MODULES`.                                                   |
| Module database block                       | `packages/tasks/src/manifest.ts:257-263` `database: { migrations: ["sql/0003_tasks_module.sql", ...], ownedTables: [...] }`; `packages/module-registry/src/index.ts:1502` `sqlMigrationDirectories: [tasksModuleSqlMigrationDirectory]`                                                                        | Copy the tasks shape: one migration file listed in `database.migrations`, `ownedTables: ["app.scratchpads"]`, directory exported from the package and listed in the registration.                                          |
| RLS convention                              | `app.current_actor_user_id()` used in 37 migrations, grants to `jarvis_app_runtime` (6 files, last `infra/postgres/migrations/0109`)                                                                                                                                                                           | Four owner policies plus `FORCE ROW LEVEL SECURITY` and a grant to `jarvis_app_runtime`. No `BYPASSRLS`.                                                                                                                   |
| RLS tests                                   | `tests/integration/auth-accounts-write-rls.test.ts` (vitest, `createDatabase` from `@moss/db`, `resetEmptyFoundationDatabase` from `./test-database.js`; `:45` `it("jarvis_app_runtime is denied writing to app.auth_accounts")`)                                                                              | `tests/integration/scratchpad-rls.test.ts` follows this file. The comment there says a superuser bypasses FORCE RLS, so tests run as the runtime role.                                                                     |
| Browser tests with a fake API               | `tests/e2e/mock-api.ts:163` `export async function mockApi(page, state: MockApiState)`; `MockApiState` keys are per-feature (`tasks`, `chatMessages`, `notifications`, ...) ; `tests/e2e/app-shell.spec.ts` imports `mockApi`, `createMockUser`                                                                | Add optional `scratchpad?` state to `MockApiState` and route the four scratchpad endpoints in `mockApi`.                                                                                                                   |
| Shared API contracts                        | `packages/shared/src/me-api.ts:4,8,20` exported interfaces per endpoint                                                                                                                                                                                                                                        | `packages/shared/src/scratchpad-api.ts` in the same style.                                                                                                                                                                 |
| Design primitives                           | `packages/ui/OPTIONS.md`: `jds-menu`, `jds-field`, `jds-switch`, `jds-icon-button`, `jds-card`, `jds-dialog`, `jds-empty-state`; `apps/web/src/styles/kit-chat.css:1` `.chatd`, `:19` `@media (min-width: 721px)`                                                                                              | Panel chrome is `jds-*` only. Layout classes live in `apps/web/src/styles/kit-scratchpad.css`, added to the kit list the same way `kit-chat.css` is. `pnpm check:design-tokens` catches invented classes.                  |

## Decisions

### D1. Package layout

```
packages/scratchpad/
  package.json              name "@moss/scratchpad", same deps shape as packages/tasks
  src/index.ts              exports manifest, sql directory, registerScratchpadRoutes
  src/manifest.ts           scratchpadModuleManifest: MossModuleManifest, id "scratchpad"
  src/repository.ts         ScratchpadRepository (get, put, append, patchSettings) on a scoped db
  src/routes.ts             registerScratchpadRoutes(server, deps)
  src/tools.ts              scratchpadReadTool, scratchpadAppendTool
  src/notes-mirror.ts       mirrorToNotes(deps, actorUserId, body) -> NotesMirrorResult
  src/shortcut.ts           parseShortcut, formatShortcut, SHORTCUT_DEFAULT (shared with web via @moss/shared)
  sql/0214_scratchpads.sql
```

Registered in `packages/module-registry/src/index.ts` `BUILT_IN_MODULES` after the notes entry:

```ts
{
  manifest: scratchpadModuleManifest,
  sqlMigrationDirectories: [scratchpadModuleSqlMigrationDirectory],
  queueDefinitions: [],
  registerRoutes: (server, deps) =>
    registerScratchpadRoutes(server, {
      dataContext: deps.dataContext,
      resolveAccessContext: deps.resolveAccessContext,
      notesRoot: deps.notesRoot,          // see D6
      notesSync: deps.notesSync           // see D6
    })
}
```

The shortcut parser lives in `packages/shared/src/scratchpad-shortcut.ts` so the API validator and
the web key matcher are the same function. Nothing else in `packages/shared` imports a module.

### D2. Migration `packages/scratchpad/sql/0214_scratchpads.sql`

Number re-checked at build time (Slice 1 command). DDL is the spec's, unchanged:

```sql
CREATE TABLE app.scratchpads (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  body text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  sync_to_notes boolean NOT NULL DEFAULT false,
  shortcut text NOT NULL DEFAULT 'mod+shift+s',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scratchpads_body_size CHECK (length(body) <= 64000)
);
ALTER TABLE app.scratchpads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scratchpads FORCE ROW LEVEL SECURITY;
CREATE POLICY scratchpads_select_owner ON app.scratchpads FOR SELECT USING (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_insert_owner ON app.scratchpads FOR INSERT WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_update_owner ON app.scratchpads FOR UPDATE USING (user_id = app.current_actor_user_id()) WITH CHECK (user_id = app.current_actor_user_id());
CREATE POLICY scratchpads_delete_owner ON app.scratchpads FOR DELETE USING (user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.scratchpads TO jarvis_app_runtime;
```

RLS classification: owner-only. No worker role grant; nothing runs in a job.

### D3. Shared contract `packages/shared/src/scratchpad-api.ts`

```ts
export interface ScratchpadResponse {
  body: string;
  revision: number;
  updatedAt: string | null;
  maxChars: 64000;
  syncToNotes: boolean;
  notesFolderConfigured: boolean;
  shortcut: string;
}
export interface PutScratchpadRequest {
  body: string;
  revision: number;
}
export interface PutScratchpadResponse {
  revision: number;
  updatedAt: string;
  notesMirror?: NotesMirrorResult;
}
export interface ScratchpadConflictResponse {
  error: "scratchpad_conflict";
  body: string;
  revision: number;
  updatedAt: string;
}
export interface AppendScratchpadRequest {
  text: string;
}
export interface AppendScratchpadResponse {
  revision: number;
  updatedAt: string;
  appended: string;
}
export interface PatchScratchpadSettingsRequest {
  syncToNotes?: boolean;
  shortcut?: string;
}
export type NotesMirrorResult =
  | { ok: true }
  | { ok: false; reason: "folder_missing" | "write_failed" };
```

Error codes: `scratchpad_conflict` 409, `scratchpad_too_large` 413, `scratchpad_notes_folder_missing`
409, `scratchpad_shortcut_invalid` 400. `revision` is 0 when no row exists yet; a PUT with revision
0 inserts.

### D4. Manifest (the parts that matter)

```ts
export const scratchpadModuleManifest: MossModuleManifest = {
  id: "scratchpad", name: "Scratchpad", ...
  database: { migrations: ["sql/0214_scratchpads.sql"], ownedTables: ["app.scratchpads"] },
  routes: [
    { method: "GET",   path: "/api/scratchpad" },
    { method: "PUT",   path: "/api/scratchpad" },
    { method: "POST",  path: "/api/scratchpad/append" },
    { method: "PATCH", path: "/api/scratchpad/settings" }
  ],
  navigation: [{ id: "scratchpad", label: "Scratchpad", path: "/?scratchpad=open",
                 description: "A small notepad that opens over any page. One pad per person." }],
  settings: [{ id: "scratchpad", label: "Scratchpad", path: "/settings?section=scratchpad", scope: "user",
               description: "Keyboard shortcut and whether to keep a copy in your Notes folder." }],
  features: [ ... one entry per exit criterion: open/close, autosave with conflict, entry helpers,
              shortcut, Moss read, Moss append, Notes copy ... ],
  assistantTools: [
    { name: "scratchpad.read",   permissionId: "scratchpad.read",   risk: "read",
      description: "Read the user's scratchpad text.", execute: scratchpadReadTool },
    { name: "scratchpad.append", permissionId: "scratchpad.append", risk: "write",
      actionFamilyId: "scratchpad_changes", executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      description: "Append a line to the user's scratchpad. Never replaces existing text.",
      inputSchema: { text: string (1..2000) }, execute: scratchpadAppendTool }
  ]
};
```

`scratchpad.append` is append-only by construction, so it needs no confirmation (the same reasoning
as the install-grants-normal-use ruling of 2026-08-19). There is no delete or overwrite tool.

### D5. Web

- `apps/web/src/shell/app-shell.tsx`: `const [scratchpadOpen, setScratchpadOpen] = useState(false)`
  next to `chatOpen`; a `jds-icon-button` with the lucide `PencilLine` icon placed before the chat
  button in `.topbar-actions`; `<ScratchpadPanel open={scratchpadOpen} onClose={...} />` rendered
  once, as a sibling of the single ChatDrawer. `?scratchpad=open` in the URL opens it on load (this
  is the app-map path Moss can send people to) and is removed from the URL afterwards.
- Stacking: a shell-level `lastOpened: "chat" | "scratchpad"` state sets which panel gets the higher
  z-index. Below 721px, opening one sets the other closed (spec decision 3).
- `apps/web/src/scratchpad/use-scratchpad.ts`: one store holding `{body, revision, status, settings}`.
  Save is debounced 800ms after the last keystroke and also fires on blur, panel close and page hide.
  On 409 the store keeps the local text, shows the server text and revision in a small
  `jds-dialog` with "Keep mine" / "Use theirs". No merge.
- `apps/web/src/scratchpad/scratchpad-editor.tsx`: a plain textarea plus a small toolbar
  (`jds-icon-button`s: bullet, numbered, checkbox, bold, italic, indent, outdent). Helpers rewrite
  the current line or selection in the textarea value and put the caret back. Rules:
  - Enter on a line starting with `- `, `1. `, `- [ ] ` continues the list; Enter on an empty list
    line ends it.
  - Tab / Shift+Tab indent / outdent the current line(s) by two spaces. Tab never leaves the box.
  - Bold wraps the selection in `**`, italic in `_`; pressing again unwraps.
  - Cmd/Ctrl+B and Cmd/Ctrl+I are handled inside the textarea only.
- `apps/web/src/scratchpad/shortcut.ts`: `matchesShortcut(event, parsed)` using the shared parser.
  The shell listener is registered the same way as the palette's (capture phase) and ignores events
  while the target is an editable element other than the scratchpad itself, so the pad's shortcut
  cannot fire while someone types a chat message.
- Settings pane `apps/web/src/settings/settings-scratchpad-pane.tsx`, section id `scratchpad` added
  to the personal list in `settings-page.tsx`: a `jds-switch` "Keep a copy in my Notes folder"
  (disabled with an explanation when no folder is set, linking to the Notes source section) and a
  shortcut recorder field: click, press the keys, shown as "Ctrl+Shift+S" / "Cmd+Shift+S".
  Rejects combinations without a modifier, and Cmd/Ctrl+K.
- Layout CSS in `apps/web/src/styles/kit-scratchpad.css`: `.scratch`, `.scratch__head`,
  `.scratch__body`, `.scratch__foot`. Desktop: fixed, bottom-right, 360x420, resizable by the user
  is out of scope. Phone: full width, bottom sheet, 60vh.

### D6. Notes mirror (server side, best effort)

`mirrorToNotes` runs after a successful PUT or append when `sync_to_notes` is true. It writes
`Scratchpad.md` into the user's notes root and enqueues a sync, following
`packages/notes/src/daily-archive-writer.ts:44,85`. It never throws into the save path: the save
response carries `notesMirror: {ok:false, reason}` and the panel foot shows "Copy to Notes failed"
with the reason. The notes root and the sync hook come in through `registerRoutes` deps, not by
importing notes internals. How they get there is open question 1.

### D7. Determinism boundary

Nothing in this feature is model-authored except the text Moss appends. The model has exactly one
job: choose the line to append. The tool wraps it: trims, refuses empty, caps at 2000 characters,
prefixes a newline if the pad is non-empty, and stores the exact string it appended in the response
so the chat summary can quote it. All UI status text ("Saved", "Saving", "Copy to Notes failed")
renders from the store, never from model output. The read tool returns the body verbatim with no
summarising.

### D8. Live-path proof

Recorded on the PR as a comment with screenshots taken on the dev instance
(http://192.168.50.36:5173, login `ben@ben.com`). `:1533` is prod and is never touched. Ben must sign
in again after every API restart.

## Slices

Each slice fits one Sonnet build session (about 2-3 hours). Slices 1 and 2 share one worktree and
one PR; the kill gate sits between slice 1 and slice 2 and is decided on that PR. Slices 3-5 join
the same worktree and PR. The builder commits by explicit path only and never uses `git add -A`.

### Slice 1: storage, API, Moss read (no UI)

Builds: package skeleton, migration, repository, GET/PUT/append/settings routes, `scratchpad.read`
and `scratchpad.append` tools, shared contract, RLS test, route tests, mock API state.

Tests (behaviour, and why each would fail without the code):

- RLS: user A writes a pad; connected as `jarvis_app_runtime` acting as user B, SELECT returns no
  rows and UPDATE affects 0 rows. Fails if a policy is missing or FORCE is off.
- PUT with a stale revision returns 409 with the server body. Fails if the update ignores revision.
- PUT with 64001 characters returns 413. Fails if the check constraint error is not mapped.
- Append on an empty pad stores the text with no leading newline; on a non-empty pad it prefixes
  one newline and bumps revision. Fails if the newline logic is wrong.
- PATCH settings with `shortcut: "s"` (no modifier) returns 400; with `"mod+k"` returns 400.
- PATCH `syncToNotes: true` with no notes folder returns 409 `scratchpad_notes_folder_missing`.
- Server starts with the manifest routes declared (route-guard). Fails at boot if a route is
  missing from `routes[]`.
- Tool test: `scratchpad.append` refuses empty text and caps at 2000; `scratchpad.read` returns
  the body unchanged.
- e2e (`tests/e2e/scratchpad-api.spec.ts`): through the mock API, the shell shows the new
  PencilLine button but not yet a panel. Kept trivial on purpose; the real e2e is slice 2.

Verification, each on its own line, none piped:

```
ls packages/*/sql/*.sql infra/postgres/migrations/*.sql > /tmp/mig.log 2>&1; echo "EXIT=$?"   # then pick highest+1
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"                                      # expect 0
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"                                         # expect 0
pnpm --filter @moss/scratchpad test > /tmp/unit.log 2>&1; echo "EXIT=$?"               # expect 0
pnpm test:integration -- scratchpad > /tmp/int.log 2>&1; echo "EXIT=$?"                # expect 0, verify-gate skill first
```

`module-sdk-worker` unit tests fail locally and pass in CI; do not bisect over them.

### Kill gate (after slice 1). Owner: Ben.

The PR shows the migration applied on dev and a chat transcript where Moss reads an empty pad,
appends "buy milk", and reads back "buy milk". If Moss cannot see or add to the pad through the real
chat on dev, stop: the rest of the feature is decoration on a store that does not work. Ben decides
go / no-go in chat; the coordinator records the ruling on the PR.

### Slice 2: panel, shell wiring, autosave, conflict

Builds: `use-scratchpad.ts`, `scratchpad-panel.tsx` (plain textarea, no helpers yet), shell button,
`?scratchpad=open`, stacking and phone rules, `kit-scratchpad.css`, conflict dialog.

Tests:

- e2e `tests/e2e/scratchpad-panel.spec.ts`: click the pencil button, type "hello", wait, the mock
  PUT is called with body "hello" and revision 0; reload, the text is there. Fails if autosave or
  load is missing.
- e2e: open chat, then scratchpad; the scratchpad is on top (z-index compared via
  `getComputedStyle`); at 400px wide opening chat closes the scratchpad. Fails if stacking rules
  are missing.
- e2e: mock PUT answers 409 with body "theirs"; the dialog appears; "Use theirs" replaces the text.
- Unit: the store does not send a PUT when nothing changed.

Verification adds:

```
pnpm check:design-tokens > /tmp/tokens.log 2>&1; echo "EXIT=$?"                        # expect 0
pnpm test:e2e -- scratchpad > /tmp/e2e.log 2>&1; echo "EXIT=$?"                        # expect 0
```

Live proof on dev: screenshot of the pad open over Today, and over the chat drawer.

### Slice 3: entry helpers and the shortcut

Builds: `scratchpad-editor.tsx` toolbar and key handling, shared shortcut parser, shell key
listener, settings pane with the switch (disabled until slice 5 wires the folder check) and the
shortcut recorder.

Tests:

- Unit (`apps/web/src/scratchpad/editor-rules.test.ts`): Enter continues "- " lists and "1. " lists
  with the next number; Enter on an empty item removes it; Tab indents two spaces; Shift+Tab
  outdents; bold toggles `**`. Each fails without the rule.
- Unit: `parseShortcut("mod+shift+s")` round-trips; rejects "s", "shift+s", "mod+k".
- e2e: press Ctrl+Shift+S on Today, the pad opens; press again, it closes; with the cursor in the
  chat box the shortcut does nothing. Fails if the listener ignores the editable-target rule.
- e2e: in Settings, record Ctrl+Shift+P, save; the mock PATCH carries "mod+shift+p"; back on Today
  the new keys open the pad.

Live proof: a short clip or two screenshots of a bulleted list being made with Tab indent.

### Slice 4: Moss surfaces in the panel

Builds: the panel refreshes the store when a chat turn used `scratchpad.append` (listen to the same
chat event the drawer already emits for completed tool calls, or refetch on drawer close if none
exists; the builder checks and records which), the pad menu (`jds-menu`: the Notes checkbox,
"Copy all", "Clear" confirmed with `jds-dialog`, "Open Settings"), the "Ask Moss" button, and the
manifest `features` entries.

"Ask Moss" (Ben's ruling, 2026-09-04): a very small quiet `jds-icon-button` in the pad header
showing only a question mark, title "Ask Moss about this". Hidden until the pointer hovers over the
pad (`.scratch:hover .scratch__ask { opacity: 1 }`); on touch screens, which have no hover, it shows
while the pad has focus (`.scratch:focus-within`). Pressing it opens the chat drawer with the pad
text prefilled as an editable draft message; nothing is sent by the button. The shell already owns
`chatOpen`, so the panel calls a shell callback `openChatWithDraft(text)`; the builder checks whether
ChatDrawer accepts an initial draft and adds a prop if not.

Tests:

- e2e: after a mocked chat reply that reports a scratchpad append, the panel shows the new line
  without reload.
- e2e: "Clear" asks first; cancel keeps the text; confirm sends PUT with empty body.
- e2e: the "?" button is not visible until the pointer hovers the pad; hovering shows it; pressing
  it opens the chat drawer with the pad text in the message box and no message sent (the mock chat
  endpoint records zero sends). Fails if the button is always shown, or if it sends by itself.
- Unit: manifest `features` cover every exit criterion in the spec (a test that lists them).

Live proof: Moss appends from the chat drawer and the open pad updates.

### Slice 5: Notes copy, app map, final live proof

Builds: `notes-mirror.ts`, the folder-configured check, settings switch enabled, `notesMirror` in the
save response and the "Copy to Notes failed" foot message, release note in the PR body, and the
full live-path proof.

Tests:

- Integration: with a temp notes root, PUT writes `Scratchpad.md` with the body and calls the sync
  hook once. Fails if the mirror or enqueue is missing.
- Integration: with no notes root, PATCH `syncToNotes: true` is refused; PUT still succeeds and the
  response has no `notesMirror`.
- Integration: a mirror write that throws leaves the PUT at 200 with `notesMirror.ok === false`.
- e2e: settings switch is disabled with the explanation when the mock says no folder.

Live proof on dev: set a notes folder, turn the switch on, type in the pad, show the file on disk
with the same text.

## Open questions

1. **How does the scratchpad get at the notes root and the sync hook?** Today `notesSync` is a chat
   tool service built in `packages/chat/src/gateway-services.ts:88`, and the daily archive writer
   reaches the notes root inside the notes package. Module isolation forbids importing notes
   internals. Options: (a) the notes package exports a small public `NotesMirrorService`
   (`{ rootFor(actorUserId), writeFile(actorUserId, name, body), enqueueSync(actorUserId) }`) and the
   registry passes it into `registerScratchpadRoutes`; (b) the scratchpad invokes the `notes.create`
   tool with `overwrite: true` through `findAssistantToolFromManifests`, but that tool forces a
   confirmation on overwrite (`packages/notes/src/manifest.ts:131`) and no helper exists to run a
   tool from a route. Recommendation: (a). Decision owner: Ben or the main session, before slice 5.
   Slices 1-4 do not depend on it.
2. **Resolved (Ben, 2026-09-04).** "Ask Moss about this" is a hover-only question-mark button in
   the pad header, not a menu item; it opens the chat drawer with the pad text prefilled as an
   editable message and sends nothing itself. Folded into slice 4.
3. **Migration number.** 0214 assumed; other lanes are merging today. The builder re-checks in
   slice 1 and renames before the first commit.

## Rulings ledger

- 2026-09-04 Ben: one pad; small notepad-sized panel that may overlap chat on desktop, most
  recently opened on top; on phone opening one closes the other.
- 2026-09-04 Ben: default shortcut Cmd/Ctrl+Shift+S, user-definable in Settings.
- 2026-09-04 Ben: plain text box with bullets, numbered lists, checkboxes, Tab indent/outdent,
  bold, italic; no editor dependency.
- 2026-09-04 Ben: no Today card ("pocket notebook"); Moss can read it.
- 2026-09-04 Ben: app storage, with an optional checkbox to mirror to a Scratchpad note in the
  Notes folder.
- 2026-09-04 Ben: "cool, specs approved, lets get those started".
- 2026-09-04 Ben: Ask Moss is a tiny hover-only "?" button (focus-shown on touch), opens chat with
  the pad text as an editable draft, never sends by itself; the menu keeps Copy all, Clear and the
  Notes checkbox.
