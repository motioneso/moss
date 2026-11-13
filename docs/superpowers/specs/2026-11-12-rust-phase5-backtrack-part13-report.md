# Rust Phase 5, Backtrack part 13 report

## What was built

Backtrack is now a Rust package in `modules/backtrack`. It keeps the screen text a Mac companion sends, per person, for 37 days.

- Upload route from the Mac, with the clock check (a Mac clock more than two hours off gets a 422).
- Status, pause and delete routes. Delete takes a time range or deletes everything.
- An hourly sweep that removes text older than 37 days and delete markers older than 38 days.
- Account export and account delete. The export leaves out the search column and gives the hash as hex.
- The module cannot be switched off, so status, pause and delete are always reachable. Delete works with no Mac linked.
- The three tables use the old SQL file byte for byte. The build stops if one byte changes.
- The real server now loads the Backtrack ports (two lines in the shell).

## How privacy is kept

- Every database call filters by the signed-in person and runs inside that person's own row-level security.
- The sweep job runs per person. Its queued payload holds no screen text.
- Text is masked once more on the server before it is stored.
- A late upload that falls inside a deleted window is discarded.

## Proof

| Proof                                                                      | Where              |
| -------------------------------------------------------------------------- | ------------------ |
| 32 tests ported from the old TypeScript tests                              | native guest tests |
| Same code as WebAssembly, loaded by the real host, plus a package check    | package tests      |
| Two people, row security seen failing then passing on all three tables     | installed tests    |
| Pause stores nothing, resume stores again                                  | installed tests    |
| Clock 422, storage off 409, no linked Mac 401, delete with storage off     | installed tests    |
| Replayed upload adds nothing, late upload in a deleted window is discarded | installed tests    |
| Hourly sweep removes old text and markers for its owner only               | installed tests    |
| A planted marker never reaches 12 queue, module and activity tables        | installed tests    |
| Export holds only the caller's rows                                        | installed tests    |
| Real Rust server over HTTPS with two people                                | live run           |
| Removing the pause, clock, storage, overlap or lock check fails a test     | guard-removal runs |

## Not proven

- Real Mac hardware. Trail Marker was never run against this server. Ben needs to do this.
- Device pairing. Meetings part 7 is parked, so the "is this Mac linked" check is a fake in the tests. On the real server every Mac upload is refused (401) until pairing exists. Uploads that store rows are proven only through the fake link.
- Where the storage switch is set on the Rust server. The tests set it directly in the instance settings table. No screen sets it yet.
- The old Mac address `/api/companion/backtrack` is not mapped to the new module route `/ingest`. The shell needs that mapping.
- Part 14. Indexing into Memory is not built, so delete, sweep and export do not yet remove or include Memory chunks.
- The per-person lock that stops a late upload undoing a delete is proven by call order only. Two real simultaneous requests were not tested.
- No screens (part 15).

## Notes

- No Vikunja card was found for this task.
- The first live run answered 503 once on the first signed-in call, and passed on the next run. The cause was not found.
