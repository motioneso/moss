# PR 3700 fresh reminder summary proof

Exercised `ecf79aab772cb6448a302c9ec90cfbd0f5979fba` on the existing moss-proof
instance on 2026-10-26 UTC. This evidence commit changes no product code.

Real Firefox UI sign-in → Settings AI providers → Chat with Moss → one submitted
turn: “Show all my reminders, including past and upcoming reminders.” No response
interception, stubs, reset, setup reminder writes, or auth/config changes.

The fresh request returned HTTP 200: server request `req-146` ran from
00:05:01.976Z to 00:05:53.037Z, taking 51.061 seconds; browser observation took
51.955 seconds. The returned reminders.summary snapshot covered all three stored
rows, matching IDs, text, due times and states. Owner-scoped model activity reports
`chat.answer` completed successfully in 17.060 seconds with three successful tools
and no failed tools. The balance of request time is not localized by this evidence.

The initial browser run exited 1 when screenshotting an element detached during
rendering, **after** the HTTP-200 response and source assertions.
A separate read-only browser run exited 0. It verified the exact returned assistant
message ID and adjacent submitted user message ID, then desktop and 390px phone
rendering, no horizontal overflow, no card controls, unchanged reminder rows, and
the exact persisted visual envelope after reload. It submitted no chat turn.
Reload used DOMContentLoaded plus visible UI assertions, not the full-page load event.

- [Machine-readable timing and assertion receipt](receipt.json)
- [Read-only follow-up assertion log](assertions.txt)
- [Desktop card crop](desktop-card.png)
- [390px phone card crop](phone-card.png)

Screenshots are included because the explicit task brief requested them; executable
assertions and bounded logs carry the live-path proof.

## Hang finding and limits

The historical final-head request `req-hd` began at 23:52:10.953Z and has no
completion record in retained container logs. Owner-scoped AI activity since that
container boot has no completed chat entry before this fresh successful turn.
Prior run 2 recorded NS_ERROR_ABORT; prior run 5 timed out at page.reload waiting
for the full load event. These are separate observations, not proof of one cause.
Claude teardown code 143 records also occur for Settings probes and cannot by
themselves establish a failed model call.

The hang did not recur in the single authorized fresh attempt. No database lock or
long-running query was observed during inspection. A main defect affecting every
chat is contradicted by the successful unchanged-code turn; an intermittent main
bug remains possible. The old timeout cause and the unlocalized latency remain
unresolved, so no confirmed-main-defect issue was opened. This result proves the
fresh reminder-card path; it is not a rerun of the full acceptance set or a merge
approval.

moss-proof remains running on the tested revision; data and provider sign-in are
preserved. No product fix was justified. Original predecessor artifacts are not
modified by this task.
