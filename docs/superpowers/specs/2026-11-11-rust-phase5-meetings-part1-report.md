# Rust Phase 5: Meetings, part 1

Task JS-235. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

## What this part adds

A Meetings package in `~/Jarv1s/modules/meetings`. It covers meeting records, titles, personal notes and capture preferences, and nothing else from the Meetings plan.

- Eight routes, matching the old app: list, create, read and delete a record, rename it, save notes, read and save capture preferences.
- Notes save with a version check. A stale save is refused and returns the current notes. A repeated request key returns the original answer.
- Each person's records are private. Another person, including an administrator, gets the same answers as for a record that does not exist, and a delete of someone else's record answers 204 like a missing one.
- Capture preferences live in the existing account preferences table under six fixed keys. The package cannot pick other keys or other owners.
- The 17 existing Meetings SQL files ship byte for byte. Changing one byte stops the build.
- Three job queues are declared, with metadata-only payloads. Any job run is refused for now, because their handlers belong to later parts.
- Export returns the 18 collections of the old export. Two are real (records and note writes). The other 16 are empty until their parts land.
- The shell now wraps the preference port for Meetings.

## What was proven

| Check                            | How                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Logic matches the old rules      | 28 native tests against an in-memory host                                                                                            |
| Real package installs and serves | Test installs the signed package into a throwaway database and calls the routes                                                      |
| Two-person privacy               | Same checks as person B and as an admin: 404 or empty, no change to person A's data                                                  |
| Row security matters             | For records, note writes and preferences, the same check was seen to fail with row security off and pass again when restored         |
| SQL is untouched                 | A one-byte change to a copy fails with "Legacy Meetings SQL changed"                                                                 |
| Permissions                      | The manifest allows only the Meetings tables and the preference resource                                                             |
| Live run                         | Real Rust server over HTTPS: create, repeat, edit notes, stale edit refused, rename, preferences, second person sees nothing, delete |
| Text stays out of logs           | A planted marker in a title and notes never appears in the server log                                                                |

## Not proven

- Strict request validation is emulated by hand. The old app used Fastify schemas, and exact error text for every malformed body is not compared.
- No fixtures were exchanged with the old TypeScript code in both directions. Only the same rules were re-tested.
- No concurrency test. A rename and a notes save each put the expected value in the update filter, so a lost race returns a conflict. A sequential test shows the answer but not an actual race.
- The remembered-source approval card is refused until a later part.
- Chat classes are a constant in the package plus the approval-card API. The Rust manifest has no chat field yet.
- Job parameter kinds in the manifest are a guess.
- The two history backfills (SQL 0280 and 0292) run from the host's compiled copies, triggered by a marker line in the SQL. The `.backfill.mjs` files are not packaged. Neither was exercised against old data here.
- The log check was not seen failing with the protection removed, so it shows absence in this run only.
- The old routes capped a History search body at 4096 bytes (answer 413) and a transcript body at 512 KiB. The package does not enforce either, and whether the shell does was not checked.
- The replay test hides real ids behind a placeholder and does not compare the no-store header. A wrong owner id in a reply would pass. Steps marked as decided by the shell only print a note when they differ.
- A stored line with a lone surrogate reads back with the replacement character. Lengths and offsets are unchanged.
- No screen, no second device, no native app.

# Rust Phase 5: Meetings, part 2

Task JS-236. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027).
Release note Category: N/A.

## What part 2 adds

Transcript saving and reading, and the History routes, in the same Meetings package.

- Five routes: save a transcript batch, read a transcript, read the evidence for one range, search History, and read one History entry.
- Two new host resources, one for transcripts and one for History, declared in the manifest. The package still has no database access of its own.
- A larger compute budget for the package (200 million steps). A 200 KB save used up the old default.
- Row security is unchanged and stays forced on the new tables.

## What part 2 proved

| Check                                | How                                                                                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same answers as the old routes       | 160 steps in 6 scenarios were recorded from the old routes and replayed through the installed package. Status, body and no-store header match, except the four below. |
| Same stored rows                     | After each scenario, the rows the package wrote equal the rows the old code wrote.                                                                                    |
| Rows from the old code read the same | Rows the old code wrote were planted and read back through the package, for the five single-meeting scenarios.                                                        |
| Recording matches the old code       | The oracle check re-runs the old routes and finds the file unchanged. It records a placeholder for the random owner id.                                               |
| Two-person privacy                   | Another person and an administrator see no transcript and no History. For both new tables the check was seen to fail with row security off and pass when restored.    |
| Live run                             | Real server: save a transcript, read it back, search History, another person gets 404 and an empty list.                                                              |

Two fixes came out of the replay. Unknown query parameters are now ignored, as the old server did. A huge whole number in a query now reports the range error instead of "must be integer".

## Not proven in part 2

- Four malformed-body cases (not an object, empty body) are refused by the shell with its own error text, where the old route answered 400. The status is the same. The wording differs.
- The two-meeting scenario was not replayed against old rows, because the recording holds rows for the first meeting only.
- The history backfills (SQL 0280, 0292) have a real-database test from the module host work (phase 4b), not repeated here against transcript data from this part.
- Speed of the package was not measured. The compute budget was set from one failing 200 KB save.
- The log check for transcript text was not seen failing with the protection removed. It shows absence in this run only.
- The old routes capped a History search body at 4096 bytes (answer 413) and a transcript body at 512 KiB. The package does not enforce either, and whether the shell does was not checked.
- The replay test hides real ids behind a placeholder and does not compare the no-store header. A wrong owner id in a reply would pass. Steps marked as decided by the shell only print a note when they differ.
- A stored line with a lone surrogate reads back with the replacement character. Lengths and offsets are unchanged.
- No screen, no second device, no native app.

## Part 3: recording types, recording identity, pasted transcripts, speech port

### What part 3 added

- Four routes for recording types and each meeting's recording identity. A person keeps up to 32 recording types and picks one per meeting. A save must keep every existing type, and a stale save is refused.
- One route for pasting a transcript. It makes a meeting with its transcript in one step, and a repeated request key returns the first answer. It starts no summary yet.
- A new host port for speech to text. It sends one clip to the speech service the person has set up, and returns timed text. The package cannot choose the service or the model.
- The recording routes and the paste route share one database transaction per call, so a paste is all or nothing.
- The manifest declares the speech capability and a speech feature, and the route list has the five new routes.

### What part 3 proved

| Check                              | How                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same answers as the old routes     | Steps recorded from the old routes, including every error status, were replayed through the installed package.                                     |
| Rows written by either side        | Rows the old code wrote were planted and read through the package. Rows the package wrote equal the old code's rows.                               |
| Two-person privacy                 | Another person and an administrator get 404 on every new route. The check was seen to fail with the protection removed, and pass with it restored. |
| No text in records                 | A marker planted in type names and pasted text never appears in the job queue or the two activity tables.                                          |
| Speech port against a fake service | The fake receives the exact bytes. It also produced every refusal, a moved route before sending, and a moved route during the request.             |
| Builds and tests                   | The native and WebAssembly builds and tests ran through the full Meetings gate.                                                                    |
| Live run                           | Real server: save types, paste a transcript, repeat the key, read it back, and another person gets 404 on each route.                              |

### Not proven in part 3

- The old routes capped request bodies at 65,536 and 524,288 bytes. The package does not enforce either cap.
- The date checks approximate the old server's date parsing. Odd spellings may differ.
- The chat approval card for saving recording types is not built.
- Pasted transcripts schedule no summary. That belongs to part 4.
- The old "queue unavailable" answer does not apply, because nothing is queued.
- Two calls racing at the same moment were not tested with a real race.
- The size of a stored value in bytes may differ from the old code for unusual number spellings.
- Lowercasing of names may differ from the old code for rare characters.
- Malformed JSON bodies are refused by the shell with its own text, as in part 2.
- The speech input shape, and the language and prompt length limits, are guesses until a real service is tried.
- No real speech service was called. Timing quality of a real service is unproven.
- A clip of the full 3.8 MB cannot reach the port, because one module message is limited to 1 MiB. Larger clips need a higher limit for this port, or a chunked call.
- No screen, no ring, no Mac recorder, no summaries.

## Part 4, slice A (summary logic)

Slice A ports the logic that writes a summary. It touches no database and no route.

### What slice A built

- Four summary templates (general, one-to-one, project review, interview), each version 1.
- A prompt builder. Meeting text goes in as escaped data, so it cannot close a delimiter or pass as an instruction. The prompt is capped at 65,536 bytes.
- An answer checker. It enforces the size limits, requires every citation to point at real transcript or notes text, and refuses ranges that split a character.
- A long-meeting runner. It cuts evidence into pieces, carries a running summary forward, and trims in a fixed order when a prompt is too big.
- One retry per piece on an unreadable or invalid answer, then a stored rejection code.
- The model call is a trait. In the package it will be the router's summarization route, and no provider is named.

### What slice A proved

| Check                        | How                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Escaping                     | Meeting text appears in the prompt only as escaped data.                                                             |
| Every citation failure       | One test per refusal reason, plus a surrogate pair split.                                                            |
| Size limits                  | Total character cap, byte cap across a long meeting in several pieces, and a single huge segment cut with a warning. |
| Retry and failure codes      | One retry then rejection, fenced answers accepted, timeout and provider failure codes.                               |
| Piece coverage and citations | Every segment lands in a piece, and notes citations shift back to full-notes offsets.                                |

All 13 tests use a scripted fake model.

### Not proven in slice A

- No storage layer, so no request keys, no immutable versions, no stale marks, no action candidates.
- No routes and no manifest entries for summaries.
- No stop-summary job and no automatic summary on stop.
- No real-database test and no live run.
- No real model was called. Prompt quality against a real route is unproven.
- A long meeting may exceed the call deadline, because one route call is one transaction.
- The old app also summarised recording and speaker data. Slice A keeps only the five core fields.
- The WebAssembly build and the full gate did not run. The worktree has no node_modules and the build cache lacked one crate offline. Native guest tests ran (all 12 files pass).
- Prettier did not run, because it is not installed here.

## Part 4, slice B (storage, routes, automatic summary)

Slice B connects the summary logic to the database, the routes and a background job.

### What slice B built

- Storage for versioned summaries, request keys, action candidates and the one automatic-summary row per meeting. The old SQL is unchanged.
- Five routes: summary availability, list a meeting's summaries, read one version, generate, and edit.
- Generate and edit run in one transaction under the meeting lock. A saved answer replays on a repeated key. Versions never change after they are saved. A later edit to notes or transcript marks older versions stale.
- A background job that writes the automatic summary. Its payload holds only the meeting id.
- A pasted transcript always asks for an automatic summary, in the same transaction as the paste.
- Manifest entries and app-map features for summaries and automatic summary.

### What slice B proved

| Check                    | How                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Generate, replay, edit   | Real database with a scripted model. Repeat key, conflicts with current versions, edits, immutable versions and stale marks.           |
| A bad model answer       | Stored as a failed result and replayed unchanged.                                                                                      |
| Two-person privacy       | Another person and an administrator get 404 on every summary route. Seen leaking with row security removed, and fixed when restored.   |
| No text in the queue     | Summary text never appears in a job payload. A pasted transcript queues a job holding only the meeting id.                             |
| Pasted transcript to job | The queued job ran and saved a summary through the scripted model.                                                                     |
| Builds and tests         | Native and WebAssembly builds, and the full Meetings gate, passed.                                                                     |
| Live run                 | Real server: a summary request ends cleanly with no model set up, the list route works, another person gets 404 on each summary route. |
| Text stays out of logs   | The planted marker never appears in the server log.                                                                                    |

### Not proven in slice B

- No real model was called. Summary quality is unproven. The live run ran with no model, so it shows the stored failure and not a saved summary.
- Fixtures recorded from the old code were not exchanged in both directions for summary routes. Rules were re-tested against the old behaviour by reading it.
- The old instruction scan on summaries is not ported.
- Recording and speaker data are not part of a summary.
- The availability route always says a model may be used, with no real probe.
- Capture stop and recording import do not schedule an automatic summary yet. Only a pasted transcript does.
- The 524,288 byte body cap on edit is not enforced.
- The review route for action candidates (accept or dismiss) is not built.
- The chat approval card for editing a summary is not built, so chat refuses that edit.
- A long meeting may exceed the call deadline, because one route call is one transaction.
- Two calls racing at the same moment were not tested with a real race.
- The failed-result codes are not yet listed in the app map as errors.
- The model call runs while the meeting row is locked, so notes saved or summaries listed during a long generate can wait and time out. The old app held no lock during the call. The "busy" and "pending" answers therefore cannot occur.
- If the job fails to publish after a pasted transcript is saved, a retry returns the first answer and queues nothing, so the summary stays waiting until it expires.

## Part 5 (JS-251), partly built

Only action review is built. Private export, the full account export and deletion are not.

### Built

- A signed-in owner can accept or dismiss an action item that a summary proposed from their own meeting.
- Accepting creates one task in the owner's own Tasks. Meetings calls a new Tasks public call, so it never reads Tasks tables. The call is keyed on the meeting and the action, so a repeat or a regenerated summary makes no second task.
- The route is `POST /api/meetings/records/:id/actions/:candidateId/review`. It replays by request key and refuses a changed repeat with 409.
- Accept is refused with 409 while possible matches exist, unless the owner confirms. The title (1 to 500 characters) and the due time are checked again before the task is made.
- If Tasks is not installed or fails, the answer is 503 and the action stays pending.
- Tasks moved to version 0.1.2. Meetings does not require Tasks to install. Without it, accepting answers 503.
- The manifest lists the route, the Tasks permission and four new errors. The chat approval list marks the route as blocked in chat.

### Proof

| Check                | Result                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task creation        | Tasks tests with a fake host show a repeated key returns the same task and adds no row.                                                                                |
| Accept and dismiss   | Five Meetings tests with a fake host cover accept, replay, changed replay, conflict, missing action, match confirmation, bad title, bad due time, Tasks down, dismiss. |
| Two-person privacy   | Real database. Another person and an administrator get 404. Seen leaking when row security was removed on the three tables, and fixed when restored.                   |
| No text in the queue | The test marker never appears in the job queue.                                                                                                                        |

### Not proven

- Private export through Notes is not built. The create-only conflict rule is untested.
- Only 2 of the 18 account export collections are real. The other 16, including audio chunks and the old bundle format, are still empty stubs.
- Deletion is not built. Notes has no fence, seal or recording cleanup in Rust, and Meetings does not yet answer Memory's recording authority. The chat cleanup callback does not exist.
- Accepting was proved against a fake Tasks host. The real database test installs Meetings alone.

## Part 5B (JS-253), export built, deletion not built

### What was built

- **Private export of a summary into Notes.** Saving an export sends the rendered summary to the Notes module, which stores a private copy in the owner's own notes. Each summary version can be exported once. Asking again with the same key returns the first answer. Reusing a key for a different version is refused. If the saved copy was edited or deleted, it is never overwritten or recreated. A lost answer from Notes is recovered by checking whether the copy already exists.
- **Plain-text match.** The rendered text matches the old TypeScript output byte for byte on a recorded sample.
- **Account export section.** The section now returns all 18 collections. Sixteen are read straight from the database in the host so that times are formatted exactly as the old export did. Ready recording imports carry their stored audio, either as chunks with size and sha256 hash checked against the saved row, or as the retained legacy bundle text. A missing or altered file makes the export fail loudly.
- **Fix to part 5A.** The Meetings component never declared the call into other modules, so the Tasks accept path from 5A could only work against a fake host. It is declared now, and Notes uses the same call.

### What was proved

- Native and WebAssembly builds pass with tests in both (12 new export tests against a stand-in Notes, plus the existing ones).
- Real database tests: replay, key reuse, missing version, another person and the admin both get 404 on the export routes, and the row-level-security test fails when the protection is removed (the second person then sees the rows) and passes again once restored.
- The account export test round-trips audio bytes and hashes, the legacy bundle text, millisecond times, and shows a second person sees nothing.
- A marker planted in the summary never appears in queued jobs, activity rows, model activity rows, or stored receipts.
- Live run on the real Rust server: the export routes answer for the owner, refuse cleanly when no summary exists, and show nothing to a second person. The server log holds no meeting text.

### Not built

- **Deletion service and chat cleanup.** Not started. Notes cleanup of recording blocks needs a database-backed Notes cleanup that does not exist in Rust yet, and it is large. Memory cleanup likewise. No recording content reaches Notes or Memory until part 6 builds those hooks, so the existing delete route from part 1 stays as it is. What is left: the fence, the Notes and Memory cleanup calls, the seal, the refusal on a conflict, and the survivor and no-searchable-content proofs.
- **Writing recording audio** is part 8. The export reads it from the Meetings account folder where part 8 will write it.

### Not proven

- A real Notes copy created through the installed Notes module. The database test packs Meetings without Notes, so it sees a failed receipt, and the Notes behaviour is only proved against a stand-in. The live run also has no Notes.
- The export index stays "delayed", because Notes cannot index private copies yet.
- The account export through the real server. No server route for it exists yet, so it is proved only by calling the section directly.
- A live summary export, because no model is configured on the live instance.
- Survivors after delete, and no searchable recording content after delete. Both belong to the deletion service.

## Part 5C (JS-255), stopped before building: Notes cleanup is large

No code changed in this part. The check the brief asked for found that one of the two cleanup ports is missing and too big to add inside the deletion part.

### What exists in Rust

- **Memory cleanup is built.** The Memory package already answers `cleanup`, `assertComplete` and `retireSource` for recording episodes, facts and search documents, in batches of twenty receipts. It asks a recording authority whether a source is being cleaned and whether it is sealed. Until Meetings supplies that authority, the answer is always no, so nothing is admitted.
- **Notes tables exist.** The managed actor, managed source, contribution, proposal and operation tables are created by the Notes package migrations and are already read by the Notes account export.

### What is missing

- **Notes has no fence or seal.** Nothing in Rust fences an actor or a source, opens a cleanup operation, seals it, or deletes under a seal. The old code is about 485 lines (`managed-source-lifecycle.ts`) plus about 70 lines of database lock helpers in `packages/db/src/managed-source-admission.ts`.
- **Notes has no database-backed recording block cleanup.** The pure block text logic (render, inspect, change, cleanup with conflict detection, reconcile) and the block and snapshot keys are already ported in `blocks.rs` and `identity.rs`. Missing is destination lookup, the vault file change with conflict detection, receipt state and index invalidation. The old code is about 240 lines (`recording-contribution-cleanup.ts`), 240 (`contribution-destinations.ts`), 180 (`contribution-repository.ts`) and 110 (`contribution-state.ts`).
- **Meetings has no deletion service and no authority.** The Meetings side of the old order (`deletion-service.ts`, 59 lines) is small, but it cannot be tested without the two ports above.

### Why it stops here

Together this is more than one context window of build and proof: a Notes lifecycle, Notes cleanup, the cross-module calls between Meetings, Notes and Memory, the authority that Memory asks, and then the proofs. Doing it half-way would leave a deletion that cannot refuse correctly, which is worse than none.

### What is left, in order

1. **Notes managed-source lifecycle.** Fence actor and source, open and read operations, seal, delete under seal. Public Notes API only. Two-person row-level-security tests seen failing with protection removed.
2. **Notes recording block cleanup.** Batch of twenty, separate commits per file, conflict and pending outcomes, index invalidation, source receipt retirement in the sealing step.
3. **Meetings deletion service and authority.** Fence the source, clean Notes, clean Memory, seal, then delete the meeting. Incomplete or conflicting cleanup refuses deletion with the same two plain errors as before. Implements the Memory recording authority. The chat cleanup callback and the delete route.
4. **Proofs.** Survivors after delete (independent exported note copies stay), nothing searchable left, refused deletion on incomplete cleanup, second person denied, no meeting text in jobs, activity rows or logs, native and WebAssembly builds, and a live run on the real Rust server with a real Notes copy and the account export through the server.

No recording content reaches Notes or Memory until part 6 builds the hooks that write it, so nothing is currently left behind by a meeting that is deleted. The deletion service still has to land before part 6 ships.

### Not proven

Everything in the 5C proof list. Nothing was built or run in this part.

## Part 6: the model reads each recording

### What was built

- After a summary run, the model also reads the recording. It picks a type, a title for an untitled meeting, personal or work, a confidence, a reason and groups of ideas.
- A person's own type choice and a title they set themselves are never overwritten.
- A reading below 80% confidence posts a chat message to the owner asking them to check the side.
- Each idea becomes a Memory fact through Memory's public interface, on the same side as the recording. Work recordings never write personal facts and the reverse.
- The context for the model comes from Calendar and People through their public interfaces, as the owner. Meetings now requires Calendar, People and Memory at install.
- Meetings answers Memory's question "does this recording's reading exist for this owner", under row-level security.
- Meeting text stays out of job payloads, activity rows and logs. Jobs carry only the meeting id.

### What part 6 proved

| Check                | How                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading is filed     | Real database with a scripted model. Type, side, confidence and version are stored.                                                                                               |
| Low confidence       | Only the doubtful reading posts a chat message. A sure reading posts nothing.                                                                                                     |
| Memory facts         | Personal ideas became personal facts and work ideas became work facts. Running the jobs again added nothing.                                                                      |
| Two-person privacy   | Another person gets nothing from Meetings' check. Seen leaking with row security removed, and fixed when restored.                                                                |
| No text in the queue | A planted marker in an idea never appears in job payloads or activity rows.                                                                                                       |
| Live run             | Real Rust server over HTTPS with Memory as the real package. Meetings installs with Calendar, People and Memory present, and its routes still keep each person's records private. |
| Builds and tests     | Native and WebAssembly builds, and the full Meetings gate, passed.                                                                                                                |

### Not proven in part 6

- No real model was called, so reading quality is unproven.
- No real Main chat was used. Tests use a recording stand-in for chat.
- The context pack holds no Memory facts, no owner name and no Calendar attendee names yet.
- The old instruction scan on outside text is not ported.
- Memory's "being cleaned" and "sealed" states always read false until part 5 lands.
- The chat-message job recomputes whether the reading is doubtful, instead of carrying that from the run.
- Calendar and People were empty stand-ins in the tests and the live run, so the real context pack was never filled from them on a live server.
- The live run did not read a real recording, because no real model was set up. It proves install and routes only.
- Running the memory job twice for the same reading was not tested end to end. It relies on each idea having a fixed key in Memory. Only the stable job key is unit tested.
- When Memory is unreachable or fails, the memory job fails and retries. When Memory refuses on purpose (the recording changed or is being removed), the idea is skipped.
