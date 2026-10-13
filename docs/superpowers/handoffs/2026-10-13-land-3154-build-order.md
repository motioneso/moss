# Build order for the 17 unbuilt issues under PR 3154

Written 2026-10-11 from origin/integration/scheduled-proactive (2 commits behind main), the
planning docs on that branch, the native GitHub "blocked by" links, and the audit in
land-3154-done-list.md. Read-only planning. Nothing was built, pushed or commented.

Writing rule for anyone who reads or forwards this: plain English. Name things by what they do,
not by repo identifiers. Keep exact names only where someone must act on them. At most one
backtick per sentence, no coined shorthand, plain ASCII punctuation. Pass this rule on.

## How to read the dependency column

- Finished and live-proven, so treated as satisfied: 3131, 3132, 3146.
- 3126 (side chats) is NOT finished. Its core works, but its acceptance still waits on the
  Conversations repairs (3361 failed live twice, 3281 is blocked on a decision). Only 3148
  depends on it.
- 3137 is a container. Its real work is 3151 then 3152. It needs one whole-ticket acceptance
  run after both land, not a builder of its own.
- The GitHub issue bodies still say the four migration choices "remain proposals". Ben approved
  all four later. Builders follow docs/superpowers/plans/2026-10-08-scheduled-proactive-migration-decisions.md.

## 1. Dependency table

Areas use these short names. "Reminder storage" is packages/chat/src/reminders and the chat
reminders table in packages/chat/sql. "Chat request handling" is the code that reads the
owner's own words and decides a reminder command (recognizer, commands and turn files in that
folder). "Settings task list" is the new Settings screen 3133 creates under apps/web/src/settings.
Every slice also adds app-map entries and route declarations; those are additive one-line
registrations and are not counted as collisions.

| Issue | What it does | Depends on (unfinished) | Size | Migration? | Areas it touches |
|---|---|---|---|---|---|
| 3133 | See reminders in Settings, with details and history, and pause, resume or delete them from Settings or chat | none (3132 satisfied) | L, split below | yes (paused state) | new Settings task list, Settings page and app map, reminder storage, delivery recheck, chat request handling, shared API contract |
| 3134 | Reminders also send a phone or browser notification, held back during quiet hours and blocked by existing mutes | none (3131, 3132 satisfied) | M | probably not (existing notification keys) | reminder delivery, packages/notifications, quiet-hours deferral |
| 3135 | Change a saved reminder's text, time or deadline by asking in chat | 3133 | M | maybe (version column already exists) | chat request handling (new edit command), reminder storage versioning, queued-job invalidation |
| 3136 | Repeating fixed-text reminders (daily, weekly, more often) on local time, with one catch-up after downtime | 3135 | M (split only if the fit check fails: daily and weekly first, then "more often") | yes (repeat rule, next run) | job scheduling, reminder storage, chat request handling (repeat phrases), Settings list groups Daily, Weekly and More often |
| 3151 | Schedule one exact read of an owner's source item, enforced read-only at the real gateway, and get a status report in chat | 3133 | M (already a reslice) | yes (check type, source reference, run record) | new background check runner, read-only enforcement at the action gateway, worker job, chat request handling (new create command), Settings list row |
| 3152 | The scheduled check uses the owner's configured AI model to write a sourced report, with quiet bounded retries for read failures | 3151 | M (already a reslice) | probably small (attempt count) | check runner, AI capability routing, result posting |
| 3137 | Container: one requested read-and-report check while away | 3151, 3152 | S (acceptance run only) | no | none, proof only |
| 3138 | Repeating checks that post only when something new and useful turns up, with honest failure status after repeated failures | 3136, 3137 | M (split only if the fit check fails: new-only posting first, then failure streak) | yes (last-seen state, failure count) | check runner, job scheduling, Settings history (quiet success versus failure) |
| 3139 | A watch for a stated condition (e.g. "tell me when Maya replies") that completes from real evidence once, or expires at its deadline | 3138 | L, split below | yes (goal, deadline, completed and expired states) | watch storage, check runner result handling, worker expiry job, Settings Watches group and deadline row, chat request handling |
| 3140 | A reading watch stays open after a click and only closes when the owner says in chat they have read it | 3139 | M | small (confirmation state) | chat request handling (new "I've read it" command), watch storage |
| 3141 | Moss suggests a reminder, check or watch in chat, and saves it only when the owner types agreement to the current terms | 3139 | M | yes (pending proposal) | chat request handling (proposal and agreement), proposal storage |
| 3142 | Owner approves one bounded non-destructive action when creating a task; the task then does it while they are away | 3135, 3137 | L, split below | yes (approved scope, start-of-action record) | action gateway, agreement binding, check runner, Settings scope row |
| 3143 | Owner approves a deletion once at creation; it runs once and is never replayed automatically | 3142 | M | probably not (reuses 3142 scope storage) | action gateway classification, check runner |
| 3144 | Changing a task's approved actions in chat asks for fresh agreement; time-only edits do not | 3143 | M | yes (proposed version) | agreement binding, edit command, queued-job invalidation |
| 3145 | Let one named task through during quiet hours, added or removed in chat and listed under "Allowed during quiet hours" | 3134 | M | yes (per-task allowance) | Alerts and quiet hours Settings pane, chat request handling (new allow command), notification delivery exception |
| 3147 | Useful automatic email findings arrive in Main chat by default, and switching them off leaves requested watches running; also owns the live proof of the email cap being hit | 3134, 3139 (3146 satisfied) | M | maybe (link a finding to its chat message) | packages/proactive-monitoring (scanner, finding policy), result posting into Main chat |
| 3148 | Send a task's results to a named side chat instead of Main, set at creation or by a chat edit | 3135, and 3126 (unfinished, outside this list) | M | yes (destination conversation) | result posting and routing, chat request handling (destination), Settings destination row |

### Proposed splits

- 3133a: Settings task list, read only. Rows, details, dated history, View message, Past tasks,
  and the loading, empty and error states, desktop and phone. Also, with no change in
  behaviour, split chat request handling into one file per command and build the detail panel
  as separate row pieces. Later slices then add a file and a one-line registration instead of
  editing the same file. No migration.
- 3133b: pause, resume and delete from Settings and chat, with deletion confirmed on "Keep
  task", and the worker rechecking paused or deleted state before posting, including queued
  and in-flight work. Needs the paused-state migration.
- 3139a: a watch is saved with a goal and deadline, shows under Watches with its deadline,
  runs its reads, and expires and stops at the deadline. Live demo is a short deadline that
  expires with no run after it.
- 3139b: a matching email reply completes the watch once with evidence; an alert alone is not
  completion; competing workers cannot close it twice or run it after it closes.
- 3142a: typed agreement binds to the exact proposed scope, the scope is stored and shown in
  Settings, and the gateway refuses everything outside it. No action runs yet, so nothing
  unsafe ships early. Build the agreement binder general enough that 3141 and 3144 reuse it
  without editing it.
- 3142b: the scheduled run performs the approved action, records that the action started
  before calling it, and never reruns automatically after a start, including after a restart.

### Migration numbers

The branch's newest migration is 0312 and main's is 0304, so the next free number is 0313.
Reserve 0313 onward for this run and hand each builder its number in the dispatch brief, in
wave order. Run scripts/check-migration-collisions.ts before each merge into the branch,
because a main-side PR could take the same number meanwhile.

## 2. Build waves

At most four per wave. A wave starts only when everything it depends on is integrated and
live-proven on the branch.

| Wave | Issues | Why these can run together |
|---|---|---|
| 1 | 3133a, 3134 | 3133a is the Settings screen plus a no-change file split; 3134 is the delivery and notification side. |
| 2 | 3133b, 3145 | 3133b owns pause and resume and the delivery recheck; 3145 owns the Alerts pane, its own chat command file and the notification exception 3134 added. They change different columns in separate migrations. |
| 3 | 3135, 3151 | 3135 owns editing and versioning; 3151 adds its own runner, job and create command and posts through the existing result path without editing it. |
| 4 | 3136, 3152, 3148 | 3136 owns repeat scheduling and the list groups; 3152 owns the runner's model step and retries; 3148 owns routing and its own detail row. Build 3148 now, but it cannot close until 3126 passes. |
| 5 | 3137 acceptance run first, then 3138, 3142a | 3138 owns runner scheduling and last-seen state; 3142a owns agreement, scope storage and gateway refusal. |
| 6 | 3139a, 3142b | Watch storage and expiry versus action execution. Both touch the runner, so 3139a must leave run-result handling to 3139b. |
| 7 | 3139b, 3143 | Watch completion in runner result handling versus deletion classification at the gateway. |
| 8 | 3140, 3141, 3144, 3147 | Separate command files; 3141 and 3144 both reuse the 3142a agreement binder without editing it; 3147 lives in the email monitoring package. |

Eight waves, 20 builder slices (17 issues, with 3133, 3139 and 3142 split in two, and 3137
needing only a proof run). The critical path is 3133a, 3133b, 3135, 3136, 3138, 3139a, 3139b,
then the last wave.

## 3. Already partly built, and decisions needed before building

### Partly built

None of the 17 has started. These foundations exist and later slices should reuse them:

- One-time reminders (relative and clock-time, deadlines, late and expired handling, cancel,
  live arrival) are in packages/chat/src/reminders, with migrations 0306, 0308, 0309 and 0311.
  The table already has a version column that 3135 can use.
- The email finding policy from 3146 already separates "unsolicited" from "requested" findings,
  and exists so 3147 does not need a second scan or budget.
- The live in-browser arrival of a reminder is not an outward notification. 3134 is untouched.
- There is no "Allowed during quiet hours" section, no watch, no read-only gateway and no
  per-task approved scope anywhere on the branch.

### Question for Ben (blocks 3135, 3136, 3151 and everything after)

Today Moss saves a reminder only when the owner's own words match a fixed pattern that plain
code reads. The AI model is deliberately kept out of it, so nothing the AI says, and nothing
inside an email, can create a task. That works for "remind me in 10 minutes to call Sam". It
cannot reasonably cover "check my inbox every morning for Maya's reply" or "move the dentist
reminder to Thursday". The options are:

- A (recommended). Let the AI turn a request into the task's terms for read-only tasks
  (checks, watches, and changes to text or time), and save it directly, as the spec says
  requests should be. Anything that changes or deletes data still needs the owner's typed
  agreement, bound by code. The risk is that a planted instruction in an email could get the
  AI to schedule a read-only check. That check could only report into the owner's own chat,
  and it shows in the Settings list where they can delete it.
- B. Keep plain-code pattern matching for everything. This is safest, but checks and watches
  will only understand narrow, fixed phrasings.
- C. Let the AI fill in the terms, but have Moss read them back and wait for a typed "yes"
  before saving every task. This contradicts the approved design, where a direct request saves
  with no second approval.

Question: "For checks, watches and edits, may the AI fill in the task from your request
(option A), or should every task stay limited to fixed phrasings (option B)?"

### Decisions the coordinator can make without Ben (record them in the plan)

- Daylight-saving rule for repeating reminders (3136). The spec says to set it before coding.
  Proposed: a time skipped by spring-forward fires at the first valid minute after it; a time
  repeated by fall-back fires once, at the first occurrence. The one-time reminder refuses such
  times, but a repeating one cannot.
- Which existing non-destructive action proves 3142, and which existing deletion proves 3143.
  Use disposable data, and keep to actions in Moss's own modules, because connector deletion is
  out of scope.

## 4. Mockup coverage

All four mockups (3100 to 3103) are accepted, and almost every screen in these issues is
covered. The gaps are:

- One-time read check (3151, 3152). The Settings mockup groups tasks into Reminders, Daily,
  Weekly, More often, Watches and Past tasks, and has no one-time check sample. Proposed
  default: list it under Reminders, titled by what it checks. This is a small call; ask Ben
  only if the coordinator is unsure.
- The Settings mockup predates the Park Press design pass on 2026-10-10. Builders should keep
  its layout and behaviour but build it from the current design-system primitives, not the
  mockup's class names.
- 3134 adds no new screen. It reuses the existing notification and push display, so nothing
  needs a mockup.
