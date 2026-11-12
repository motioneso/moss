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

## Part 2: graph store and recall

### What was built

- Rust reads and writes the old graph tables (facts, entities, sources, search documents). Every query runs as the signed-in person, under row security.
- Four routes: recall, core facts, add entity, add fact. Status codes and error text match the old routes.
- Two tools, `memory.recall` and `memory.remember`, with the old input shapes and the exact old score formula.
- Remembering saves the fact first, then tries to store its search vector (two tries). A failed embedding leaves the fact saved and the answer says the search is pending.
- The module manifest declares the routes, tools and features, so the app map stays true. No screens.

### Proof

| Claim                                                                | Evidence                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Score formula matches the old code                                   | 25 cases made by running the old recall code, replayed in Rust, all equal                                                                                                                                                                    |
| Rows written by the old code read correctly in Rust, and the reverse | Database test through the old code, passing                                                                                                                                                                                                  |
| One person cannot see, count or change another person's memory       | Two-person test passing, and it fails when row security is switched off                                                                                                                                                                      |
| A failed embedding never loses the fact                              | Database test and live run, both passing                                                                                                                                                                                                     |
| Guest and package build and pass in native and WebAssembly           | Memory check script, passing                                                                                                                                                                                                                 |
| Real server over HTTPS                                               | Live run: sign-up, add entity, add fact, recall by keyword, 401 when signed out, 400 error texts. A local stand-in embedding endpoint saw only the configured key. The key and the memory text did not appear in responses or the server log |

### Not proven

- The tools are proven through the real guest in database tests, not over HTTP. The server has no web route for tools.
- A second person over HTTP. Sign-up closes after the first account, so that check lives in the database tests only.
- A second device. No other device was reachable for this run.
- A hosted embedding provider. Only a local stand-in endpoint was used.
- Route parity is by score cases and unit tests, not by calling the old server and comparing live answers. Framework-level validation error bodies for recall may differ in wording.
- Chat gating flags (blocked or write) for the routes are not carried in the Rust manifest.
- The old guard against search-index changes on new rows was skipped.
- Retrying vectors that stayed pending is part 7.
- Pin, confirm, correct, forget, suggestions, the Memory screen, the search index and on-device embeddings are not built.

## Part 3: fact lifecycle, conflict groups and forget

### What was built

- Seven fact routes: pin, confirm, correct, status, mark stale, supersede and delete. The guest checks the request and shapes the answer. The host runs the SQL for the signed-in person only.
- Conflict groups: confirming or correcting one member settles the group, deleting members leaves it open or resolved as the old code does, and status changes on a member are refused.
- A recording-managed fact (one that Meetings owns) is refused with the old 409 text on every route except pin.
- The `memory.forget` tool, which always asks first. The approval card names the memory in words and carries a version. The host compares that version with the live memory under lock before it deletes.
- The manifest declares the new routes, tool and features, so the app map stays true. No screens.

### Proof

| Claim                                                              | Evidence                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statuses, error texts, answer shapes and rows match the old routes | 37 cases made by running the old routes against a real database (every error status included), replayed through the real Rust guest and database. All equal. The check step also fails if the old code stops matching the file. |
| Conflict group cases                                               | Among the 37: confirm and correct on groups of two and three, status and mark stale on a member, delete from groups of two and three, delete after a confirm                                                                    |
| Forget asks first, is bound to one version and is used once        | Database test: no approval is refused, a memory changed after the card is refused and kept, the fresh version deletes it, and replaying that approval deletes nothing                                                           |
| One person cannot use any new route on another's memory            | Database test for all seven routes and for forget. It also passes with row security switched off on every table the new SQL reads, because every statement filters by the acting person                                         |
| Native and WebAssembly                                             | Memory check script: native guest tests (23), WebAssembly build, package tests and database tests (10) all passing                                                                                                              |
| Real server over HTTPS                                             | Live run: pin 204, confirm, mark stale, status, correct, 400 and 404 error texts, supersede 204, delete 204, second delete 404, signed-out 401                                                                                  |

### Not proven

- The approval card and the one-use grant are not exercised through the live server. The server has no web route for tools or approvals. The version check is proven through the real guest and database, and the one-use grant by the generic host tests.
- Removing row security alone does not expose data through the new routes, because the SQL also filters by the acting person. The proof that row security itself hides rows is the part 1 test. The filter was not removed.
- Recording-managed facts return 409 because Meetings and its authority are not in the Rust server. Lineage transfer and synchronising were not ported.
- An invalid fact id returns 404 where the old route returned a server error.
- Validation error wording for request bodies follows the part 2 convention and may differ from the old framework text. The statuses match.
- A correction is indexed best-effort. The old code left it without a search vector.
- Deleting a fact that another fact points to as its replacement fails, as in the old code, and shows as a server error.
- A second person over HTTP. Sign-up closes after the first account, so that check is in the database tests only.
- A second device. No other device was reachable for this run.
- Suggestions, the Memory screen, the search index and on-device embeddings are not built.

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

### Review round 1 (Codex)

One major finding, fixed. A note's source could be fenced between the check and the lock, so a
fenced source could still be indexed. The source state is now read under the lock. No test covers
this path, because no test ran with a real managed label (listed above).

## Part 6: the search model on this device (JS-238)

### What was built

- The nomic search model now runs inside the Rust server. With nothing configured, memory search
  uses it. No note text leaves the machine. An owner can still choose an endpoint, or turn search
  off, in Memory settings.
- The model (about 550 MB) downloads on first use into the server's data folder, never the
  repository. The settings screen reads progress as a percentage and a clear failure sentence.
  A cut connection resumes from where it stopped. Each file is checked against a fixed hash before
  it is kept, and again if it was swapped on disk.
- A lock on the model folder stops two Moss processes downloading at once. The second one waits
  and says so.
- One worker thread makes the vectors. Text is capped at 512 tokens, the same cut the old code
  made. After 10 minutes idle the thread frees about 600 MB and starts again on the next search.
- Settings gained a Save choice for "run on this device" and a "download now" button route. The
  Memory manifest text no longer says the on-device model is unavailable.
- Activity rows hold fixed words and the model name only. Note text never reaches them.

### Runtime choice

ONNX Runtime (the `ort` crate) was compared with `tract`, a pure Rust runtime. Both matched the
old vectors. On a 512-token input ONNX Runtime took about 0.4 seconds and tract took 26 seconds.
ONNX Runtime was chosen.

### New crates (approved 2026-11-11)

| Crate        | Version     | Licence           | Reason                                     |
| ------------ | ----------- | ----------------- | ------------------------------------------ |
| `ort`        | 2.0.0-rc.15 | MIT OR Apache-2.0 | Runs the model                             |
| `tokenizers` | 0.23.2      | Apache-2.0        | Splits text into tokens as the old app did |

Their own dependencies also appear in the lock file. No other new crate was added directly.
`reqwest` and `sha2` were already in the tree.

### Proof

| Claim                                         | Evidence                                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vectors match the old app                     | 14 fixed texts, short and long, unicode and code. Lowest similarity 0.9999997, and 1.0000000 for a 12,000 character text cut at 512 tokens                      |
| Peak memory at the longest input              | 879 MB after loading, 928 MB peak after a 512-token input (release build, Linux)                                                                                |
| Download, cut-and-resume, refusal, bad hash   | 7 tests against a local server, passing. They cover the first download, resume from byte 100000, a server that ignores ranges, a 503, and a bad hash            |
| Folder lock                                   | Test where a second process waits, gives up with a plain sentence, and then succeeds                                                                            |
| Prefixes and activity rows on the device path | Host test. Text planted in a search reached the model, and appeared in no row, answer or failure sentence                                                       |
| Live, real server over HTTPS, no endpoint     | The gate downloaded the real model in 83 seconds with progress read from the settings route, saved facts, and a search by meaning returned the right fact first |

The live run found a real fault. The first search after the download hashed the whole file again
and ran out of time in a debug build. The download now marks the files as checked.

### Not proven

- **Windows and macOS builds.** The ONNX Runtime download has no plain build for Windows or Intel
  Macs, so the build uses the closest one. Pull request CI is the first test of this. If it
  fails, the fix is to build that runtime from source for those targets.
- **Installers.** The Linux binary now depends on the system C++ library. Not checked on the
  installers.
- **Model fetch in CI.** No CI test downloads the model. The vector test is skipped unless a
  model folder is named. Ben decides whether CI should cache the 550 MB model.
- **Second device.** The model runs on the server, so a second device only sees the result. No
  other device was reachable in this run.
- **First search after a restart.** It hashes the files once, which takes seconds in a release
  build and was not timed there.
- **Memory on Windows and macOS.** Peak memory was measured on Linux only.
- **Search order.** In the live run an unrelated fact ranked above one of two related facts.
  Ranking quality was not part of this part.
