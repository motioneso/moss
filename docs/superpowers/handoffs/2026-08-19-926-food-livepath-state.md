# #926 Food Phase 1 — live-path gate state (2026-08-19)

Plain English, no jargon, in every status update and every agent you spawn from here.

## Where this stands

PR #1716, branch `food-phase1-926`, head `bc9adbdfd` plus uncommitted work on the real-chat test.
Reading and lifecycle behaviour is proven live. Writing is proven by hand but the test that
records it is still being stabilised.

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

Filed as #1720.

Reproduced five times. When the assistant asks permission to run a Food tool, the request only
reaches the screen about three minutes later, and by then the server has stopped listening for the
answer. Approving returns "This request expired" and the request sits unanswered forever.

The numbers, from the server's own log and the test:

```
t+0s     the message is sent
t+22s    the assistant calls the tool; the server starts waiting for permission
t+150s   the server gives up waiting (its fixed window)
t+177s   the request finally appears on screen and in the server's own list
t+177s   clicking Approve is refused
```

Ruled out already, do not re-check: two server processes, an uncommitted database write, and a
slow model. Still unknown: why the waiting request cannot be read while it is being waited on.

Why nobody caught it: no test anywhere approves one of these requests with a real model. The only
coverage is a browser test with a fake server.

This blocks the two Food tools that always ask (turning on estimates, deleting a meal). Logging,
correcting and re-estimating a meal never ask, so they are unaffected.

## Proven by hand, real model, not yet a green test

`tests/uat/specs/926-food-real-chat.uat.spec.ts`, run with:

```
moss-real-chat-run npx tsx tests/uat/run-uat.ts 926-food-real-chat
```

Observed working in earlier runs: turning on AI estimates raised a confirmation, approving it
took effect, and logging a meal produced a real nutrition estimate (320 calories, 9g protein,
and so on). Run 4 is the first with all three test flaws fixed. Logs: `/tmp/food-uat{1..4}.log`.

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
