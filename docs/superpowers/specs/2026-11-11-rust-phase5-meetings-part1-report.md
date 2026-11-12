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
- No screen, no second device, no native app.
