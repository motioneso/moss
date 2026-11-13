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
- Queue keys are unique forever, so a reused key derives a new key. Only the first reuse was tried.
- Reaching the server from another device was not checked.
- Model-written text, tool sources and screens are later parts.
