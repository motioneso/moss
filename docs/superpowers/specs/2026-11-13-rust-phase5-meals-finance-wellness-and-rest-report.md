# Rust Phase 5: Meals, Finance, Wellness and the rest report

Part of https://github.com/motioneso/moss/issues/4027. This report follows the plan in
`2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. Each part adds its own section
here as it is built.

## Goals package skeleton (part 4)

### What was built

- A new registry package in `modules/goals`, in the same shape as the finished News and
  Backtrack packages. The manifest declares the two goal tables, the three old SQL files under
  the core-legacy ledger, the five routes, and the app map entries (the settings entry and the
  two feature entries). No screen is in this part, as the plan says.
- The five routes from the old app: list goals, create a goal, read one goal, change a goal
  (marking it completed or archived closes it), and add evidence to a goal. Answers keep the
  old field names and shapes, including the old wording for refused requests.
- Evidence on a closed goal (completed or archived) is refused with a 409 answer. The plan
  asked for this refusal. The old TypeScript routes had no such check, so this is the one
  place where the Rust package is stricter than the old code, taken from the plan's wording.
- Clearing a text field on a goal stores an empty string, as the old server did. The parity
  replay below caught this, and the Rust code now matches it.
- The host's frozen list of old SQL now names the two goal tables. The old Goals manifest
  never listed its tables, so the freeze script names them directly, the same way it already
  does for Calendar.
- Chat tools, the memory sync jobs and the Today section are later parts (5 and 6) and are
  not in this package. The manifest declares no job queues, no model call and no network use.

### Proof

- Route parity: the installed-package test replays 14 steps against the old TypeScript routes
  on the same gate database and compares every answer, with ids and times masked. It passed.
- Row level security: a second person reads no goals through the routes or directly in the
  database. Replacing the owner rule with a wide-open rule in the same test let the second
  person read the goal, and putting the owner rule back shut them out again. It passed.
- Closed goal: after a goal is marked completed, adding evidence answers 409. It passed in
  the native tests, the installed-database test and the live run.
- Private text: a planted marker in a goal title, evidence and progress text appears in no
  job payload, no second person's answer, no error body and no server log. The package makes
  no job, model or network calls at all, and a test checks every host call it does make.
- Both builds: the crate's tests pass natively (5 tests), and the same code built as
  WebAssembly passes the host package tests (6 tests) through the real component host.
- Live run: the packaged module was installed through a signed test registry and served by
  the real Rust server over HTTPS. Two signed-in people created, read, changed and closed
  goals through the real route path, with nothing intercepted or rewritten.

Commands, all through `scripts/run-gate.sh` (expected exit code 0):

```bash
scripts/run-gate.sh start --gate test:rust-goals
scripts/run-gate.sh start --gate test:rust-goals-live
```

### Not proven or not built

- No screen. The Goals section on Today is part 6 and needs Ben's agreement first.
- No chat tools and no memory sync. Those are part 5.
- No account export or delete section for the goal tables. The plan gives that to no Goals
  part yet, so it is listed here as not built.
- Nothing was checked from a phone or a second device. This part has no screen, so there
  was nothing to look at from another device.

## Web Research package, no screen (part 10)

Card JS-289. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

A built-in Web Research package that other parts of Moss can ask to search the web. It has no
screen, no database table and no new crate.

- **Search.** The chat tool `web.search` and the call News makes both go through Brave Search.
  The query is cut to 200 characters, at most five results come back, and each has a title,
  address, short snippet, domain and (when known) age. The trace says whether the query or
  the result count was cut. A person can ask for results from the last day, week or month.
- **The gate.** The order is the old one. A saved Brave key wins. Without one, a switched-off
  built-in search gives `native-disabled`. Otherwise no chat model gives
  `no-key-no-native-model`, a model that can search gives model search, and a model that
  cannot gives `model-has-no-search`. The words are the ones the News screen already shows.
- **Where the answer shows.** A new status route reports the gate for the signed-in person. News
  can ask for the same answer through a package call.
- **The key.** The package never sees the Brave key. The server attaches it to the one allowed
  address and nothing else.
- **Two small host additions.** The package needed to know whether a key is saved, and whether
  the person's chat model can search, without learning either value. The server now answers a
  "is it saved" question with yes or no only, and a "can the chat model search" question with
  yes or no only (no provider or model name).

### Differences from the old code (on purpose)

- A search with no words is refused with a fixed sentence instead of being sent on.
- A failed search returns one fixed sentence. The old code threw an error that included the
  provider's reply, which can echo the query.
- The "unavailable" trace now carries the reason, so News and chat can say why.
- The old Web module had no routes. The status route is new, and it is the only route.

### Proof

| Claim                                             | Evidence                                                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate matches the old resolver                     | A full truth table of key, switch and model in native tests, using the same reason words as the old tests                                                                                                               |
| News topics work against a fake search reply      | The real component answers News's package call with the fields News reads (title, address, snippet, age) from a canned Brave reply; a failed search says so                                                             |
| Query text is private                             | The marker query reaches only the Brave address; no other host call, no error text and no reply carries it. A leak planted in the code made the test fail                                                               |
| No tables, so nothing for a second person to read | The manifest owns zero tables and shares one switch. The live run scans every table in three schemas for a planted marker; the scan failed with a leak planted                                                          |
| Credential question never exposes the value       | Host test: saved or not for the instance key and per-account key; a second person sees the instance key as saved and another person's account key as not. The test failed when the check was replaced with "always yes" |
| The package asks only for its own resources       | Package test: other hosts, other kv names, model generation, jobs and database all refused                                                                                                                              |
| Native and WebAssembly builds                     | 22 native tests; the same code as a component passes 9 package tests in the real host                                                                                                                                   |
| Route parity                                      | There was no old route. The tool and the News-facing call keep the old limits, truncation, freshness and result shape, tested one by one                                                                                |
| Live run                                          | Real Rust server over HTTPS, package installed from a signed test registry: signed out gets 401, two signed-in people get the status, an undeclared path gets 400                                                       |

Commands, all through `scripts/run-gate.sh` (expected exit code 0):

```bash
scripts/run-gate.sh start --gate test:rust-web-research
scripts/run-gate.sh start --gate test:rust-web-research-live
```

### Not proven or not built

- **Chat-model search returns no results yet.** The model port returns text without the pages
  the model cited, and the old code refused any address no citation backed. The package says
  `citations-not-available` rather than guess. Fixing it needs a host change.
- **No way to save the Brave key or turn built-in search off.** The Rust server has no settings
  screen for either, so the key is set only on the server side and the switch keeps its
  default (on). A settings part must add both.
- **No real Brave search.** There is no real key in any test. The Brave request and reply shape
  were checked against the old code and a canned reply, not the live service.
- **No search text through the live server.** The live run has no HTTP path that runs a chat tool,
  so the status route was proven live and the search itself through the real component with the
  host's services stood in. The private-text proof for search is therefore at that level.
- **The live status shows only "no key, no model".** The live server has no chat model set up,
  so the other gate answers are proven in tests, not live.
- **Page reading** is part 11. News still does not call this package in Rust. Wiring it is a News part.
- **Other devices.** The live run was on the same machine. Nothing was checked from a phone or
  second device, because this part has no screen.
- **The old server-side key variable is not read.** The old code also accepted a Brave key from an
  environment variable. The package reads only the saved key, so an install that relied on the
  variable has no search until the settings part adds a way to save it. Nothing in the Rust build
  ships to an existing install yet.
- **Small differences from the old tool.** A blank query is refused with an error where the old
  tool returned an unavailable result. Result addresses for IPv6 hosts drop the square brackets.
  The Brave call has no 8 second cap of its own and uses the time the host has left.
- **A failure reading the chat model shows as "no model".** The search stays off either way, but
  the reason shown can be the wrong one.

## Wellness test stand-in (part 12)

Card JS-294. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

Invented Wellness data for tests, and nothing else. It lives in the existing test-only stand-in
crate (`rust-spike/standins`, which no module or app depends on), so it ships nowhere. No
package, route, table, tool or screen exists yet. Those are parts 13 to 18.

- **Two invented people**, Alice and Bob, with fixed ids and fixed dates around one reference
  day (15 March 2026), so a later 30-day count has a known window.
- **Check-ins.** Alice has 8 and Bob has 4. Together they cover all six core feelings, a note and
  no note, a wheel and an assisted entry, and the missing numbers the old data allows.
- **Medicines.** Alice has 6 (once a day, twice a day, as needed, certain weekdays, a cycle, and
  one switched off). Bob has 2. The weekday and cycle ones are there so the schedule code in
  part 14 has every shape the stand-in can cover.
- **Dose logs.** 24 for Alice (taken, skipped, as-needed with a reason, and days with no log at
  all) and 6 for Bob.
- **Therapy notes.** 4 for Alice (alone, linked to a check-in, linked to an emotion, both
  kinds) and 2 for Bob.
- **Markers.** Every private text value (check-in note, medicine name and note, dose, as-needed
  reason, therapy note) holds one token that starts with `MKR-` and names its owner, such as
  `MKR-THERAPY-A-02`. A later leak test plants the rows and searches logs, job payloads,
  activity rows and exports for those tokens. A helper returns each person's tokens.
- **Field names** are the ones the old routes return, so a later part can post a row or compare
  an answer without translating.

### Proof

| Claim                                               | Evidence                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each row has exactly the old route's fields         | A native test compares every row's key set with the old Wellness response types                                                                                                                                                                                                                                                                |
| Rows obey the old database rules                    | A native test mirrors the old column rules. Then the real old database accepted every row, inserted as each person under the old row security rules. This caught a bug in the first draft of the ids (one id was a character too long), now fixed                                                                                              |
| A second person cannot read the first person's rows | Real database test: each person reads only their own count in all four tables. With the four read rules replaced by a wide-open rule, Bob saw all of Alice's rows, so the test can fail. With the real rules back, Bob saw only his own                                                                                                        |
| Every private value carries a unique marker         | Native test. Seen failing when one marker was removed (`body has private text with no marker`)                                                                                                                                                                                                                                                 |
| The data is invented, never real                    | A native check refuses addresses outside `example.com`, web links and digit runs of 7 or more in any text field. Seen failing when a `gmail.com` address was planted in a note. A second test plants three real-looking values (a phone number, an outside address, a web link) and expects each caught, and two allowed values expecting none |
| A reviewer reads each fixture                       | The four files are `rust-spike/standins/fixtures/wellness/*.json`, about 800 short lines in all. Every name is a made-up word (Placeholdin, Examplex, Samplet and so on), every free-text note says `invented`, and every id is a pattern                                                                                                      |

Commands (expected exit code 0, both through `scripts/run-gate.sh`):

```bash
scripts/run-gate.sh start --gate test:rust-standins
scripts/run-gate.sh start --gate test:rust-wellness-fixtures
```

### Not proven or not built

- **Row security, log scans, job payloads and activity rows for the real package** are parts 13
  to 16. There is no package yet, so there is nothing to leak from. Here only the data and the
  old database were checked.
- **Route parity against the old handlers** has nothing to compare yet, because no Rust route
  exists. The field names and rules are matched against the old types and the old database.
- **WebAssembly.** This crate is built and tested natively only. It is a test crate that no
  package depends on, and the crate's servers use networking that does not build for
  WebAssembly. The Wellness package in part 13 gets both builds.
- **No live run and no second device.** There is no server path or screen to run.
- **No app map entries.** Nothing a person sees or does has changed, and there is no Wellness
  manifest yet. Part 13 adds the manifest and its entries.
- **Only five of the eight medicine schedule kinds** are covered (once a day, several times a day,
  as needed, weekdays, cycle). The every-so-often and monthly kinds are added when part 14 needs
  them.
- **Check-in feelings use the old taxonomy** only for core feelings plus three valid second-level
  words. Third-level words are left empty.
- **No expected figures** (30-day counts, insights). Parts 14 and 16 work them out from the old
  code on these rows.
- The numeric check-in values (intensity, energy) cannot carry a marker, so a leak test can only
  search their text.
