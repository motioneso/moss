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
- No concurrency test. One winner for a revision relies on the filter on the expected revision.
- The remembered-source approval card is refused until a later part.
- Chat classes are a constant in the package plus the approval-card API. The Rust manifest has no chat field yet.
- Job parameter kinds in the manifest are a guess.
- The two history backfills (SQL 0280 and 0292) run from the host's compiled copies, triggered by a marker line in the SQL. The `.backfill.mjs` files are not packaged. Neither was exercised against old data here.
- No screen, no second device, no native app.
