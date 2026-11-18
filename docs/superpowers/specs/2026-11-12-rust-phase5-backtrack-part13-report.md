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
- Part 14 is covered in the Part 14 section below.
- The per-person lock that stops a late upload undoing a delete is proven by call order only. Two real simultaneous requests were not tested.
- No screens (part 15).

## Notes

- No Vikunja card was found for this task.
- Two live runs answered 503 on the first signed-in call. The server returns 503 until its module host has finished starting, so the live test now waits for that and then passes.

## Part 14: search index job

### What was built

- Screen text now goes into Memory's search. A job embeds each stored segment under the path `backtrack/<segment id>`, kind `screen`, using Memory's existing embedding service. Embedding goes through the model router, so the person's own configured model is used.
- Long text is cut into pieces of at most 500 estimated tokens. The cutting rules and their nine tests come from the old TypeScript version.
- The job runs after an upload, and the hourly sweep queues it again for anything left waiting over ten minutes. It carries no text, only the person's identity, and it picks its own work from the stored rows.
- Deleting history, and the sweep that removes text older than 37 days, remove the search pieces first and the rows second. If Memory is down, the text and the delete marker stay, so nothing is left behind in search.
- One index run reads a limited amount of text, and a larger backlog continues in follow-up runs. Each request queues its run under a fresh key, so no upload is dropped as a repeat. An extra run finds nothing and ends.
- Which segments are indexed is kept in a new table of marks. The module cannot change the old segment table's permissions, so the marks live beside it.
- Backtrack now needs Memory installed. The manifest and the app map describe the new behavior.

### Proof

- The nine chunk-budget tests ported from the old version pass, natively and as WebAssembly.
- With a real Memory package and a fake embedder, an upload gives one search piece under the right path and a mark.
- Deleting two segments removed both search pieces.
- A second person cannot see the first person's pieces or marks. The check was seen failing: with row security switched off on Memory's table, the second person saw 15 pieces.
- Screen text planted in two accounts was not found in any of twelve tables (queue, module, activity, errors), after the jobs ran.
- Text older than 37 days gets no search piece. When the embedder fails, the text stays and the sweep queues it again.
- Live run on the real Rust server with Memory and Backtrack both installed, over HTTPS, for two people. A second device (the Mac, over the private network) asked the same server for status and got a refusal when signed out and an answer when signed in. The server needs a few seconds to load both packages, so the first signed-in request can be refused with a busy answer until it is ready.

### Not proven (part 14)

- The Mac check was run before the last review fixes. When the final gate ran, the Mac could not be reached over the private network, so that last run covered the server only.
- The compute cost of indexing one full-size 8 KB segment was not measured.
- A real embedding pass. The tests use a fake embedder, so no real model embedded real screen text. Ben needs to try this with his own model.
- Device pairing. A real Mac still cannot upload, so no real upload reached the index job on the live server. Indexing from uploads is proven only through the fake link.
- Searching the text. Search results and the screen are part 15.
