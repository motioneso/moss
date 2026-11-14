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
