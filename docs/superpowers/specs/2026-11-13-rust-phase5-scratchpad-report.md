# Rust Phase 5: Scratchpad part 1, package and note routes

Task JS-286, Card 286. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

This report covers part 1 only. Chat tools, delete and export, and screens belong to later parts.

## What was built

- A Scratchpad package in `modules/scratchpad/`. It holds one private note per person in one table,
  with the old table and its SQL file kept byte for byte. The build refuses a changed byte.
- Four routes: read the note, replace it, add to the end of it, and change the settings (shortcut and
  "also save to notes"). They keep the old rules. The note holds at most 64000 characters, counted the
  way the old code counted them. A replace on an out-of-date version returns a conflict that carries the
  current note. Errors use the old wording and codes.
- The package is wired into the real Rust server next to Backtrack.
- The app map entries for finding the note, saving it and the settings are in the package manifest.

## Proof

- Guest tests (shortcut 3, routes 8, privacy 2) pass natively. The package also builds as a WebAssembly
  component.
- Installed tests in a throwaway database: a second person and an admin cannot read or change the note.
  With row security switched off the test failed (two notes visible, an overwrite), and it passes again
  with it restored.
- Private text never appears in job payloads, activity rows, other tables (12 scanned) or the log.
  Adding a leak to the error path made the privacy test fail, and it was reverted.
- Live run on the real Rust server over HTTPS with two disposable people, no response rewriting. Signed
  out gets 401. Read, save, conflict, add and settings all work. The second person sees an empty note and
  cannot overwrite the first person's note.

- Route parity: 52 requests were sent to the old routes (run on the same database) and to the package,
  and every status and body matched, apart from times. The cases cover version conflicts, whole-number
  versions like 2.0, wrong types, missing and null values, the 64000 limit counted in UTF-16 units (emoji),
  trimming of unusual spaces, adding past the limit, every shortcut rule, and the notes-folder setting both
  missing and set. The replay found one real difference (null settings were accepted), now fixed.

## Not proven

- The guest's own unit tests run natively. A test runner that executes WebAssembly directly is not in the
  approved crate list, so none was added. The installed tests, the 52-step replay and the live run all call
  the built WebAssembly component, so the shipped build is exercised end to end.
- The check from a second device on the network is built but only runs when a device is named, and it was
  not run.
- The notes-folder setting is read from the platform preferences table by the host wrapper. A later
  part should replace that with a public interface.
- Chat tools, delete and export, and every screen are not built.

Card 286. Part of issue 4027. Release note Category: N/A.

## Part 2 — chat tools and account data

Task JS-291, Card 603. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

Part 1 already supplied the package, unchanged SQL, note read/replace/append routes, shortcut
validation and notes-copying settings route. This part reuses those, including their stored note.
No new third-party Rust crate, screen or SQL migration was added.

### What changed

- Chat can read the note with its character count, version and save time, or add up to 2000
  characters. It keeps the old trimming, character counting and error messages. Chat offers no
  whole-note replace or delete tool.
- Code prepares approval details from the submitted line and the stored note's version and
  character count. Preparing them does not change the note. Settings approval details use the
  stored shortcut, copying setting and folder-connected state. The host's existing approval
  service binds append permission to the person and exact input, and consumes it once.
- The host now provides a public yes/no projection of the account's Notes-folder preference.
  Scratchpad no longer queries that preference table directly. Its existing setting still
  refuses copying when no folder is connected.
- Public export and delete APIs cover only this table, under the caller's row policies.
  Export preserves absence as null; deletion is safe to repeat. Authenticated module routes
  expose these operations and the chat operations for the Rust server. The app map describes
  these capabilities and their current limits.

### Proof from this work

- Sixteen native guest tests pass. The same chat contract runs against the real compiled
  WebAssembly component through its host ABI and passes. Both use Rust 1.95.0; the package
  remains a no-WASI component built from `wasm32-unknown-unknown`, as in part 1.
- Installed component tests prove the approval details use stored version/count; preparation
  does not write; missing permission, changed text, a different person and replay are refused;
  approved append updates the same note read by the note route and chat tool.
- Two people and an administrator exercise export and deletion. A forged account parameter
  is refused; export contains only the caller's note; deleting it preserves the second note.
  With row security disabled the same export-isolation assertion fails, then passes again
  after restoration. The inherited direct read/write negative control also runs again.
- Planted note text is absent from the twelve queue, module and activity tables scanned after
  chat operations, from host activity files and from the real server log. Removing the guest's
  error scrubbing made the backend-error privacy test fail; restoring it passes. Authorized
  reads, approval fields and exports intentionally return the caller's requested text.
  These operations make no model calls or jobs.
- All 52 requests replayed against the actual old route handlers match the installed component,
  including the notes-folder setting absent and connected. Nine additional requests replayed
  against the actual old chat handlers match, including whitespace, emoji and size errors.
  Only independently generated save times are excluded from comparisons.
- The real Rust HTTPS executable signs in two disposable people, loads the signed registry
  package, prepares approval details, denies unapproved/other-person/replayed append, accepts
  an append using a grant made by the trusted host API, and reads the resulting note through
  the real routes. Export and deletion also run through the real routes. Nothing intercepts
  or rewrites a response. The grant setup uses the existing trusted approval API directly;
  this proves execution and consumption, not a rendered chat approval screen.

Commands (each expected exit code **0**):

```sh
# Set task-owned CARGO_HOME, RUSTUP_HOME and CARGO_TARGET_DIR first.
scripts/run-gate.sh start --gate test:rust-scratchpad
scripts/run-gate.sh wait --follow --log <printed-log>
scripts/run-gate.sh start --gate test:rust-scratchpad-live
scripts/run-gate.sh wait --follow --log <printed-log>
```

The separate error-scrubbing negative-control run is expected to exit **101** with the
protection removed, then **0** with it restored. Gate receipts and review results are in the
task's Proof artifact; they identify the tested commit and inputs. Old browser tests are not
run for this Rust slice.

### Not proven in part 2

- Rendering and clicking an approval card in chat, a Scratchpad screen, desktop/phone layout,
  and a separate physical device reaching the server. This slice has no screen; part 3 owns
  the Scratchpad screen. Live evidence here is the executable HTTPS route path on this host.
- Account-wide export/deletion orchestration and its UI consuming these public table APIs.
- Writing a mirrored Markdown file. This part preserves the existing copying preference and
  its folder prerequisite; it does not add a Notes file writer.

### Review notes

The first independent review found no major or blocking issue. Its minor suggestions led to
correcting the changelog heading, formatting the new chat test, and recording these limits:

- The existing host consumes approval before execution. A full note or a store failure needs
  fresh approval for another attempt. The stored version/count describe preparation time;
  the additive append does not reject a newer version of the note.
- Missing append approval currently returns a scrubbed 500 response. A dedicated approval
  status for the future chat UI is not added here.
- Approval preparation is stricter than the old presentation: it returns no card for blank,
  invalid or over-2000-character input. The route and tool execution replay counts above
  compare the old handlers, not the old approval presenter.
- Public export/delete APIs follow the existing dependency-bound, caller-account API model.
  An authorized dependent module can operate on the calling person's note; there is no
  cross-account parameter. Account-wide orchestration must retain its own approval boundary.

Suggestions to version-bind additive append and change the host's grant-consumption timing
were left for the shared approval design. Existing code formatting was retained; no further
unrelated formatting changes were added.
