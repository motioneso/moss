# Rust Phase 5: Memory part 1 report

Part of https://github.com/motioneso/moss/issues/4027. Task JS-229. Plan: `2026-11-11-rust-phase5-memory-plan.md`.

## What was built

- **Memory package skeleton** in `modules/memory`. It has the manifest (id memory, ledger
  core-legacy, required, bundled, cannot be removed), icons, changelog, a Rust crate, a small
  screen for the settings, and the 16 legacy tables. The 22 legacy SQL files are kept byte for
  byte and each file is checked against the frozen inventory. It has no tools, no recall and no
  Memory screen yet.
- **One embedding service in the host.** Every embedding call now goes through it. It adds the
  document or query prefix, accepts only exactly 768 finite numbers, records which model and
  version wrote each vector, keeps the 64 KiB text limit, and writes one activity row per call
  with the model name and the outcome and never any text.
- **Notes ingest and Notes search use it.** The stored model name and version follow the
  settings, and for the default model they are the same values the old app writes (the model
  name, and version 1.5).
- **Embedding settings in the app.** An admin sets a web address, a model name and a key. The
  key is write-only and is stored sealed in its own file. The save is refused unless the admin
  confirms that note text will be sent to that address. On-device shows "not available yet".
  Until an address is set the plain message is "No embedding model is set up". The real server
  uses the saved address, and falls back to the address in its modules file when none is saved.
- **A fixed fake embedding model** used by tests only. It is not part of any shipped build.
- Settings, error text and the remedy are declared in the module manifest, which is where the app
  map for module-owned screens lives.

## Where the Rust shape differs from the old app

- The old app only ever ran a local model. Its two keys, `ai.embed_provider` and `ai.embed_model`,
  are reused, with the provider value `endpoint` for an address-based setup. Two keys are new:
  `ai.embed_endpoint_url` and `ai.embed_model_version`.
- The setting is for the whole instance and only an admin can write it (that is how the settings
  table already works). Every signed-in account's note text goes to that address.
- The key is kept in a sealed file in the data folder, not in the settings table, because the
  settings table is for non-secret values only.
- The settings route is served by the host, not by the module, so the key never reaches module code.
- The manifest lists all 22 SQL files. The old manifest lists 7 plus a folder. Listing all 22
  keeps every applied file safe and checked.

## Review round 1 (Codex), all fixed

- Embedding activity rows now belong to the person whose note was embedded (they were ownerless,
  which let an admin read them). The live check now filters on ownership.
- Changing the address no longer keeps the old key. The save is refused until a key (or an empty
  key, meaning none) is given, and the screen says so.
- Plain http is accepted only for this machine (localhost, 127.x, ::1). Everything else needs https.
- Turning embeddings off now stores an explicit off state, so the server file is not used instead.
  If an address was never saved, the modules-file address still applies.
- Ingest checks the model is unchanged just before writing, so one call cannot mix models. A change
  inside the few moments between that check and the write is not covered.
- A required module cannot be removed even if its manifest also says removable.

Round 2 (a fresh Opus reviewer, because Codex was out of capacity) found no blocker. It found
that a first setup with no key was refused, which is fixed: a key is demanded on an address
change only when a key is already saved. Two minor items are left open. A large note indexed in
batches can mix models if the model is changed between batches. The key file is written before
the database save, so a database failure could leave a new key beside the old address.

## Proof

| Claim                                                            | Evidence                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefix is added                                                  | Test fails when the prefix is blanked, passes when restored                                                                                                 |
| Wrong size, empty, non-finite, oversize answers are refused      | Five service tests, all passing                                                                                                                             |
| Note text never in an activity row, log, response or job payload | Test fails when the text is written into the row, passes when restored. Also checked live (below)                                                           |
| Key never in a response, sealed file, server log or activity row | Live run below                                                                                                                                              |
| Notes search and ingest still work                               | Real-server Notes gate passed, 1 test, 71 s                                                                                                                 |
| Settings set over HTTPS on the real server                       | Same gate: refused without the confirmation, saved with it, then a note was indexed through the saved address, and the fake endpoint received the saved key |
| Memory package loads in the real host, 6 package tests           | Memory package gate passed: 2 native tests, wasm build, 6 package tests through the real host                                                               |
| Stored vectors match the old code                                | First test of the old-code ingest comparison passed: Rust rows equal the old rows for both roles                                                            |

## Not proven

- **Old-code ingest comparison, 6 of 7 tests.** They failed here ("The module could not finish
  this request") using a Notes tool component built by another task. This machine cannot build
  that component (the wasm32-wasip2 standard library is not installable). The failing tests call
  the Notes component's own sync request, not the embedding code, so the cause is most likely a
  stale component, but that was not shown.
- **Rust-written vector read by the old TypeScript retriever.** The ingest comparison checks the
  stored rows, not a search by the TypeScript retriever. No such test was run.
- **WebAssembly build of the host.** The host is native only (it runs the wasm modules). The
  Memory module's own wasm build and its tests through the real host are the WebAssembly proof.
- **Second device.** Not reachable in this run.
- **A real hosted embedding provider.** Only a local stand-in endpoint was used.
- **Notes search through the settings route over HTTP.** The server has no search endpoint yet.
  Indexing through the saved endpoint was proven live.
- **Browser view of the settings screen.** Not exercised in a browser.
- **Vikunja card.** The card could not be found, so it was not moved.
- **Core app map file** (`packages/shared/src/app-map-core.ts`) was not changed. The entries live
  in the module manifest.

## Part 5: the search index (JS-232)

### What was built

- The Memory module now keeps its own search index of private note copies and the People notes
  folder. A job lists the files, skips unchanged ones, indexes changed ones in small pages,
  removes deleted or moved ones, and clears rows for files that are gone.
- A fifteen-minute schedule per account starts the sweep. The `attachments/` and `exports/`
  folders are never indexed.
- A change of embedding model name re-embeds every file once. A restart does not.
- A request to index one private note export (or drop it) is stored in a small private table and
  queued by its row number only. No note text or path travels in a job.
- A signed-in call to start the first sweep now exists. Until a screen or Notes calls it, nothing
  starts the schedule on its own.
- The host side reads files only through the account's vault, and returns only counts and statuses
  to the module.

### Proof

| Claim                                                           | Evidence                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changed, unchanged, deleted and moved files are handled         | Real database test with the fake embedding model, passing                                                                                         |
| A restart does not re-embed; a model name change re-embeds once | Same test file, two tests, passing                                                                                                                |
| Index rows written by the old TypeScript code are honoured      | Test seeds a row with the old code; Rust embeds nothing for it and stays private to its owner                                                     |
| A fifteen-minute schedule is registered once per account        | Real database test and the live run                                                                                                               |
| Note text never appears in a job                                | Test failed when a path was planted in a job and passed when removed; the host also refuses anything but ids, counts and flags                    |
| Native and WebAssembly builds with tests                        | 9 module tests and 6 package tests through the real host, passing                                                                                 |
| Live run on the real server over HTTPS                          | The gate started the sweep over HTTPS, the server's worker embedded a private note export through the saved endpoint, and a schedule row appeared |
| Notes real-server gate still passes                             | Passed with Memory installed alongside Notes                                                                                                      |

The live run found a real fault the database tests missed. The model lookup was called inside an
async block and crashed the worker. It is fixed and the live run passes.

### Not proven

- **Notes ingest comparison, 6 of 7 tests.** As in part 1, they need a Notes component this
  machine cannot build. With a component built by another task, 1 passed and 6 failed. No Notes
  file was changed by this work. The Notes real-server gate passed.
- **Notes calling Memory when a note export is written.** The request call is built and tested
  inside the module, but Notes does not call it. The fifteen-minute sweep covers exports instead.
- **Managed note labels against the real Notes tables.** The label identities match the old code
  (checked against values from the old code), but no test ran with a real label.
- **Structured-state folders and the Meetings producer.** There is no Rust equivalent yet.
- **People notes folder.** The root is wired but was not exercised with real People data.
- **Second device.** Not reachable in this run.
- **Searching the new index.** Search by the new rows over HTTP is not built. Part 2 owns recall.
- **Core app map file.** Not changed. The new job, route and feature are in the module manifest.
- **Migration number.** 0363 had no collision with open pull requests at check time.
