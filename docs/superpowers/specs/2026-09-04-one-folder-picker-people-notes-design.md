# One folder picker, People notes in the notes folder

Date: 2026-09-04. Status: approved by Ben in the live session ("There is a people folder that
points to the notes folder FOR people. All folder pickers should use the same folder picker,
just like an OS.").

## Context

The app has two folder pickers that browse different places. The notes chooser
(`apps/web/src/settings/settings-vault-chooser.tsx`, mode `notes`) lists the server's allowed
notes roots (`MOSS_NOTES_ROOTS`) and drills into them; the chosen folder is stored as an absolute
path in the `notes-source-path` preference and re-validated against the allowed roots on every use
(`packages/settings/src/notes-source-routes.ts`, `packages/notes/src/jobs.ts`). The People chooser
(mode `people`) lists the app's private per-user storage folder (`VaultContextRunner` root =
`JARVIS_VAULT_ROOT/<userId>`), which holds attachments and exports and no note folders. On dev the
People listing fails outright. People notes are written into that private folder as a relative
path stored in the `people-notes-folder` preference.

## Goals

- One folder picker everywhere, browsing the same allowed notes roots, like an OS file dialog.
- The People folder is a folder inside the user's notes tree. People notes are created and edited
  there by the app.
- Existing People folder values keep working or ask once to be chosen again; nothing silently
  points at a different place.

## Non-goals

- No change to where chat attachments or exports live (they stay in private storage).
- No new environment variable. No change to the allowed-roots rule.
- No model involvement anywhere in this feature.

## Design

1. **Vault roots.** `VaultContextRunner` gains a way to open a `VaultContext` rooted at a caller
   supplied absolute folder, subject to the same checks the notes worker applies to the
   `notes-source-path` preference: `realpath` it, require it to sit inside an allowed notes root,
   refuse otherwise. All existing escape protections (symlink escape, `..`, absolute relative
   paths) apply unchanged. The private per-user root stays the default for all current callers.
   Signature to add, beside `withVaultContext`:
   `withVaultContextAt(accessContext, absoluteRoot, allowedRoots, fn)`.
2. **People folder storage.** The `people-notes-folder` preference stores an absolute path chosen
   with the shared picker. Save validates it exactly as the notes source save does (exists, inside
   an allowed root). Reads of a legacy relative value (for example `People`) resolve it against the
   current `notes-source-path` when that is set and the folder exists; otherwise the People pane
   shows the existing "folder unavailable, choose another" state. No guessing beyond that.
3. **People reads and writes** go through `withVaultContextAt` rooted at the stored People folder.
   The People scan (`/api/people/notes-directories`, refresh, create, update) uses this root.
4. **Picker.** `VaultChooser` loses its `people` mode. The People pane opens the same chooser the
   notes source uses, with a heading of "Choose a People folder" and its back label naming the
   People screen. The picker's intro, info tip and empty states are shared unchanged.
5. **App map and manifest.** The People settings description and the Data sources description
   say folders are chosen from the same list of available folders and that People notes live in
   the chosen notes folder. Each description stays at 240 characters or fewer.

## Determinism boundary

All feedback on these screens renders from stored settings and file listings. The model is not
involved.

## Tests

- Unit: opening a root outside the allowed roots is refused; a symlink out of the root is refused;
  a legacy relative People value resolves only when the notes source is set and the folder exists.
- Unit: the People pane renders the shared chooser (no `people` mode left in the codebase).
- Integration (scratch database via `scripts/run-gate.sh`): saving a People folder inside the
  allowed root succeeds and a People note is written there; saving one outside is refused with
  the existing plain message.
- Live proof on dev: Settings, People, Choose folder shows jarv1s-dev-vault; pick a folder; add a
  person; the note file appears in that folder.

## Exit criteria

Both pickers show the same list on dev. People notes are written into the chosen notes folder.
Legacy People values either resolve or ask once. All gates green.
