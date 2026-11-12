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
- Tasks moved to version 0.1.2. Meetings now requires it.
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
