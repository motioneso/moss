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

| Claim                                         | Evidence                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vectors match the old app                     | 14 fixed texts, short and long, unicode and code. Lowest similarity 0.9999997, and 1.0000000 for a 12,000 character text cut at 512 tokens                                                  |
| Peak memory at the longest input              | 879 MB after loading, 928 MB peak after a 512-token input (release build, Linux)                                                                                                            |
| Download, cut-and-resume, refusal, bad hash   | 9 tests against a local server, passing. They cover the first download, resume from byte 100000, a server that ignores ranges, a 503, a bad hash, and a damaged file kept at its right size |
| Folder lock                                   | Test where a second process waits, gives up with a plain sentence, and then succeeds                                                                                                        |
| Prefixes and activity rows on the device path | Host test. Text planted in a search reached the model, and appeared in no row, answer or failure sentence                                                                                   |
| Live, real server over HTTPS, no endpoint     | The gate downloaded the real model in 83 seconds with progress read from the settings route, saved facts, and a search by meaning returned the right fact first                             |

The live run found a real fault. The first search after the download hashed the whole file again
and ran out of time in a debug build. The download now marks the files as checked, but only when every file was fetched and hash-checked in that run.

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

### Review round 1 (Codex), fixed

- **Major.** A damaged file of the right size was trusted when another file had just downloaded.
  The whole-file check is now skipped only after a run that fetched and checked every file. A new
  test covers it and fails without the fix.
- **Major.** A queued search could wait past its time limit before it ran. Queue and run now share
  one deadline.

### Review round 2 (Codex), fixed

- **Major.** A full request queue made a search wait with no limit. A full queue now answers
  "busy" at once, and the wait for the answer uses the time left.
- **Major.** Removing damaged files happened before taking the folder lock, so two processes could
  delete each other's fresh files. The check and removal now run under the lock, and only files
  that fail their hash are removed. A new test covers it.

## Part 9: recording memory (JS-245)

### What was built

- **Facts from recordings, kept per person.** Fact versions, one receipt per recording item,
  proposals, shared-fact lineage, cleanup and export now live in the Rust Memory package. The
  rules, status codes and error wording match the old code.
- **Preparing and applying.** A proposal is prepared first and applied second. Applying embeds the
  text between two short database transactions, so no lock is held while the search model runs. A
  failed embedding publishes the fact without a vector and the search index fills it in later.
- **Undo, restore and side change** reverse or move a fact without making a second one.
- **Cleanup** works in batches of twenty receipts and reports whether work remains. Removing a
  recording deletes the facts that no other recording supports.
- **Export** returns the person's fact versions, receipts and proposals in the old shapes.
- **Meetings is a stand-in.** Meetings is not ported, so a small interface answers "what is this
  recording's current state" and "is its removal open". Until Meetings is connected, every change
  is refused with the old "has changed or is being removed" message.
- **No screens.** The Meetings screen joins when Meetings is ported.

### Proof

- A second person cannot read, apply or export the first person's recording memory. The check was
  seen failing with row-level security switched off on the three recording tables.
- Fact text never appeared in job payloads or the activity tables that exist in the test database.
  The same text was found in the memory table, so the search was not empty.
- The full flow (apply, replay, change, undo, restore, side change, stale revision conflict) runs
  through the real built module and the real database.
- Removal deletes the fact and clears the receipts only after the removal is open and sealed.
- Bad text and bad sources get the old messages and statuses.
- Rows written by the old TypeScript service read back the same in Rust, and the reverse. The
  receipts and the whole export are compared for equality.
- Native and WebAssembly builds both pass their tests.

### Not proven

- **A live run through the real server's web address.** No web route exposes this API, and the
  old code had none either. The proof runs through the real module host and database instead. The
  live gate was run to check that the package still installs and serves its routes.
- **Real Meetings behaviour.** The tests use a stand-in whose answers they control. The real
  generation and removal rules arrive with the Meetings port.
- **Changing a recording fact from the Memory screen's confirm and correct.** Those routes still
  refuse recording facts, as in part 3. Wiring them to lineage waits for Meetings.
- **Receipt ids across implementations.** Both sides derive the id the same way, and the
  round-trip test reads each other's rows, but the id was not compared for old rows from before
  this task.
- **Heavy concurrency.** Locks fail fast and report a change. No test ran two people changing the
  same recording at once.

## Part 7: re-embed with a safe swap (JS-246)

### What it does

- When the search model changes, passages saved under the old model are kept, but note search skips them until a re-embed finishes. A note on the Search model screen says "N passages use another model", with a Re-embed button.
- Re-embed works in small batches of 16. New vectors go into a holding table. Nothing real changes until every passage has one.
- When the last batch lands, one transaction moves all of them in and marks the run done. Cancel, a failure, or a restart only throws away the held vectors. The old ones stay in the database. Because search only reads vectors made by the current model, note search returns nothing from old passages while a run is going (facts only lose their vector score). That is a product call for the coordinator: staging empties note search during a run.
- A passage whose text was edited after its new vector was made keeps its old vector. The swap checks a hash of the text.
- Search never mixes models. A passage made by another model counts as zero similarity, so it cannot be compared with a query from the current model.
- Facts saved without a vector (the embedding service was down) are retried on the existing 15 minute tick.
- Jobs carry only the run id. No passage text, vector or secret goes into a job.
- Only the Search model screen changed. The approved Memory screen is untouched (ruling relayed by t6n, who will ask Ben about a Memory screen spot).

### Behaviour change to know about

The 15 minute sweep used to re-embed everything when the model name changed. It no longer does. A new model name only shows the notice. The owner starts the re-embed. The test that covered the old behaviour was renamed and now asserts the new one.

### Proof

- Database suite (10 tests, real Postgres): interrupted run leaves old vectors usable and a restart finishes it; a completed run swaps everything at once; cancel drops what was staged; a failed embedding ends the run with old vectors intact; an edit after staging keeps the old vector; search never compares two models; retry on the tick; refused starts; job payload holds only the run id; and a second person cannot see, step or cancel the first person's run. That last test was also run with row security switched off on the two tables, and the second person then sees the rows, so the protection is what hides them.
- Native and WebAssembly builds both pass their tests (guest unit tests: 5 new).
- Live run on the real Rust server over HTTPS (port from devports): switching the model name showed "4 passages use another model", a run finished and the count went to 0, search still worked, a second start was refused, and a cancel was clean. The Search model screen was opened in a real browser: the note and Re-embed button showed, and the click started the run.

### Platform finding

The two new tables belong to the module, so only the module's own database role can reach them. The app connection does not have those grants. The host adapter therefore switches to the module role for each statement on those tables and back for passages and facts, inside one transaction. Module tables created later will need the same.

### Not proven

- A run of tens of thousands of passages: the final swap and each batch must fit one job's time limit, and nothing timed it.
- A re-embed on a second person's data while the first runs at the same time, beyond the row-level test.
- The other indexing path (note ingest) still re-embeds a note when it sees a new model name, so it can overlap a run.
- The file index keeps the old model name after a swap.
- A changed model version with the same name is not noticed.
- The progress total can drift if passages are added mid-run.

### Guesses

- Batch of 16 per step, and one running run per person.
- Wording of the screen note and the two refusal messages.
- Retry of missing vectors reuses the existing 15 minute tick instead of its own timer.

### Stray download

`npx prettier` fetched version 3.10.0 once by mistake. Its output matched the repo's 3.8.3. All checks since use the repo's own copy.

### Not proven

- The Memory screen has no re-embed note (by ruling), so nobody sees it there.
- The live cancel can land after a tiny run already finished. The database suite proves cancel; the live run only proves it ends cleanly.
- The on-device model path was not re-run for part 7.
- No test with thousands of passages. The swap runs in slices of 500, untimed at scale.
- Old browser tests were not run (Rust-only change).

## Part 8: the public API for other modules (JS-248)

### What was built

- **One door for other modules.** Briefings, Wellness, Goals, People, Backtrack, Notes and chat now
  have 25 new named calls into Memory, listed in the Memory manifest. They cover searching and listing
  passages, recalling facts, chat's per-turn write, the chat memory list with its rejections,
  suggestions to review, and goal entities.
- **The owner comes from the session.** No call takes an owner or a vector. A caller sends text,
  and the host turns it into a vector and sends it only to the configured search model.
- **Old callers keep their shapes.** Status codes, error sentences, the 500 path limit, the chat
  turn text and hash, and the rejection rule (only an active inferred fact can be rejected) match
  the old code.
- **Where it differs.** Callers send text, not vectors. Forgetting a goal archives it, because the
  old status value was refused by the table. Search here does not filter by search model, because
  that filter arrives with part 7. A failed embedding returns a plain 503.
- **App map.** A new feature entry describes the API and its one failure, with a fix-it link.

### Proof

| Check                                         | Result                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Guest tests, native                           | 7 suites pass, 6 of them new tests for this part, with a fake host                                                                                           |
| Package test, real WebAssembly build          | 9 pass, including the manifest and app-map checks                                                                                                            |
| Database tests, real WebAssembly and Postgres | 15 pass, 5 new. They cover each old caller's call shape, the old chat fact rules, suggestions and goals, owner isolation, and a scan for leaked text         |
| Owner isolation                               | A second person reads and changes nothing. With row security switched off the test first shows A's rows are visible, then shows the owner filter alone holds |
| No memory text in logs, jobs or activity      | A scan of tables named like job, activity, audit, event, outbox or queue, plus error sentences, found none after planted text                                |

The tests found one real fault. The call name shared a field with an entity's own name, so goals
were saved and renamed as "createEntity" or "updateEntity". The call name now has its own field,
and the tests pass.

### Not proven

- **No live caller run.** No Rust module that calls Memory exists yet, and chat is not ported, so
  nothing could call the API through the real server. The proof runs the real package and real
  Postgres, but not a second module. A chat answer showing memory provenance was not produced.
- **Managed snapshot guard.** The old chunk write refused to replace chunks owned by a managed
  vault snapshot. The Rust vault index writes none yet, so nothing breaks today, but the managed
  vault index work must port that guard before callers can write vault chunks.
- **Dates.** Dates now arrive as ISO text where the old repositories returned date objects.
- **Extra cross-owner cases.** The isolation test does not drive adding an alias, a candidate
  with another person's episode, or a suppression against another person's data. The owner
  filter and composite keys cover them by reading, not by test.
- **Notes search.** It still uses the existing adapter. Part 7 edits that file, so it was left alone.
- **Search model filter.** Search does not filter by model until part 7 lands.
- **Old callers' exact call shapes.** They are matched from reading the old code, not by running
  the old callers against the new API.
- **Log claim.** The scan covers the tables named above and error text. It does not read server
  log files.
- **Other devices.** Nothing here is reached from a phone or another machine, because no caller exists.

## Part 10: export and deletion of a person's memory (JS-254)

### What was built

- **Export.** When a person exports their account data, Memory returns fourteen sections of their
  own rows (passages, chat facts, entities, facts, episodes, fact sources, aliases, conflict
  groups, suggestions, search documents, legacy migration marks) and three recording sections (fact versions, receipts, proposals). Rows
  come in pages of at most 200 rows or 48 KB, because the guest has a fixed compute budget per
  call and the host refuses messages over 1 MiB. Vectors are never returned. The text excerpt a
  suggestion carries is dropped, as in the old export.
- **Deletion.** One call removes the signed-in person's rows from all 19 owned tables, module
  tables first, recording fact versions last, and returns counts only. Fact versions have no
  delete grant, so the manifest now names them in `ownerDelete` and the host emits an owner-only
  delete policy at install.
- **Owner never comes from the caller.** Both calls reject any owner field.
- **App map.** A new `memory.account` feature entry describes both calls.
- **Packaging.** The package builds (213,936 bytes) with the new resource, two provided calls and
  the `ownerDelete` grant. The package test covers them.

### Proof

| Check                                 | Result                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native and WebAssembly builds         | Guest tests pass natively. The WebAssembly build and package tests pass against it.                                                                                                                             |
| Earlier memory suites on this branch  | db 15, dashboard 9, recording 7, reembed 11 pass, package 7 pass.                                                                                                                                               |
| Export and deletion, second person    | 4 account tests pass. A second person exports none of the first person's text or id. Deletion leaves the second person's rows unchanged, row count by table.                                                    |
| Protection removed                    | With row security off on the memory tables, an unfiltered read as the second person returns the first person's rows. With it on, only the person's own rows.                                                    |
| Deleting a person removes derivatives | Deleting the user row leaves zero rows in all 19 tables, including fact versions and search documents.                                                                                                          |
| No memory text in jobs or activity    | A marker string, exported and deleted, appears in no job payload and none of the activity tables that exist in the gate database.                                                                               |
| Upgrade from an existing install      | On a copy of the dev data (3 owners, 1,428 old passages, none of the new tables), after installing the new tables and grants, 1,896 rows read back, equal to each table's count per owner. The copy is deleted. |

### Not proven

- **Whole-module live pass.** The live gate does not build here, because the shell build needs a
  prebuilt ONNX Runtime and the gate forces offline mode. No real model pass was run, and Ben is
  needed for that one.
- **Export parity with the old export.** Sections were compared to table counts and checked for
  fields by hand, not byte for byte against the old collector.
- **Recording receipts and proposals in the delete test.** They are covered by the recording
  suite's own cleanup tests, not seeded here.
- **Activity tables missing from the gate database.** The three activity tables were skipped
  there, so only job payloads were scanned in that database.
- **The `chat_memory_corrections_log` table** is not in the owned list and is not exported or
  deleted by this part.
- **Pages bounded by the byte cap.** The multi-page test proves the row cap and exactly-once delivery on 450 rows; the 48 KB cap itself is not asserted separately.
