# Live proof: a replay after restart never acts (#3335)

Date: 2026-10-10. All times UTC.

## Setup

- Branch scheduled/3335-replay-never-acts, head 743f19b63. The server started at 12:39:52 and never restarted. The last two commits (49fd8888f, 743f19b63) landed during the run, but their product-code edits were already on disk when the server started, and the second one only touches tests. So the code under test matches the branch head.
- A separate install with its own empty database, its own ports and its own owner account. The shared dev database and prod were never touched.
- Model: claude-haiku-4-5 through the Claude command-line sign-in (the cheapest model the install found). No API keys.
- Driven through the real sign-in and the real Main chat drawer in a headless browser. No network responses were faked or rewritten.
- How the replay was forced: call the chat's own resume endpoint for the Main thread (returns 204). That stops the running model session and marks the next start for a full history replay. The next page load opens the drawer, which starts a new session, and the server log records a replay with trigger "relaunch".
- Baseline before scenario 1: 0 action requests, 0 audit rows, 0 Main messages, 0 tasks.

## Scenario 1: a replay after a code-answered reminder raises nothing - PASS

- 12:44:24 sent "remind me in 3 minutes to stretch". The drawer showed "Okay. I'll remind you in 3 minutes: stretch". Code answered this; the model was not involved.
- 12:45:37 forced a restart with replay. Replays ran at 12:45:09 and 12:45:41.
- The model's replay reply (12:45:45) was text only ("I already have that set for you..."). It made no tool call. That reply was thrown away and never stored, which is the intended behaviour.
- 12:47:26 the reminder fired as "Reminder: stretch". This is the expected delivery, not a side effect of the replay.
- 12:49:38, more than 3 minutes after the replay, the database showed 0 action requests, 0 audit rows and 0 tasks. The only new Main message was the reminder delivery.
- 12:50:33 the drawer showed no approval card, no "Timed out" message and no "Create task".

Because the model did not try a tool in this replay, this replay alone does not show the guard firing. Four extra replays did, as follows.

- 12:52:08 sent "remind me in 10 minutes to call the dentist" (code answered). Then forced replays at 12:52:36, 12:53:06, 12:54:36 and 12:56:03.
- In 3 of those 4 replays the model tried Moss tools, 5 calls in all (find action 4 times, current time once). Every one came back to the model as "Tool permission request failed: Error: Tool use aborted".
- None of those calls reached the Moss tool endpoint. Each session start shows only its 4 start-up requests in the server log.
- 12:59:40 the database was still clean: 0 action requests, 0 audit rows, 0 tasks, no new messages beyond the code replies and the reminder delivery. The drawer showed no card and no "Timed out".

## Scenario 2: a real tool request still gets its card - PASS (approved)

- 13:00:25 sent "add a task called stretch".
- 13:00:41 the drawer showed the card "Create task / Title stretch / Approve / Reject".
- 13:00:43 clicked Approve. The drawer showed "Added "stretch" to your tasks."
- Database: 1 action request (create task, confirmed), 1 audit row, 1 task "stretch" (to do). One tool call reached the tool endpoint, at 13:00:41.
- An empty assistant message at 13:00:43 is the normal stored record of the approved card ("Approved · Create task").

## Scenario 3: an ordinary question gets an ordinary answer - PASS

- 13:01:58 sent "In one short sentence, what is the capital of Portugal?".
- The drawer showed "Lisbon is the capital of Portugal." (about 2 seconds).
- 13:02:09 the dentist reminder fired as expected.

## Optional: scenario 1 against the base code without the fix

- Ran the base branch integration/scheduled-proactive (e206e0afe) from a separate temporary checkout, against the same database and ports. The web page was left on the branch build, since the fix changes no web code.
- 13:04:42 sent "remind me in 10 minutes to call the plumber" (code answered).
- Forced replays at 13:05:29, 13:07:01 and 13:08:33.
- In 2 of the 3 replays the model called find action (13:05:11 and 13:08:47). Both calls reached the Moss tool endpoint and returned real results. Without the fix, nothing stops a replay's tool call.
- The model never went on to ask for an action to run, so no card appeared on the base code in this run either. The original sighting (a card raised during a replay) did not reproduce.
- At 13:12, 3 minutes after the last replay: no new action request, task or message.
- What this shows: the base code lets replay tool calls through, while the fixed code stops them before they reach Moss. That supports reading the "Tool use aborted" results in scenario 1 as the fix at work. No log line names the refusal itself, so that link rests on this comparison.

## Odd things seen

- During three replays on the fixed code, the model also used the Claude program's own "schedule a wakeup" tool. That tool ran without any permission request, so the fix cannot stop it. It set a wakeup about 10 minutes out. Each of those sessions was stopped by the next resume before the wakeup came due, so nothing came of it here. A long-lived replay session could wake itself up later. This gap is not specific to replays; it is tracked in #3340.
- The model never sees the fix's refusal text. The model program reports every refusal as "Tool use aborted", so the model may retry or guess.
- The approval card in scenario 2 also said "Moss read something from outside your account before asking this." I did not trace what triggered that notice. It is worth checking whether it was right for a plain "add a task" request.

## After the run

- The only product change after the tested head is the wording of the refusal text and a code comment. The model never sees that text on this engine (see above), so the run was not repeated.
