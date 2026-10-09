# #3191 provider-restore live test: diagnosis and fix

## What failed

The full live test for #3191 failed once on the shared scheduled branch at `02b3103`. It turns the
saved chat provider off, edits a draft, turns the provider back on, reloads, and presses Enter. The
test then waited 120 seconds for a chat reply and timed out. Every earlier step had passed, and the
edited draft was still in the message box when it failed.

## Cause

After a reload, the chat drawer shows the recovered draft before Main chat history has loaded.
Until history loads, the message box and Send are disabled, so a key press is ignored. The test
pressed Enter as soon as the draft text appeared. If history was still loading at that moment, no
message was sent and the test waited for a reply that could never come.

This matches the failure, because the draft was still in the box, so nothing was sent. It is the
most likely cause, not a proven one, because the failed run did not record whether Send was enabled
when Enter was pressed. A later diagnostic run with Send already enabled passed.

The product behaviour is correct. A real user cannot type into or send from a disabled box, so no
draft is lost. No product code or app-map entry changed.

## Fix

- The live test waits for Send to be enabled before both of its manual sends.
- The final send checks that the request leaves the browser within 10 seconds, alongside the
  unchanged 120-second reply deadline. A future failure will show whether the request was sent.
- A new unit test renders the real chat stream and drawer with history held back. It shows the
  message box and Send are disabled and Enter sends nothing. After history loads, one Enter sends
  the recovered draft exactly once.

No assertion was weakened, no response was faked or rewritten, and no blanket timeout was added.

## Checks on the diagnosis branch

| Check                                                       | Result                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| ESLint and Prettier on changed files                        | pass                                                   |
| Type checks, app and tests                                  | pass                                                   |
| Recovery unit test file                                     | 15 of 15 pass                                          |
| 21 affected chat unit files                                 | 224 pass, 2 fail (known Meeting failures, owned by #3193) |
| Same 21 files, three runs at once for load                  | identical result each time                             |
| Real live test through `scripts/run-gate.sh`                | pass, rc 0                                             |

The live run used commit `98e6c10`, a clean tree, gate fingerprint
`sha256:b69a406e9321b30ae040ca81b58cc097328042be16261f7cf94fd6151761413d`, a freshly built image,
the real installed Finance package and the configured economy provider. Both of the test's own
assertion lines printed, and one test passed in 56.8 seconds. The disposable instance's containers,
volumes and networks were removed afterwards.

## Review

An independent reviewer found one must-fix. The new unit test's cleanup removed the fake browser
window that the rest of the file depends on, so it passed only when it ran last. The cleanup now
restores only what the test replaced. Two of the reviewer's optional suggestions were applied as
well. The test now checks the message box is disabled, and it resets the deferred history mock.

## Known gaps

- Running the recovery test file in shuffled order fails one older test, about delayed speech and
  two starters, under some orders. It fails the same way with the new test skipped, so it predates
  this change and needs its own fix.
- Private run logs and harness hashes from the earlier diagnosis are kept outside the repository,
  under `/tmp/moss-scheduled-implementation/3191/restore-diagnosis/`.
