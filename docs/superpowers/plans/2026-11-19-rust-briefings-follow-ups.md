# Rust Briefings follow-ups: build plan

Board task JS-371 (from JS-339). Source: the "Follow-up work, not built" and "Not proven" sections
of `docs/superpowers/specs/2026-11-18-rust-phase5-briefings-part-22-report.md` (lines 27-41).
Parent plan: `docs/superpowers/specs/2026-11-11-rust-phase5-meetings-briefings-plan.md`, which
lists these Today pieces as Open, owner Ben (lines 239-240). This plan resolves that Open item with
a recommendation and one question for Ben (section 8).

Every screen reproduces the current TypeScript behaviour. No redesign.

Tree checked at `434e67967` (origin/main, 2026-11-19).

## 1. Pieces in scope

| Piece                                    | TypeScript behaviour today                                                                                                                                                                                  | Owner of the data it changes            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Accept and Dismiss on action rows        | `apps/web/src/today/briefing-action-rows.tsx:50,76-85`. Live status joined from the task. Accept sets the task to todo, Dismiss archives it.                                                                | Tasks                                   |
| Catch-up Add task and Dismiss, with Undo | `apps/web/src/today/catch-up-digest.tsx:218-315`. Add task creates "Follow up with ..." and records a "more like this" rating. Dismiss records a "dismiss" rating. A failed rating archives the stray task. | Tasks, plus usefulness feedback (host)  |
| Plan review and day-plan accept          | `day-plan-review.tsx`, `day-plan-review-controller.ts` (save, accept all additions, confirm, retry); shown at `today-page.tsx:776`                                                                          | Calendar (day plans), Tasks (due dates) |
| Email and Calendar signal switches       | `apps/web/src/settings/settings-source-behaviors.ts:12-22`, shown on Briefings settings (`settings-module-subviews.tsx:290-300`)                                                                            | Email, Calendar                         |
| Today hero text                          | `apps/web/src/today/today-hero.tsx:125-136` (`morningNotReadyReason`)                                                                                                                                       | Today shell (core), reading Briefings   |

Out of scope: evening planning (`evening-planning-controller.ts`). It moves tasks between days and
needs its own part. Judging the model pass for source-grounded wording also stays out; it is a
review task, not a build.

## 2. Seams check

### 2.1 What exists

| Capability                                                                                                            | Evidence                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today shell is a core host area, not a module                                                                         | `docs/superpowers/specs/2026-11-07-rust-module-packages-and-registry-design.md:601`                                                                                                                        |
| Today hosts module sections: a slot names a module and a screen path, the module's `/today` screen renders in a frame | `rust-spike/shell/ui/src/today.rs:50`, `rust-spike/shell/assets/package-sections.js:7-45`; shipped for Commitments in #4378 (`modules/commitments/moss.module.json` screens `{"/today": "ui/index.html"}`) |
| Empty "Needs you" slot on Today                                                                                       | `rust-spike/shell/ui/src/today.rs:51`                                                                                                                                                                      |
| A module frame may only call its own routes                                                                           | `rust-spike/module-ui/web/host-bridge.mjs:66-130`                                                                                                                                                          |
| Module-to-module calls run as the signed-in caller and must be declared                                               | `rust-spike/module-host/src/services.rs:398-433`                                                                                                                                                           |
| The host can call a module's public call                                                                              | `rust-spike/module-host/src/chat_tools.rs:263-266`                                                                                                                                                         |
| Hero note is hardcoded sample text                                                                                    | `rust-spike/shell/contract/src/stub.rs:97`; `rust-spike/shell/app/src/runner_data.rs:107-109` returns the sample; rendered at `rust-spike/shell/ui/src/today.rs:76`                                        |
| Shell already reads Briefings routes                                                                                  | `rust-spike/shell/ui/src/api.rs:85` (definitions), `today.rs:85-97` (Read your briefing link)                                                                                                              |
| Briefings reader keeps rows read only                                                                                 | `modules/briefings/ui/parts.mjs:45,63`; Reply already opens chat (`parts.mjs:24-30`)                                                                                                                       |
| Briefings runs carry stable item ids                                                                                  | `modules/briefings/src/runs.rs:57-127` (`feedbackItemId`)                                                                                                                                                  |
| Briefings verifies its own feedback targets                                                                           | `modules/briefings/src/feedback.rs:1-4,90-110`; provided at `modules/briefings/moss.module.json:113`                                                                                                       |
| Tasks read for briefings                                                                                              | `modules/tasks/src/lib.rs:65-83` (`listBriefingTasks`, status todo, done or suggested only)                                                                                                                |
| Tasks routes and tools that change status                                                                             | `modules/tasks/src/routes.rs:99-103,137-143`; tools `tasks.updateStatus` (`mutations.rs:18-42`)                                                                                                            |
| Email briefing switch storage and screen                                                                              | `modules/email/src/settings.rs:79-90`; routes `modules/email/src/lib.rs:111-112`; switch on Email settings `modules/email/ui/src/views.rs:43-45`                                                           |
| Calendar switch read and screen                                                                                       | `getSourceSwitches` (`modules/calendar/src/lib.rs:137,145-153`, read only); routes `lib.rs:258-273`; switch on Calendar settings `modules/calendar/ui/src/browser.rs:364-379`                              |
| Calendar day-plan routes                                                                                              | `modules/calendar/src/lib.rs` (GET `/day-plan`, POST `/day-plans`, PATCH draft, preview, apply, operations confirm and retry)                                                                              |
| Usefulness feedback routes                                                                                            | `rust-spike/shell/app/src/proactive_feedback.rs:40-43`                                                                                                                                                     |

### 2.2 What is missing

| Gap                                                                                                                                                                                         | Evidence                                                                                                                                             | Fixed by                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Tasks has no public call that changes a task's status or creates a general task                                                                                                             | `modules/tasks/moss.module.json` provides only `createMeetingTask`, `getTaskReference`, `listBriefingTasks`, `prepareTaskAction`, `prepareTaskRoute` | Part 2 (Tasks)           |
| `listBriefingTasks` never returns archived tasks, so a dismissed row cannot show "Dismissed"                                                                                                | `modules/tasks/src/lib.rs:77-82`                                                                                                                     | Part 2 (Tasks)           |
| Briefing feedback targets are never registered. The old server registered them when listing runs (`packages/briefings/src/routes.ts:325-345`); the Rust lookup reads a table nothing writes | `rust-spike/module-host/src/usefulness_feedback.rs:110-120`                                                                                          | Part 4 (host)            |
| Briefing run targets are refused outright                                                                                                                                                   | `rust-spike/module-host/src/usefulness_feedback.rs:7-10,106-108`                                                                                     | Part 4 (host)            |
| Nothing calls `verifyBriefingFeedbackTarget`                                                                                                                                                | only its test calls it (`modules/briefings/tests/tools.rs:245`)                                                                                      | Part 4 (host)            |
| A module has no way to record a rating for the caller, or to read the caller's active dismissals                                                                                            | host services list `rust-spike/module-host/src/services.rs:304-440` has no feedback service                                                          | Part 4 (host)            |
| Briefings runs route does not hide dismissed items or handled catch-up                                                                                                                      | `modules/briefings/src/runs.rs` has no feedback read; the old route did (`packages/briefings/src/routes.ts:301-323`)                                 | Part 5 (Briefings)       |
| Email has no public call for its briefing switch                                                                                                                                            | `modules/email/moss.module.json` provides                                                                                                            | Part 7 (Email)           |
| Calendar switch is read only to other modules                                                                                                                                               | `modules/calendar/src/lib.rs:145-153`                                                                                                                | Part 7 (Calendar)        |
| Briefings does not declare Email as an optional dependency                                                                                                                                  | `modules/briefings/moss.module.json` `optionalRequires` (calendar, connectors, tasks, news, sports, weather)                                         | Part 8 (Briefings)       |
| No module draws the Today schedule; the timeline is sample data                                                                                                                             | `rust-spike/shell/ui/src/today.rs:43`; `runner_data.rs:107-109`                                                                                      | Open question, section 8 |

No step below adds an owner's call inside Briefings. Each owner adds its own call first.

## 3. Design fork: where the Today controls live

### 3.1 Option A (recommended): each module owns its Today section

- Briefings ships a `/today` screen with the action rows and the catch-up. Today mounts it in the
  existing "Needs you" slot, the same way Commitments mounts today.
- The frame calls Briefings routes only. Briefings calls Tasks through new declared public calls.
- Calendar ships the day plan and its review as its own `/today` screen.
- Fits the modular ruling (Rust Moss is modular, Today shell is core and generic) and the newest
  precedent (#4378, one day old).
- Cost: Tasks and the host must add calls first, so the Briefings parts wait on them.

### 3.2 Option B (rejected): the Today shell draws the controls itself

- Leptos components in the shell call Tasks, Briefings and feedback routes directly, as the
  weather line does (`rust-spike/shell/ui/src/weather.rs:49`).
- Strengths: no new public calls; fewer parts; the shell already reads Briefings routes.
- Rejected because it puts Briefings, Tasks and Calendar rules into core. Uninstalling Briefings
  would leave dead shell code, and a third-party briefing package could never replace it. The
  weather precedent is a read, not a write into another module.

### 3.3 Chat tool with an approval card instead

Rejected for every piece. The person's click already is the consent, so a card would ask twice and
change behaviour. Chat already offers the same actions as tools (`tasks.updateStatus`; Calendar and
Briefings tools are in Rust chat plan parts 4b-4d, `docs/superpowers/specs/2026-11-18-rust-chat-module-tools-and-approvals-plan.md:393-399`).
Reply already hands off to chat.

## 4. Determinism boundary

- Every status, label and confirmation on these screens renders from the saved record (task
  status, rating row, plan record), never from model output.
- No module injects turns into chat. Reply sends the person's own prefilled text through the frame
  bridge, as the reader already does.
- No part adds a model call. The model's only jobs stay where part 22 left them (compose the
  morning and evening briefings).

## 5. Parts, in build order

Each part fits one session. Each part ends with live Playwright proof on the installed Rust server,
at desktop (1440 x 900) and phone (390 x 844) width, against real data written through the real
path (no faked responses). Each security test must be observed failing with the check removed.

### Part 1: Today hero says the true briefing state

- Owner: Today shell. Waits on nothing.
- Change: replace the sample note (`stub.rs:97`) with a note computed from the caller's Briefings
  definitions and latest morning run, using the `morningNotReadyReason` rules
  (`today-hero.tsx:125-136`): no schedule shows nothing; switched off; failed; blocked; scheduled
  for a time. A readable morning run shows its summary text instead.
- Files: `rust-spike/shell/ui/src/today.rs`, `rust-spike/shell/ui/src/api.rs`, a new
  `rust-spike/shell/ui/src/hero_note.rs` holding the pure rule.
- Signature: `pub fn hero_note(defs: &[BriefingDefinition], latest: Option<&BriefingRun>, now: Zoned) -> Option<String>`.
- Briefings not installed: the note is hidden, not an error.
- Tests:
  - Unit, one case per rule. A note stuck on "switched off" fails the "scheduled" and "readable run" cases.
  - Live: account with a morning briefing switched on and one finished run shows the run summary;
    switched off shows the off line.
- Security: the shell reads Briefings routes as the signed-in user. Test with a second account
  holding a run: the first account's hero never shows it.
- App map: update the Rust core "today" entry text to say the hero shows the briefing lead or why
  it is not ready. No new entry.
- Mockup: none.

### Part 2: Tasks adds the calls Briefings needs

- Owner: Tasks. Waits on nothing.
- New public calls in `modules/tasks/moss.module.json` `provides`, version `1.0.0`; Tasks bumps to `0.1.5`:
  - `setBriefingTaskStatus { taskId: String, status: "todo" | "archived" }` returns `{ id, status }`
    or not-found. Only moves a task out of `suggested` or back; any other change is refused.
  - `createFollowUpTask { title: String, description: Option<String> }` returns `{ id, status }`.
- Extend `listBriefingTasks` with optional `ids: Vec<String>`. With ids it returns those tasks in
  any status, archived included. Additive, so the call stays `1.0.0`.
- Files: `modules/tasks/src/lib.rs`, `modules/tasks/src/mutations.rs`, `modules/tasks/moss.module.json`, `modules/tasks/CHANGELOG.md`.
- Tests:
  - Status flips suggested to todo and suggested to archived; a done task is refused.
  - Another account's task id returns not-found and the row is unchanged. Fails if the call reads
    without the caller's scope.
- Live proof: through Part 3's screen (a call-only part has no screen of its own).
- App map: Tasks feature entry gains one sentence naming the two calls.

### Part 3: Briefings Today section, action rows

- Owner: Briefings. Waits on Part 2.
- New screen `"/today": "ui/today.html"` in `modules/briefings/moss.module.json`. Today mounts it
  in the "Needs you" slot (`today.rs:51` becomes `data-module-section="briefings" data-screen-path="/today"`).
- New routes:
  - `GET /today` returns the latest morning run's action rows, each joined to a live status from
    `listBriefingTasks { ids }`: Suggested, Accepted (todo or done) or Dismissed (archived).
  - `POST /today/rows/:task_id { action: "accept" | "dismiss" }` calls `setBriefingTaskStatus`.
- Buttons and labels match TypeScript: Accept, Dismiss, Reply.
- Bump `optionalRequires.tasks` to `>=0.1.5`. With Tasks missing, rows show without buttons.
- Tests:
  - Accept then reload shows Accepted; Dismiss then reload shows Dismissed.
  - A row naming another account's task returns 404 and the task stays suggested. Fails if
    Briefings skips Tasks and trusts the run's stored id.
- Live: real morning run with two suggested tasks; accept one, dismiss one, reload, both
  statuses hold; Tasks page shows the change.
- App map: new Briefings feature `briefings.today-actions`; the Rust core "today" entry names the
  Needs you section.
- Mockup: none. Reproduces `briefing-action-rows.tsx`.

### Part 4: host feedback service for modules

- Owner: host (usefulness feedback is a core area). Waits on nothing; may run beside Parts 2-3.
- New host service `feedback`, available to any module, always as the caller:
  - `register { targets: [{ targetKind, targetRef, surface, sourceKind, sourceLabel, metadata }] }`
  - `record { targetKind, targetRef, surface, kind }` returns the rating id
  - `undo { id }`
  - `activeRefs { targetKind, surface, kind }` returns the refs with an active rating
- A module may only name target kinds it owns. Briefings owns `briefing_run` and `briefing_item`;
  declare this in the manifest as `"feedbackTargets": ["briefing_run", "briefing_item"]`.
- Before storing a rating, the host calls the module's declared verify call
  (`verifyBriefingFeedbackTarget`) using the chat-card path (`chat_tools.rs:263-266`). Remove the
  outright refusal at `usefulness_feedback.rs:106-108` for `briefing_run`, routing it through the
  same verify.
- Files: `rust-spike/module-host/src/services.rs`, `rust-spike/module-host/src/usefulness_feedback.rs`,
  `rust-spike/module-host/src/manifest.rs`, module SDK client.
- Tests:
  - A module naming a target kind it does not own is refused.
  - Account A cannot rate account B's briefing item: verify returns null, the host answers 404,
    no row is written. Fails if the host trusts the registered row without verify.
  - Payloads stay metadata only: no item text in the stored metadata beyond source labels.
- Live proof: through Part 6.
- App map: none (no screen).

### Part 5: Briefings registers its targets and hides handled items

- Owner: Briefings. Waits on Part 4.
- The runs routes call `feedback.register` for each visible run and item, then hide runs and items
  with an active "dismiss", and mark catch-up entries handled when they carry an active rating.
  Same rule as `packages/briefings/src/routes.ts:301-345`.
- Tests: a dismissed item stays hidden after reload; undoing it brings it back.
- Live proof: through Part 6.
- App map: the `briefings.history` feature text says dismissed items stay hidden.

### Part 6: catch-up Add task, Dismiss and Undo on Today

- Owner: Briefings. Waits on Parts 2, 4 and 5.
- Adds the catch-up block to the Part 3 section.
- New routes:
  - `POST /today/catch-up/:item_id/add` calls `createFollowUpTask` ("Follow up with {sender}",
    summary), then `feedback.record more_like_this`. If the rating fails, it archives the new task.
  - `POST /today/catch-up/:item_id/dismiss` archives any stray task, then records "dismiss".
  - `POST /today/catch-up/:item_id/undo` undoes the rating and archives the task.
- Statuses open, added and dismissed; the failure text matches TypeScript's ACTION_FAILED copy.
- Tests:
  - A rating failure leaves no task behind.
  - Another account's item id returns 404 and creates no task. Fails if the route creates the
    task before the item is verified.
- Live: Gmail-backed catch-up with two entries; add one, dismiss one, reload, undo one.
- App map: new Briefings feature `briefings.today-catch-up`.
- Mockup: none. Reproduces `catch-up-digest.tsx`.

### Part 7: Email and Calendar expose their switches

- Owners: Email and Calendar, in one part. Waits on nothing.
- Email adds `getBriefingSource {}` returning `{ enabled }` and `setBriefingSource { enabled }`,
  wrapping `settings::source` and `put_source` (`modules/email/src/settings.rs:79-90`).
- Calendar adds `setSourceSwitches { briefings: Option<bool>, planning: Option<bool> }` next to
  `getSourceSwitches`.
- Tests: each setter writes only the caller's own row; a second account's value is unchanged.
- App map: one sentence on each module's settings feature.

### Part 8: switches on Briefings settings

- Owner: Briefings. Waits on Part 7.
- Add `email` to `optionalRequires`. New routes `GET /source-signals` and
  `PATCH /source-signals { email?, calendar? }` that call the Part 7 calls.
- The settings screen shows "Include email signal" and "Include calendar signal", hidden when the
  owner module is absent.
- Tests: flipping on Briefings settings shows the same value on the Email and Calendar settings
  screens after reload.
- Live: both switches, both widths.
- App map: Briefings settings entry lists the two switches with their labels.
- Mockup: none. Reproduces `settings-source-behaviors.ts`.

### Part 9: day plan and review, read only (pending section 8)

- Owner: Calendar, if Ben agrees. Waits on the section 8 answer.
- Calendar ships `"/today": "ui/today.html"` showing the day plan and the review panel from
  `GET /day-plan`, mounted where the sample timeline sits.
- Live: a real plan with proposed blocks shows Proposed and Flexible tags as in TypeScript.
- App map: Calendar feature `calendar.today-plan`; the Rust core "today-schedule-details" and
  "today-task-blocks" texts move to it.

### Part 10: review writes

- Owner: Calendar. Waits on Part 9.
- Save changes, Accept all additions, Confirm and Retry, calling the existing day-plan routes.
- Tests: confirm with another account's plan or operation id returns 404 and writes nothing.
- Live: change one block, accept all, confirm; the calendar shows the events.

## 6. Verification commands

Run each through the gate wrapper, never piped:

```bash
scripts/run-gate.sh start --gate test:rust-tasks
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

| Fact or decision                                                                                                                      | Evidence                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Every accept or dismiss row joins on a task id, so Tasks is the only owner of row actions (the part 22 table also listed Email)       | `apps/web/src/today/briefing-action-rows.tsx:50,76-85`                              |
| Reply is already built in the Rust reader                                                                                             | `modules/briefings/ui/parts.mjs:24-30`                                              |
| Catch-up ratings would answer 404 today because no briefing target is ever registered                                                 | `rust-spike/module-host/src/usefulness_feedback.rs:110-120`                         |
| The Email and Calendar settings screens already have their own switches; Briefings settings adds the second place, as TypeScript does | `modules/email/ui/src/views.rs:43-45`; `modules/calendar/ui/src/browser.rs:364-379` |
| Today can host module sections since #4378                                                                                            | `rust-spike/shell/assets/package-sections.js`                                       |
| No piece is better as a chat tool                                                                                                     | section 3.3                                                                         |
