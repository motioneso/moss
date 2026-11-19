# Rust Briefings follow-ups: build plan

Board task JS-371 (from JS-339). Source: the "Follow-up work, not built" and "Not proven" sections
of `docs/superpowers/specs/2026-11-18-rust-phase5-briefings-part-22-report.md` (lines 27-41).
Parent plan: `docs/superpowers/specs/2026-11-11-rust-phase5-meetings-briefings-plan.md`, which
lists these Today pieces as Open, owner Ben (lines 239-240). This plan resolves that Open item with
a recommendation and one question for Ben (section 8).

Every screen reproduces the current TypeScript behaviour. No redesign.

Tree checked at `434e67967` (origin/main, 2026-11-19).

## 1. Pieces in scope

| Piece                                    | TypeScript behaviour today                                                                                                                                                                                                     | Owner of the data it changes                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Accept and Dismiss on action rows        | `apps/web/src/today/briefing-action-rows.tsx:50,76-89,312`. Live status joined from the task; with no run, rows come from suggested tasks. Accept sets the task to todo, Dismiss archives it.                                  | Tasks                                                                                       |
| Catch-up Add task and Dismiss, with Undo | `apps/web/src/today/catch-up-digest.tsx:205-315`. Add task creates "Follow up with ..." and records a "more like this" rating. Dismiss records a "dismiss" rating. A failed rating keeps the stray task and a retry reuses it. | Tasks, plus usefulness feedback (host)                                                      |
| Plan review and day-plan accept          | `day-plan-review.tsx`, `day-plan-review-controller.ts` (save, accept all additions, confirm, retry); shown at `today-page.tsx:776`                                                                                             | Calendar (it already reads tasks through Tasks, `modules/calendar/src/saved_read.rs:52-75`) |
| Email and Calendar signal switches       | `apps/web/src/settings/settings-source-behaviors.ts:12-22`, shown on Briefings settings (`settings-module-subviews.tsx:290-300`)                                                                                               | Email, Calendar                                                                             |
| Today hero note                          | `apps/web/src/today/today-hero.tsx:125-136` (`morningNotReadyReason`)                                                                                                                                                          | Today shell (core), reading Briefings                                                       |

Out of scope:

- Evening planning (`evening-planning-controller.ts`). It moves tasks between days and needs its own part.
- The rest of the hero (headline and lead split, prepared-at line, stale banner, sample greeting).
  It belongs to the Today hero port, not to these follow-ups.
- Rating a briefing run directly through `/api/me/usefulness-feedback`. No piece here needs it.
- Judging the model pass for source-grounded wording. It is a review task, not a build.

## 2. Seams check

### 2.1 What exists

| Capability                                                                                                            | Evidence                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today shell is a core host area, not a module                                                                         | `docs/superpowers/specs/2026-11-07-rust-module-packages-and-registry-design.md:601`                                                                                                                        |
| Today hosts module sections: a slot names a module and a screen path, the module's `/today` screen renders in a frame | `rust-spike/shell/ui/src/today.rs:50`, `rust-spike/shell/assets/package-sections.js:7-45`; shipped for Commitments in #4378 (`modules/commitments/moss.module.json` screens `{"/today": "ui/index.html"}`) |
| Empty "Needs you" anchor on Today, targeted by the section nav                                                        | `rust-spike/shell/ui/src/today.rs:37,51`                                                                                                                                                                   |
| A module frame may only call its own routes                                                                           | `rust-spike/module-ui/web/host-bridge.mjs:66-130`                                                                                                                                                          |
| Module-to-module calls must be declared twice: dependency and `api` permission resource                               | `rust-spike/module-host/src/services.rs:398-433`; Briefings permission list `modules/briefings/moss.module.json:18-21`                                                                                     |
| Every host port needs a declared permission                                                                           | `rust-spike/module-host/src/manifest.rs:589-594`                                                                                                                                                           |
| Host services take injected handles                                                                                   | `rust-spike/module-host/src/services.rs:23-25,99` (`with_network`)                                                                                                                                         |
| Hero note is hardcoded sample text                                                                                    | `rust-spike/shell/contract/src/stub.rs:97`; `rust-spike/shell/app/src/runner_data.rs:107-109` returns the sample; rendered at `rust-spike/shell/ui/src/today.rs:76`                                        |
| Shell already reads Briefings routes                                                                                  | `rust-spike/shell/ui/src/api.rs:85`, `today.rs:85-97`                                                                                                                                                      |
| Briefings reader keeps rows read only                                                                                 | `modules/briefings/ui/parts.mjs:45,63`; Reply already opens chat (`parts.mjs:24-30`)                                                                                                                       |
| Briefings runs carry stable item ids                                                                                  | `modules/briefings/src/runs.rs:57-127` (`feedbackItemId`)                                                                                                                                                  |
| Briefings can check a run belongs to the caller                                                                       | `modules/briefings/src/feedback.rs:1-4,40` (`owned_run` reads the caller's own rows)                                                                                                                       |
| Tasks read for briefings                                                                                              | `modules/tasks/src/lib.rs:65-83` (`listBriefingTasks`, status todo, done or suggested only)                                                                                                                |
| Tasks meeting call is meeting specific                                                                                | `modules/tasks/src/lib.rs` `MeetingTask` (takes a source ref and external key)                                                                                                                             |
| Email briefing switch storage and screen                                                                              | `modules/email/src/settings.rs:79-90`; routes `modules/email/src/lib.rs:111-112`; switch `modules/email/ui/src/views.rs:43-45`                                                                             |
| Calendar switch read, merge-write route and screen                                                                    | `getSourceSwitches` (`modules/calendar/src/lib.rs:137,145-153`); PATCH `/source-behaviors` merges (`lib.rs:258-273`); switch `modules/calendar/ui/src/browser.rs:364-379`                                  |
| Calendar day-plan routes                                                                                              | `modules/calendar/src/lib.rs` (GET `/day-plan`, POST `/day-plans`, PATCH draft, preview, apply, operations confirm and retry)                                                                              |

### 2.2 What is missing

| Gap                                                                                                                                                                   | Evidence                                                                                                                                                             | Fixed by                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Tasks has no public call that changes a task's status or creates a general task                                                                                       | `modules/tasks/moss.module.json` provides                                                                                                                            | Part 2                   |
| `listBriefingTasks` never returns archived tasks, so a dismissed row cannot show "Dismissed"                                                                          | `modules/tasks/src/lib.rs:77-82`                                                                                                                                     | Part 2                   |
| A module cannot record a rating for the caller or read the caller's active ratings. The old server let Briefings do both (`packages/briefings/src/routes.ts:301-345`) | no feedback port in `rust-spike/module-host/src/services.rs:304-440`; feedback store lives in the shell app (`rust-spike/shell/app/src/proactive_feedback.rs:28-43`) | Part 4                   |
| Briefings runs route does not hide dismissed items or handled catch-up                                                                                                | `modules/briefings/src/runs.rs` has no feedback read                                                                                                                 | Part 5                   |
| Email has no public call for its briefing switch                                                                                                                      | `modules/email/moss.module.json` provides                                                                                                                            | Part 7                   |
| Calendar switch is read only to other modules                                                                                                                         | `modules/calendar/src/lib.rs:145-153`                                                                                                                                | Part 7                   |
| Briefings cannot call Email at all                                                                                                                                    | `email` missing from `optionalRequires` and from the `api` resources (`modules/briefings/moss.module.json:20`)                                                       | Part 8                   |
| No module draws the Today schedule; the timeline is sample data                                                                                                       | `rust-spike/shell/ui/src/today.rs:43`; `runner_data.rs:107-109`                                                                                                      | Open question, section 8 |

No step below adds an owner's call inside Briefings. Each owner adds its own call first.

## 3. Design fork: where the Today controls live

### 3.1 Option A (recommended): each module owns its Today section

- Briefings ships a `/today` screen with the action rows and the catch-up. Today mounts it inside
  the existing "Needs you" anchor, the same way Commitments mounts today.
- The frame calls Briefings routes only. Briefings calls Tasks through new declared public calls.
- Calendar ships the day plan and its review as its own `/today` screen.
- Fits the modular ruling (Rust Moss is modular, Today shell is core and generic) and the newest
  precedent (#4378, one day old).
- Cost: Tasks and the host must add calls first, so the Briefings parts wait on them.

### 3.2 Option B (rejected): the Today shell draws the controls itself

- Leptos components in the shell call Tasks, Briefings and feedback routes directly, as the
  weather line does (`rust-spike/shell/ui/src/weather.rs:49`).
- Strengths: no new public calls; fewer parts; the feedback routes already exist for the shell.
- Rejected because it puts Briefings, Tasks and Calendar rules into core. Uninstalling Briefings
  would leave dead shell code, and a third-party briefing package could never replace it. The
  weather precedent is a read, not a write into another module.

### 3.3 Chat tool with an approval card instead

Rejected for every piece. The person's click already is the consent, so a card would ask twice and
change behaviour. Chat already offers matching tools (`tasks.updateStatus`; Calendar and Briefings
tools are in Rust chat plan parts 4b-4d,
`docs/superpowers/specs/2026-11-18-rust-chat-module-tools-and-approvals-plan.md:393-399`). Reply
already hands off to chat.

## 4. Determinism boundary

- Every status, label and confirmation on these screens renders from the saved record (task
  status, rating row, plan record), never from model output.
- No module injects turns into chat. Reply sends the person's own prefilled text through the frame
  bridge, as the reader already does.
- No part adds a model call. The model's only jobs stay where part 22 left them (compose the
  morning and evening briefings).

## 5. Parts, in build order

Each part fits one session. Each part with a screen ends with live Playwright proof on the
installed Rust server, at desktop (1440 x 900) and phone (390 x 844) width, against real data
written through the real path (no faked responses). A call-only part proves itself through the
installed-server gate of its module and is exercised again in the first screen part that uses it.
Each security test must be observed failing with the check removed.

### Part 1: Today hero note says the true briefing state

- Owner: Today shell. Waits on nothing.
- Change: replace the sample note (`stub.rs:97`) with a note computed from the caller's Briefings
  definitions and latest morning run, using `morningNotReadyReason` (`today-hero.tsx:125-136`):
  no schedule shows nothing; switched off; failed; blocked; otherwise scheduled for a time. A
  readable morning run hides the note. A run in progress shows "Gathering your morning briefing…".
  Headline, lead and the rest of the hero stay as they are (section 1).
- Files: `rust-spike/shell/ui/src/today.rs`, `rust-spike/shell/ui/src/api.rs`, a new
  `rust-spike/shell/contract/src/hero_note.rs` holding the pure rule, so it tests natively.
- Signature: `pub fn hero_note(defs: &[BriefingDefinition], latest: Option<&BriefingRun>, now_local_minutes: u32, past_target: bool) -> Option<String>`.
  The browser supplies the local time; the contract crate needs no clock dependency.
- Briefings not installed: the note is hidden, not an error.
- Tests:
  - Unit, one case per rule. A note stuck on "switched off" fails the "scheduled" and "readable run" cases.
  - Live: a morning briefing switched on with a finished run hides the note; switched off shows the off line.
- Security: the routes the shell reads are the Briefings module routes, which run under the
  caller's session like every `/api/m/` route. Test with a second account holding a run: the first
  account's hero never reflects it.
- App map: the Rust core "today" entry says the hero note gives the briefing state. No new entry.
- Mockup: none.

### Part 2: Tasks adds the calls Briefings needs

- Owner: Tasks. Waits on nothing.
- New public calls in `modules/tasks/moss.module.json` `provides`, version `1.0.0`; Tasks bumps to `0.1.5`:
  - `setBriefingTaskStatus { taskId: String, status: "todo" | "archived" }` returns `{ id, status }`
    or not-found. Allowed: suggested to todo, suggested to archived, todo to archived. Setting the
    status a task already has returns it unchanged. Done tasks are refused.
  - `createFollowUpTask { title: String, description: Option<String> }` returns `{ id, status }`.
    `createMeetingTask` is not reused because it requires a meeting source ref and external key.
- Extend `listBriefingTasks` with optional `ids: Vec<String>`. With ids it returns those tasks in
  any status, archived included. Additive, so the call stays `1.0.0`.
- Files: `modules/tasks/src/lib.rs`, `modules/tasks/src/mutations.rs`, `modules/tasks/moss.module.json`, `modules/tasks/CHANGELOG.md`.
- Tests:
  - Each allowed transition, and a refused one from done.
  - Another account's task id returns not-found and the row is unchanged. Fails if the call reads
    without the caller's scope.
- Proof: `test:rust-tasks-server` installed-server gate; screen proof in Part 3.
- App map: Tasks feature entry gains one sentence naming the two calls.

### Part 3: Briefings Today section, action rows

- Owner: Briefings. Waits on Part 2.
- New screen `"/today": "ui/today.html"` in `modules/briefings/moss.module.json`. Today mounts it
  inside the existing anchor, keeping its id for the section nav (`today.rs:37`):
  `<div id="needs-you"><div data-module-section="briefings" data-screen-path="/today"></div></div>`.
- New routes:
  - `GET /today` returns the latest morning run's action rows, each joined to a live status from
    `listBriefingTasks { ids }`: Suggested, Accepted (todo or done) or Dismissed (archived). With no
    run, rows come from suggested tasks, as TypeScript does (`briefing-action-rows.tsx:89,312`).
  - `POST /today/rows/:task_id { action: "accept" | "dismiss" }` calls `setBriefingTaskStatus`.
    Like TypeScript, it accepts any task id of the caller; the row does not have to be in the run.
- Buttons and labels match TypeScript: Accept, Dismiss, Reply.
- Bump `optionalRequires.tasks` to `>=0.1.5`. With Tasks missing, rows show without buttons.
- Tests:
  - Accept then reload shows Accepted; Dismiss then reload shows Dismissed.
  - Another account's task id returns 404 and the task stays suggested. Fails if Briefings answers
    from the run's stored copy instead of asking Tasks.
- Live: real morning run with two suggested tasks; accept one, dismiss one, reload, both statuses
  hold; the Tasks page shows the change.
- App map: new Briefings feature `briefings.today-actions`; the Rust core "today" entry names the
  Needs you section.
- Mockup: none. Reproduces `briefing-action-rows.tsx`.

### Part 4: host feedback port for modules

- Owner: host (usefulness feedback is a core area). Waits on nothing; may run beside Parts 2-3.
- New port `feedback`. A module must declare it as a permission
  (`{"port": "feedback", "operations": ["record", "undo", "active"], "resources": ["briefing_run", "briefing_item"]}`),
  checked through `manifest.rs:589`. The resources are the target kinds the module owns. Adding the
  port is a new-permission prompt on update (`manifest.rs` `newly_requested`).
- Operations, always as the caller (the host fills the owner from the access context; the module
  cannot name a user):
  - `record { targetKind, targetRef, surface, kind, sourceKind, sourceLabel, metadata }` returns
    the rating id. Writes the target row and the rating in one transaction.
  - `undo { id }` for a rating the caller owns.
  - `active { targetKind, surface, kind }` returns the refs with an active rating.
- Wiring: a new `trait Feedback: Send + Sync` in `rust-spike/module-host/src/feedback_port.rs`,
  injected with `Services::with_feedback(Arc<dyn Feedback>)` like `with_network`
  (`services.rs:99`). The shell app implements it over its existing store
  (`rust-spike/shell/app/src/proactive_feedback.rs`). Module calls run synchronously and the store
  is async, so the builder must bridge the two; check how the shell app wires its existing handles
  before choosing.
- Ownership of a ref is the module's job before it calls `record`; Briefings uses `owned_run`
  (Part 6). The host guarantees only that a module rates as the caller and only for its own kinds.
- Files: `rust-spike/module-host/src/services.rs`, `rust-spike/module-host/src/feedback_port.rs`,
  `rust-spike/shell/app/src/proactive_feedback.rs`, module SDK client.
- Tests:
  - A module without the permission, or naming a kind it did not declare, is refused.
  - Ratings written through the port carry the caller as owner; a second account's `active` read
    never returns them. Fails if the port takes the owner from the parameters.
  - Stored metadata holds ids and labels only, no item text.
- Proof: `test:rust-proactive-feedback` gate extended with a fixture module.
- App map: none (no screen).

### Part 5: Briefings hides dismissed and handled items

- Owner: Briefings. Waits on Part 4.
- Add the `feedback` permission to the Briefings manifest.
- The runs routes call `feedback.active` and hide runs and items with an active "dismiss", and mark
  catch-up entries handled when they carry an active rating. Same rule as
  `packages/briefings/src/routes.ts:301-323`.
- Tests:
  - A dismissed item stays hidden after reload; undoing it brings it back.
  - Account B's dismissals never hide account A's items. Fails if `active` is read without the caller.
- Live: dismiss an item (written through the port by a test helper module call), open the reader at
  both widths, item absent; undo, item back.
- App map: the `briefings.history` feature text says dismissed items stay hidden.
- Mockup: none. The reader shows fewer rows; the layout is unchanged.

### Part 6: catch-up Add task, Dismiss and Undo on Today

- Owner: Briefings. Waits on Parts 2, 4 and 5.
- Adds the catch-up block to the Part 3 section.
- Each route first checks the item with `owned_run` and the run's own catch-up ids. An unknown or
  foreign item returns 404 before anything is written.
- New routes:
  - `POST /today/catch-up/:item_id/add { strayTaskId? }` reuses the stray task if given and still
    the caller's, else calls `createFollowUpTask` ("Follow up with {sender}", summary). Then
    `feedback.record more_like_this`. A failed rating returns the task id so a retry reuses it, as
    TypeScript does.
  - `POST /today/catch-up/:item_id/dismiss { strayTaskId? }` archives the stray task, then records "dismiss".
  - `POST /today/catch-up/:item_id/undo { feedbackId, taskId? }` undoes the rating and archives the
    task. Both ids are re-checked against the caller through the port and Tasks.
- The frame keeps the returned feedback and task ids in memory, as the TypeScript component does.
  After a reload, handled state comes from Part 5.
- Statuses open, added and dismissed; the failure text matches TypeScript's ACTION_FAILED copy.
- Tests:
  - A failed rating followed by a retry creates exactly one task.
  - Another account's item id returns 404 and creates no task. Fails if the route creates the task
    before the ownership check.
  - Undo with another account's feedback id or task id changes nothing.
- Live: real Gmail-backed catch-up with two entries; add one, dismiss one, reload, undo one.
- App map: new Briefings feature `briefings.today-catch-up`.
- Mockup: none. Reproduces `catch-up-digest.tsx`.

### Part 7: Email and Calendar expose their switches

- Owners: Email and Calendar, in one part. Waits on nothing.
- Email adds `getBriefingSource {}` returning `{ enabled }` and `setBriefingSource { enabled }`,
  wrapping `settings::source` and `put_source` (`modules/email/src/settings.rs:79-90`).
- Calendar adds `setSourceSwitches { briefings: Option<bool>, planning: Option<bool> }` next to
  `getSourceSwitches`, sharing the merge code of PATCH `/source-behaviors` (`lib.rs:258-273`).
- Tests: each setter writes only the caller's own row; a second account's value is unchanged.
- Proof: `test:rust-email` and `test:rust-calendar-server`; screen proof in Part 8, which also
  checks the owners' own settings screens show the new value.
- App map: one sentence on each module's settings feature.

### Part 8: switches on Briefings settings

- Owner: Briefings. Waits on Part 7.
- Add `email` to `optionalRequires` and to the `api` permission resources
  (`moss.module.json:20`). This is a new-permission prompt on update.
- New routes `GET /source-signals` and `PATCH /source-signals { email?, calendar? }` that call the
  Part 7 calls.
- The settings screen shows "Include email signal" and "Include calendar signal", each hidden when
  its owner module is absent.
- Tests: flipping on Briefings settings shows the same value on the Email and Calendar settings
  screens after reload; a second account's switches are unchanged.
- Live: both switches, both widths, plus the Email and Calendar settings screens after reload.
- App map: Briefings settings entry lists the two switches with their labels.
- Mockup: none. Reproduces `settings-source-behaviors.ts`.

### Part 9: day plan and review, read only (pending section 8)

- Owner: Calendar, if Ben agrees. Waits on the section 8 answer.
- Calendar ships `"/today": "ui/today.html"` showing the day plan and the review panel from
  `GET /day-plan`, mounted where the sample timeline sits.
- Mockup: this replaces sample content, so the reference screen must be named before the build. The
  TypeScript Today schedule and review (`day-plan.tsx:180`, `day-plan-review.tsx`) are the
  reference; capture them at both widths as the agreed look, or Ben names a mockup.
- Tests: another account's plan never appears; a plan naming a task the caller cannot see lists it
  as unavailable (`saved_read.rs:52-75`).
- Live: a real plan with proposed blocks shows Proposed and Flexible tags, both widths.
- App map: Calendar feature `calendar.today-plan`; the Rust core "today-schedule-details" and
  "today-task-blocks" texts move to it.

### Part 10: review writes

- Owner: Calendar. Waits on Part 9. Needs no new Tasks call, because Calendar already reads tasks
  through Tasks.
- Save changes, Accept all additions, Confirm and Retry, calling the existing day-plan routes.
- Tests: confirm or retry with another account's plan or operation id returns 404 and writes nothing.
- Live: change one block, accept all, confirm; the calendar shows the events, both widths.
- App map: `calendar.today-plan` text adds the review actions.
- Mockup: none beyond Part 9's reference.

## 6. Verification commands

Run each through the gate wrapper, never piped:

```bash
scripts/run-gate.sh start --gate test:rust-tasks-server
```

```bash
scripts/run-gate.sh start --gate test:rust-briefings
```

```bash
scripts/run-gate.sh start --gate test:rust-briefings-live
```

```bash
scripts/run-gate.sh start --gate test:rust-email
```

```bash
scripts/run-gate.sh start --gate test:rust-calendar-server
```

```bash
scripts/run-gate.sh start --gate test:rust-proactive-feedback
```

Then wait on the printed log with `scripts/run-gate.sh wait --follow --log <log>`. Expected exit 0
for each. Static checks:

```bash
pnpm verify:static > /tmp/js371-static.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`.

## 7. Kill gate

After Part 3 ships, Ben checks the Needs you section on the phone. If a framed section on Today
feels slower or looks different from the rest of Today, stop and re-plan the rest around option B
before Part 6. Owner: Ben.

## 8. Open questions for Ben

1. Do Briefings and Calendar each own their Today section (option A), with Calendar replacing the
   sample schedule? This resolves the Open item at meetings-briefings plan 3.4. Recommendation: yes.

## 9. Rulings ledger

| Fact or decision                                                                                                                                    | Evidence                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Every accept or dismiss row joins on a task id, so Tasks is the only owner of row actions (the part 22 table also listed Email)                     | `apps/web/src/today/briefing-action-rows.tsx:50,76-85`                              |
| Plan review needs no Tasks call; the part 22 table's "Tasks (the plan lives there)" is wrong, the plan lives in Calendar                            | `modules/calendar/src/saved_read.rs:52-75`                                          |
| Reply is already built in the Rust reader                                                                                                           | `modules/briefings/ui/parts.mjs:24-30`                                              |
| No Rust code registers briefing feedback targets, so a catch-up rating through the existing route would answer 404                                  | `rust-spike/module-host/src/usefulness_feedback.rs:106-120`                         |
| A module call to another module needs both the dependency and the `api` permission resource                                                         | `rust-spike/module-host/src/services.rs:398-433`                                    |
| The Email and Calendar settings screens already have their own switches; Briefings settings adds the second place, as TypeScript does               | `modules/email/ui/src/views.rs:43-45`; `modules/calendar/ui/src/browser.rs:364-379` |
| Today can host module sections since #4378                                                                                                          | `rust-spike/shell/assets/package-sections.js`                                       |
| The host verify-through-Briefings path was dropped: Briefings checks ownership itself before rating, and the host only pins the caller and the kind | Part 4, review round 1                                                              |
| No piece is better as a chat tool                                                                                                                   | section 3.3                                                                         |
