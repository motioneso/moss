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
