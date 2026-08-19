# #926 Food Phase 1 — live-path gate state (2026-08-19)

Plain English, no jargon, in every status update and every agent you spawn from here.

## Where this stands

PR #1716, branch `food-phase1-926`, head `f92eeac94`, everything committed and pushed. Live
results are recorded on the PR. Reading, lifecycle and writing are all proven live with a real
model. The only gap is the two tools that always ask permission, blocked on #1720.

## Proven live, 8 of 8 passing

`playwright.live.config.ts` + `tests/live/food-926-uat.spec.ts`, against the from-source dev
instance. Nothing is mocked.

```
npx playwright test --config playwright.live.config.ts food-926-uat.spec.ts
```

Turning Food on through the real admin screen, its entry in the navigation, consent shown
read-only from a live call, a second real user seeing none of the owner's data, and turning
Food off then on again.

## Blocker found 2026-08-19: approving a confirmation does not work with a real model

Filed as #1720. Reproduced seven times.

When the assistant asks permission to run a Food tool, the request only reaches the screen about
three minutes later, and by then the server has stopped listening for the answer. Approving returns
"This request expired" and the request sits unanswered forever.

```
t+0s     the message is sent
t+22s    the assistant calls the tool; the server starts waiting for permission,
         and writes the request to the database, where it is readable immediately
t+150s   the server gives up waiting (its fixed window)
t+180s   the request finally appears on screen
t+180s   clicking Approve is refused
```

The server is not at fault. Measured during the wait: the request is committed and readable
straight from the database, the database has spare connections, and the server answers requests
from outside the browser in milliseconds. What fails is that the browser sends nothing at all for
the whole three minutes and only catches up once the turn ends.

Ruled out already, do not re-check: two server processes, an uncommitted database write, a slow
model, and connection-pool exhaustion. Still unknown: why the browser goes silent. Two candidates
left — the streaming turn plus the event stream using up the browser's connections to that origin,
or the service worker serialising fetches while a stream is open.

Why nobody caught it: no test anywhere approves one of these requests with a real model. The only
coverage is a browser test with a fake server.

This blocks the two Food tools that always ask (turning on estimates, deleting a meal). Logging,
correcting and re-estimating a meal never ask, so they are unaffected.

## Proven live with a real model — passing

`tests/uat/specs/926-food-real-chat.uat.spec.ts`, run with:

```
moss-real-chat-run npx tsx tests/uat/run-uat.ts 926-food-real-chat
```

The first test passes (run 15, 2.1 minutes, log `~/uat15.log`). A real model logs a meal, then
corrects it in a second turn. Both are saved and shown on the Food page, neither interrupts the
user, and neither creates a permission request at all — which is the right behaviour for a tool
granted at install, and is asserted rather than assumed.

The second test covers the two tools that always ask. It is correct and is the regression test for
#1720, so it is marked skipped with a pointer to that issue. Un-skip it when #1720 lands.

Do not assert that a granted-at-install tool creates a permission record. It does not. A tool the
gateway decides to just run never creates one, so the right assertion is that there are none.

## Things already paid for — do not re-derive

- Food asks permission differently by tool, on purpose. Logging, correcting and re-estimating
  a meal are granted when you install it and run without interrupting. Turning on estimates and
  deleting a meal always ask. Expecting a prompt for every write is wrong.
- Do not judge an approval by the card's label. The chat transcript re-renders and the label
  resets to "Needs your approval" even after a successful approve. Check the server's own
  record of the action instead.
- "not granted" contains "granted". Match the banner text exactly.
- Count only confirmation cards still waiting; answered ones stay in the transcript.
- The from-source dev instance cannot do real chat at all. Its provider install and sign-in
  routes are not wired outside the container and return "service not configured". Only the
  containerised stack has a real model.
- A module staged by hand into `data/modules/<id>/` needs its own `package.json`, or the worker
  will not start and every tool call fails.
- A `pattern` in a module's tool schema always fails. Validate in the handler.
- Editing an installed module's files turns it off on the next reconcile. Turn it back on in
  settings.
- Approving a blocked tool over the REST API can never run it. By design.
- The dev database is named `jarv1s`, not `jarvis`.
- Two accounts are flagged as bootstrap owner and the reconcile guard picks one with no
  ordering, so the email it demands is not stable. Unfiled.

## Running dev instance

Web `http://192.168.50.36:5173`, API `:3000`, Postgres `:55433`. Sign in as `ben@ben.com`.
Never point anything at `:1533` — that is production.

## Before merging

Record the live results on PR #1716, then `gh pr merge 1716 --squash --auto`. Never `--admin`;
a ruleset blocks it. After merge, comment on #926 and move #1701 to Done on board project 2.
