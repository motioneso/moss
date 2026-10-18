# Runner for the eight remaining browser specs

This package is an authoring deliverable only.
It grants no permission to prepare, build, sign in, or run tests.
No build, test, container command, or provider command was run while authoring it.

## Source and order

The source is the immutable commit 9139da579aa3cd1ba99a039edd24a739c0ec0128.
The source repository is read only.
Preparation exports that commit into a private campaign directory.
The original source bytes remain unchanged.
Only extracted directory permissions are normalized for the service account.

| Spec | Original seconds per test | Seed profile |
| --- | ---: | --- |
| runtime-context | 300 | admin+data |
| 3134-reminder-notifications | 600 | solo-admin |
| 3135-reminder-edits-real | 720 | solo-admin |
| 3136-repeating-reminders-real | 720 | solo-admin |
| 3138-repeating-useful-checks-real | 900 | solo-admin |
| 3148-side-chat-destination-real | 720 | solo-admin |
| 3151-scheduled-owner-read | 600 | solo-admin |
| 3152-configured-source-report | 600 | solo-admin |

The runner lists every expected test title exactly.
The first file contains four tests.
Each remaining file contains one test.
Each file is invoked separately, in the order above.
There is one worker and zero retries.
A failure stops the campaign and marks later tests as not run.
There is no automatic continuation, rerun, or guard reset.
Browser events enforce the original per-test deadlines despite sign-in helper extensions.
Only time spent waiting for the first approval file is excluded.
The approval window is limited to 600 seconds across the entire campaign.
The campaign also has a finite outer deadline of 12000 seconds.

## Build and fixture safety

The build and cleanup machinery starts from the previous attachment runner.
The earlier attachment-only preliminary test is replaced by its service-account source probe.
No attachment test is rerun.
The build is attempted once with the original resource limits.
The build recipe adds headed Chrome and a virtual display to the original recipe.
It records the recipe hash without editing the exported source.
The browser download is resolved during that future build, not during authoring.
Its availability and exact downloaded version are not established here.
The image keeps the keep-from-prune=true label.
A recorded hold container protects it until all other cleanup checks pass.
The pinned local build tools and dependency images must already exist.

There are no published ports.
The runner claims a port in the shared development range.
It never targets production.
Only the application has outbound networking.
The browser and database remain on the internal network.
The browser never receives the container daemon socket or the operator home directory.
An owned socket accepts only the original scoped database helper, exact worker inspection,
validated worker signals, the explicit application restart, and bounded application logs.
Every target is mapped to a recorded campaign container identity.
Worker pauses and the explicit restart operate on the real production supervisor processes.
No clock is mocked and no due date is accelerated.

Before each later file, the previous application and provider processes are stopped and checked.
The disposable database is dropped and recreated before migration and the required seed.
The shared credential and tools volumes remain owned by this one campaign.
The original real-model helper discovers and pins the cheapest eligible model through the application.
No provider executable is replaced.
The seed omits scripted chat routes even though the first spec declares a scripted profile.
The original embedding fixture remains enabled.
None of the inspected eight specs requires a mail fixture.

## Sign-in and teardown

One approval covers the campaign.
The operator receives only private link and code file paths.
The runner never reads or prints their contents.
A second link stops the run before another approval may be supplied.
No host credentials or proxy keys are read or copied.
On completion or failure, the browser and application are stopped and checked first.
Credential files are removed in a cleaner with no network.
The cleaner scans the entire owned credential volume for surviving setup tokens.
It reports only success or failure, not token contents.
Only then may containers, volumes, networks, and the port claim be removed.
The image hold is released last.
Uncertain cleanup retains resources and the held image for explicit recovery.
Recovery never repeats a test or resets an attempt guard.

## Evidence and limitations

Each file has a private result directory and the complete browser report.
Each original test receives an individual status and duration.
Missing tests, skipped tests, retries, unexpected titles, and report errors cannot count as passing.
Application model-activity events are counted by kind and outcome in the fresh database.
Those are recorded events, not a proven count of upstream subscription calls.
Unavailable counts, tokens, prices, and quota remain unknown.
A missing application accounting witness stops progression rather than inventing zero usage.

For the final two specs, browser observation records each source-task creation response status.
It records a request digest, response digest, task identifier when present, and safe validation fields.
It separately records the scheduled-check request and response metadata.
No request text, response body, authentication header, or provider output is added to that observation.
Original private test reports and application logs retain their existing evidence behavior.
Safe refusal events retain the exact validation keyword and schema path when the application emits them.
The source does not include an attempt identifier on those events.
Timestamp proximity alone cannot prove which request produced a refusal.
Missing correlation remains unknown and the historical creation defect is not closed.
Successful creation can contribute non-reproduction evidence, not proof that the historical defect is fixed.
This runner does not claim the separate one-call diagnostic was executed.

The notification spec requires a persistent headed browser and a secure origin.
The owned browser wrapper treats only the isolated application origin as secure.
It does not fake subscriptions, notifications, or delivery.
Real browser push normally needs access to an external push service.
The preserved browser network policy provides no such access.
That spec may fail for this reason even with all browser dependencies installed.
The runner does not weaken the policy to make it pass.
No live failure or success has been established during authoring.

## Commands after separate approval

Run each phase separately from this package directory.
Preparation prints a new campaign directory name.
Use that exact name for later phases.

```
./run.py prepare --execute
./run.py build --campaign campaign-<printed nonce> --execute
./run.py test --campaign campaign-<printed nonce> --execute
./run.py release --campaign campaign-<printed nonce> --execute
```

The last phase is only for a held image after verified stack removal.
It is not a cleanup shortcut for live provider processes.
The acceptance flags remain false even if all eight files pass.
Passing these files does not establish broader stage acceptance.

## Mandatory evidence scan (added after review)

After `./run.py test` exits, and before any result is reported or adjudicated, the coordinator runs
`python3 -I scan_evidence.py <campaign-dir>` once. It walks the whole campaign folder except the pinned source
snapshot, looks for any real-looking Claude token (the prefix followed by a long body), and writes counts and
paths only to `evidence-scan.json`. Any hit or unreadable file fails the run: the result is not reported as a
pass, the hit paths are reported masked, and the evidence is quarantined for review.

The scan runs only once the test command has exited and its cleanup record shows no campaign container or
volume left, so nothing is writing to the folder. The scanner never follows links, reads each file through a
handle it checks is the same unchanged file it listed, and lists the folder a second time; any entry that
appeared, vanished or changed between the two listings fails the scan.
