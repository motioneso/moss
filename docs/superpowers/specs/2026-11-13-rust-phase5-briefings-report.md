# Rust Phase 5: Briefings report

Card JS-263. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

## Briefings

### What was built (part 16)

The Briefings package keeps each person's briefing definitions (morning, evening and weekly
review) and the runs those definitions produced. It reads and writes the same two tables as the old
app, so existing rows carry over. It calls no model and shows no screen. The run job that writes the
briefing text is part 17.

- Definitions: list, create and edit, with the same bodies, status codes and messages as the old
  routes.
- Runs: list a definition's runs and open one run, with the old answers, including the "missing or
  owned by someone else" answer.
- Schedules: a daily or weekly definition registers its own time in the owner's time zone. A manual
  or switched-off definition removes it. Listing definitions repairs the caller's own schedules.
- A pure rule for first-check alignment: a fire registered in another zone still runs when it lands
  on the target day within 180 minutes after the target time in the owner's zone. A fixed clock
  tests it across zones.
- Sharing: a definition can be shared. A viewer sees the definition but never its runs. A manager
  can edit it but never moves the owner's schedule. Runs stay owner-only.
- Data export and delete-account counts for both tables, written one page at a time.
- App map entries in the package manifest (definitions, person time, history, one error code).
- The six old SQL files stay byte for byte where they were. A test checks them against the
  inventory. One line was added to the host's list of shareable tables, so a shared definition is
  readable by the person it is shared with.

Not built here, by design: screens, the run job, tool-based sources, feedback dismissals and the
catch-up filter (parts 17 to 21). Meetings device pairing (part 7) is parked and was not touched.

### Proof

| Claim                                                                                     | Where                            |
| ----------------------------------------------------------------------------------------- | -------------------------------- |
| 22 native tests: definitions, schedules, runs, privacy                                    | package tests, native            |
| The same code as WebAssembly loads in the real host                                       | package tests                    |
| Two people, view and manage shares, an administrator, all kept apart                      | installed test                   |
| Row security removed leaks both tables, and restored stops it (seen red)                  | installed test, RED and GREEN    |
| A planted marker in a title and in run text never reaches queue or modules                | installed test                   |
| Daily 7:00 registers once in the owner's saved zone (Pacific/Auckland), manual removes it | installed test, reads the queue  |
| 26 steps replayed against the old routes give the same answers                            | installed test, runs the old app |
| The registered schedules match what the old routes registered                             | installed test                   |
| Real Rust server over HTTPS, two people, create, read, refuse, edit                       | live run                         |
| Alignment across zones with a fixed clock                                                 | native schedule tests            |

### Every code the old routes can give

The sign-in check comes from the host before any of these.

| Status | Message or code                                                                                           | Route           |
| ------ | --------------------------------------------------------------------------------------------------------- | --------------- |
| 400    | Expected JSON object body                                                                                 | create, edit    |
| 400    | title is required / title must be a string / title must not be empty                                      | create, edit    |
| 400    | selectedToolNames must be an array                                                                        | create, edit    |
| 400    | selectedToolNames[i] must be a string / must not be empty                                                 | create, edit    |
| 400    | Briefings can only select declared read-risk assistant tools                                              | create, edit    |
| 400    | cadence must be manual, daily, or weekly                                                                  | create, edit    |
| 400    | briefingType must be morning, evening, or weekly_review                                                   | create, edit    |
| 400    | scheduleMetadata must be a JSON object                                                                    | create, edit    |
| 400    | enabled must be a boolean                                                                                 | create, edit    |
| 400    | invalid timezone                                                                                          | create, edit    |
| 400    | dayOfWeek required for weekly schedules                                                                   | create, edit    |
| 404    | Briefing definition not found                                                                             | edit, list runs |
| 404    | Briefing run is missing or owned by someone else, code briefing_run_not_available                         | open one run    |
| 401    | Not signed in (answered by the host)                                                                      | all             |
| 409    | briefing_run_in_flight, "A briefing run with this idempotency key is already queued or running" (part 17) | run now         |
| 500    | Briefing run could not be queued (part 17)                                                                | run now         |

The app map also names briefing_not_set_up, which belongs to part 17.

### Not proven

- Reaching the server from another device. The live run used the server's own address on this box.
  The package adds no network listener, so it relies on the server's own reachability, which is
  proven elsewhere, but this part did not check from a phone or another computer.
- The registered schedule zone cannot be read back by a package. First-check alignment is therefore
  a tested rule, and part 17 must read the registered zone when it wires the run job.
- Plan state on one run is always "unavailable" until the calendar read is wired (part 20).
- Pending and failed run states, and the run-now route, wait for part 17.
- The list of outside sources is always empty until part 18.
- Feedback dismissals and the catch-up filter wait for part 21.
- The old query check on a run's job id is not added, because no job exists yet.
- Schedule repair after a list call runs inside the request and is best effort, like the old app.
- A manager who edits a shared definition does not change the owner's schedule. The old app would
  have. This is a deliberate safety difference.
- Time zone names are matched with the Rust zone database, which is case sensitive.
- Opening the definitions list re-registers each schedule only when none exists. A schedule whose
  time or zone drifted is corrected by the next edit, not by the list.
- Odd inputs the old validator coerces (for example numbers sent as text) are not all replayed.

## Briefings run job (part 17)

Card JS-265. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

The Briefings package now writes a briefing for its owner, either when they ask for one or when
their saved schedule fires. It shows no screen yet. The text is a fixed fallback line, because the
model-based writing is a later part and all model calls will go through the router.

- Run now: a new route queues one run and answers at once with the job and run ids. Asking again
  with the same key while the first is still queued or running is refused. Once the first has
  finished, the same key starts a new run.
- Scheduled run: the run id is made when the job fires, because a scheduled job cannot carry one.
  A fire that lands in a different zone than the owner's is registered again, and it only runs when
  it lands close enough to the owner's target time.
- Once a day: a second scheduled fire on the same local day does nothing and sends nothing.
- Deadline: a run that takes longer than six minutes fails with a fixed label and rolls back, so it
  leaves no run row and no notification.
- Notification: a successful scheduled run posts one notification with a fixed title and no
  briefing text. The same run never posts twice.
- Status: opening a run by its job id says pending, ready or failed. Another person gets the
  usual "not found" answer.
- Blocked tools: a definition with a non-read tool stores a blocked run with a fixed message.
- Host: three small additions let a package list its open jobs, read one job and read a schedule.
  The package now declares the notification port and the guest imports it.

### Proof

| Claim                                                                                  | Where                           |
| -------------------------------------------------------------------------------------- | ------------------------------- |
| Manual and scheduled runs, fallback text, pending and failed reads, 409 and reuse      | 9 native tests, fixed clock     |
| Same-day skip sends no second notification                                             | native and installed test       |
| Six-minute overrun rolls back the run and the notification                             | native test, fixed clock        |
| Notification holds only a fixed title and an event key                                 | installed test, reads the row   |
| Briefing text is in no queue row, job payload, notification or log table               | installed test, scans 13 tables |
| A second person cannot read status or queue a run; seen failing without row security   | installed test, RED and GREEN   |
| Old routes still match (26 steps)                                                      | installed replay test           |
| Native and WebAssembly builds, tests in both                                           | gate                            |
| Real Rust server over HTTPS: queue, worker finishes it, status ready, stranger refused | live run                        |

### Not proven

- Two scheduled fires at the same moment. Same-day checking has no lock, so a race could store two.
- The real six-minute wait. The deadline is proven only on a fixed clock.
- A failed notification rolls back the whole run, by design, so the owner gets no run that day.
- The same-day check uses the owner's local date. A run near midnight in a zone far from UTC was not
  tried.
- Queue keys are unique forever, so a reused key derives a new key, followed for up to 50 finished jobs. Only a few reuses were tried.
- Reaching the server from another device was not checked.
- Model-written text, tool sources and screens are later parts.
- Review fixes for a switched-off schedule, twenty manual runs hiding the scheduled one, and the third reuse of a key are in the code and the gate stays green, but no new test targets each.

## Briefings gathering (part 18)

Card JS-266. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What it does

When a run starts, Briefings now collects the owner's tasks, calendar and email before the stub
writer runs. It reads only through other modules' public calls, never their tables. Each source
that cannot be read shows up as a visible gap on the run, with a reason.

| Source                            | How it is read                                                       |
| --------------------------------- | -------------------------------------------------------------------- |
| Tasks                             | New narrow Tasks call: id, title, status, due time and priority only |
| Calendar                          | Connectors calendar call, times shown in the owner's own zone        |
| Email                             | Connectors email call, keeps mail that needs action or a judgement   |
| Chat, commitments, priority model | Not built in this app yet, shown as "unwired" gaps                   |

Gap reasons are tool_failed, truncated, empty, unwired and source_auth (a connected account needs
the person to sign in again). A source served from cache marks the run as using cached sources.

### Rules carried over from the old app

- A section keeps at most 8 lines and 1200 characters.
- Tasks are the open ones plus those finished since the last good run (or the last 24 hours), with
  at most 5 finished ones.
- Email is kept when it has not been answered, is not a plain confirmation, and is actionable.
  A request for action always wins over the confirmation rule.
- Outside text is cleaned: whitespace collapsed, angle brackets and ampersands escaped, special
  marker words removed.
- Outside contributions: at most 20 items, headline 200 characters, title 200, detail 500, in-app
  links only. A module the person did not select is never asked.

### Privacy

- Gathering reads only the run owner's data. The Tasks call returns each caller only their own
  tasks, shown by a test with a second person and an admin, which was seen failing with row
  security removed and passing with it back.
- Only counts, gap reasons and source names are stored on the run. Briefing text is not in the
  stored metadata, job payloads or activity rows. The installed test scans 13 tables and 7 job
  payloads for a planted marker and finds nothing.

### Changes outside Briefings

- Tasks 0.1.3 adds the narrow briefing call and its changelog entry.
- The app map in the Briefings manifest names the gathering feature and the fix path (Settings,
  Connections).

### Not proven

- The installed test has no real Tasks or Connectors module installed, so a real cross-module
  call through the host is not proven. It proves the missing-module path shows visible gaps.
- Chat of the day, commitments and the priority model are gaps, not data.
- Evening and weekly briefings use the morning gather.
- No outside module offers contributions yet, so the caps are proven with a fake provider only.
- The email "plain confirmation" filter is keyword based and simpler than the old one.
- The awaiting-reply and worth-knowing email caps are not applied separately.
- Reaching the server from another device was not checked from a phone or second computer.
- The model-written briefing is part 19. The stub writer still produces the text.

## Briefings morning composition (part 19)

Card JS-267. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What it does

A morning briefing run now asks the person's configured model to write the briefing. It builds the
request from that person's own tasks, calendar and email, sends it through the AI router (never to
a named provider), then tidies and stores the answer. The text replaces the plain digest from part 17. If the model is missing or fails, the run still finishes with the plain digest and says why.

- Anything that came from outside (mail, calendar entries, task titles) goes into marked data
  blocks and is cleaned first. The instruction block above them is fixed text with nothing filled
  in, so an email cannot give the model orders.
- Each section keeps at most 8 lines and 1200 characters. The email catch-up keeps at most 8
  entries and reports how many it left out.
- Each email gets an evidence row (reported today, settled by a later payment confirmation,
  informational, or current status unknown), as in the old app.
- Calendar and email signals (prep needed, high-stakes meeting, tight travel, open gap, time
  sensitive, needs reply) are worked out with the old rules and stored with the run, top 5 each.
- Suggested tasks from email become action rows, earliest due first, at most 8. Email that is
  already a row is not repeated in the catch-up.
- The written text is put in clock order, with news and sports last, and sections that only repeat
  an event title are dropped.

### Proof

| Claim                                                                                      | Where                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| The instruction block has no filled-in outside value; seen failing when one was added      | static test, red then green                    |
| Hostile mail and calendar text cannot close a block or open a new instruction block        | native test                                    |
| Section and catch-up caps, and the output limit sent to the router                         | native tests                                   |
| Evidence rows, signals, ordering, tidy rules                                               | native tests, rules taken from the old tests   |
| Action rows and email catch-up are saved with the run                                      | native test                                    |
| No model gives a plain digest and a reason; evening and weekly runs make no model call     | native tests                                   |
| Only the run owner's data is read, and a second person's data never reaches the request    | native test                                    |
| Model text is in no queue row, job payload or notification                                 | native and installed tests (13 tables scanned) |
| A second person cannot read the stored text; seen failing without row security on the runs | installed test, red and green                  |
| Native and WebAssembly builds, tests in both                                               | gate                                           |
| Real Rust server over HTTPS, real router, stand-in model: run stored the model's text      | live run                                       |

### Changes outside Briefings

- Tasks 0.1.4 adds a narrow read of suggested tasks for the briefing, with its changelog entry.
- The Briefings manifest asks for the AI capability and the app map names the feature.
- The live server test now configures a provider and model for the owner.

### Not proven

- The model in the live run is a stand-in server in the test, behind the real router. No real
  vendor model was called.
- The host gives a guest one fixed failure text, so "no model set up" and "the call failed" both
  show as a failed call on a real server. The "no model" reason is proven in native tests only.
- Not wired yet, so those parts of the prompt are empty: chat of the day, commitments, weather,
  notes vault, goals, sports, news, the priority model, calendar follow-through and plan context
  (part 20).
- Calendar and email preference settings use the old defaults, not the person's saved choices.
- The catch-up has no "as of" time because connector sync freshness is not read yet.
- Evening and weekly briefings still use the plain digest.
- No paired-device credential check was needed or built.
- Reaching the server from another device was not checked from a phone or second computer.
