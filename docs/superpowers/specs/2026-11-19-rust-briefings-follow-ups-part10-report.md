# Briefings follow-ups Part 10: day plan review writes

Task JS-385, Card 630. Part 9 supplies the reference layout; JS-394 supplies the existing
Calendar apply, retry, recover and confirm routes. This branch merged that backend before
building the review controls.

## Delivered scope

Calendar's Rust Today review edits stored block times and placements. Save changes saves the
whole draft, previews the selected changes and applies eligible changes. Accept all time
blocks selects proposed task additions. Moves and removals show the returned change set and
require Confirm. Execution results show each outcome and Retry sends only
those eligible item ids. Choices survive closing the reader and failed writes; revision
conflicts clear the old approval and ask for another review. The schedule rail reflects the
current choices. The existing shared dialog owns modal isolation and focus restoration.

The UI calls Calendar's declared HTTP routes. It does not create Tasks or reach into another
module. Calendar already reads task references through its host-held public Tasks reference,
and its existing execution path writes events through public Connectors calls. The
`calendar.today-plan` app-map entry describes the actions, outcomes and recovery.

No backend production code, migration or new public module API is added. The installed
Connectors test's existing Calendar route proof is extracted into a helper so the server test
stays below the task's file-size limit; that helper also hosts the optional review browser run.

## Executable proof

Run from the task worktree in `~/Jarv1s`, with task-owned Cargo home and target directories,
`CARGO_BUILD_JOBS=1`, and the provisioned Rust home. Rust gates run serially through
`scripts/run-gate.sh`, with no pipeline. Their logs record exit codes and tested inputs.

- `test:rust-calendar`: review model tests for full draft preservation, task-addition selection,
  duration, leave unscheduled, move/remove review, local times, preview conflicts, retry
  selection and idempotency. It also runs the existing guest, parity and installed-host suites.
- The installed `day_plan_apply` test snapshots Calendar plan/operation tables, host approvals
  and scripted provider writes around foreign confirm/retry. The same rejection assertions run
  with row security present, removed and restored, printing RED and GREEN results. The claim
  concerns those measured rows and provider calls, not every possible read-side effect.
- `test:rust-calendar-server`: the installed Today screen, unavailable references, reader,
  keyboard/focus, phone disclosure and opening the editable review without a write.
- `test:rust-calendar-review-live`: real installed Tasks, Calendar, Email and Connectors on the
  HTTPS Rust server, bound to the shared dev-port range and reachable through the machine's
  LAN/tailnet address. Playwright runs at desktop and phone widths. It creates real tasks and
  drafts through public routes, changes a proposed time, closes and reopens the review,
  accepts two additions, checks the task count is unchanged, moves a placed block, checks the
  event still has its old time before Confirm, confirms, and checks saved events through both
  the public route and Calendar screen. It also checks horizontal fit and restored focus.
- `pnpm verify:static`: full repository static checks, including the app map.

The final PR records actual exit codes, pass counts and security control output. The task's
proof recipe contains screenshots from the real live run and bounded command output. Proof
files stay outside commits.

## Limits

Google, Outlook and mail are repository provider stand-ins in the live fixture; Moss's server,
database, installed packages and browser UI run unchanged. This is not proof against a real
Google account or a physical second device. Phone width is exercised by Playwright; the server
is checked through its LAN/tailnet URL. Live UI proof covers addition and move confirmation;
retry eligibility is checked by the model and installed route suites. It does not inject a
provider failure through the review UI. The fixture stops its servers and releases its claimed
port when the run ends.
