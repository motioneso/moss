# Rust Phase 5: Meals, Finance, Wellness and the rest report

Part of https://github.com/motioneso/moss/issues/4027. This report follows the plan in
`2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. Each part adds its own section
here as it is built.

## Wellness package: insights and chat tools (part 16)

Card JS-303. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

The insights route and the two chat tools. No screens.

- **Insights.** Up to five lines worked out in code from the last 30 days: most-logged feeling,
  hardest weekday, strongest weekday, sad or angry check-ins that carry a note, and medication
  adherence. Nothing is returned under 7 check-ins or when the first one is under a week old.
  Percentages round half up, as before. Nothing reaches a model.
- **Recent check-ins tool.** The 20 newest check-ins with feeling, intensity, mood index and note.
- **Medication adherence tool.** Seven-day counts only. It never lists a medicine.
- **Consent.** With assistant access off, both tools answer the fixed refusal and read no row. The
  check happens before any read.
- **Approval.** Both tools are declared read-only in the manifest. The host applies the person's
  approval choice before the package runs. The package never accepts an approval flag.
- **Same data.** No new database file and no new crate.
- **App map.** The manifest lists the insights and chat-tool features with their error text.

### Differences from the old code (on purpose)

- **Extra tool input is refused.** Both tools take no input. The old tools ignored extras.
- **Whole numbers print without a decimal point** in the tool answers, as the old server printed them.
- **Energy-trend note and focus signal are not brought back.** Both write into the assistant's prompt,
  which this package cannot do (no model port, plan section 5.4). Part 13 left this to part 16.
- **No "outside content" mark on tool answers.** The host's tool declaration has no way to say it.
- **The insights route is not gated by consent**, matching the old route.
- **Insights read at most 1000 check-ins** in the 30-day window, the host's row cap. Rows come oldest first, so a person with more than 1000 in 30 days loses the newest from the insights.

### Proof

| Claim                                       | Evidence                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent off returns no private value        | Guest test plants a marker in a check-in, turns access off, calls both tools and sees only the refusal and no database call. Seen failing with the consent check removed               |
| Insights and tools match the old code       | The old tool code and old insights route run on the same fixtures as the installed package. Both tools, the refusal and the insights route (5 lines) match with ids and times masked   |
| A second person reads nothing               | Real database test as three people. Other person and admin get empty tool answers and no insights. With the owner rule opened the tool and insights leak, with it restored they do not |
| Marker never reaches a log, job or activity | Note text is absent from every queue and log table and from the activity record. Guest test checks a host failure never echoes it. Seen failing with the error echo restored           |
| Native and WebAssembly                      | 8 new guest tests run natively. The same code is built as a component and loaded by the real host, where 2 new installed tests pass                                                    |
| Real server, other device                   | Live test over https on a non-loopback address. Both tools refused with access off and answered with it on, insights worked for two people, and the server log held no marker          |

Commands (expected exit code 0, both through `scripts/run-gate.sh`):

```bash
scripts/run-gate.sh start --gate test:rust-wellness
scripts/run-gate.sh start --gate test:rust-wellness-live
```

### Not proven or not built

- **Medicines and insights in the selective export** still answer "not available yet".
- **Approval prompts.** The host's approval rule was exercised in the live and installed runs only
  by approving each call. A person's own choice to skip prompts was not run.
- **Chat screens and the model's use of the tools** are not part of this package.
- **Old energy-trend note and focus signal** are not built (see above).
- **Time zone for insights.** The package reads the person's zone from the host. A person whose
  saved zone changes mid-window was not tested.
- **Shared Rust toolchain folders.** Builds used a copy of the cargo and rustup folders under the
  task scratch folder, and the build output folder was task-owned. All were deleted at the end.

## Goals chat tools and Today data (part 5)

Task JS-290, Card 604. Release note Category: N/A.

### What was built

Part 4 already supplied the signed registry package, both owner-only tables, the three unchanged
legacy SQL files and the five goal routes. This part reuses those route handlers and adds:

- The five existing tools: list goals, read one goal, create a goal, change a goal and add
  evidence. Replies retain the old `data` envelope. Reading a goal returns its ten newest
  evidence summaries, with only the kind, source label and summary in each entry.
- A signed-in tool transport at `POST /api/m/goals/goals/tools/run`. It crosses the existing
  trusted host tool service before running the handler. Writes require a one-use approval for
  the same person, tool and exact inputs. Read tools follow the host's saved approval policy.
  Nothing supplied in the request can grant approval.
- A signed-in Today data call at `GET /api/m/goals/goals/today`. It filters the existing ordered
  goal list to active goals, matching the old Today section. It returns an empty list when no
  active goal belongs to the person. This part adds no screen.
- Package feature entries describing the tools, approval refusal and Today data.

The first installed tool and live-server runs refused even approved inputs. The host preserves
JSON field order when it fingerprints approval; the guest had sorted those fields. Enabling
`serde_json`'s existing `preserve_order` feature keeps the incoming order across the component
boundary. The same installed test failed before this change and passed after it. No crate or
crate version was added; the lock file only connects existing dependencies to this feature.

The evidence-on-closed-goal refusal introduced in part 4 also applies through the tools. This is
the same documented difference from the old handlers, rather than a new write path.

### Differences and limits

- Writes use the Rust host's one-use approval instead of the old automatic install grant.
  Read tools follow the host's saved policy. Legacy approval-card presentation text is not
  ported in this part.
- Extra tool input fields are refused. The old tool schemas allowed extras.
- Host failures share the fixed unavailable-or-approval reply. That keeps private host errors
  out of responses, but does not distinguish every failed write from missing approval.

### Proof

- Native guest tests exercise tool writes and reads, the ten-evidence limit, active-state
  filtering, second-person refusal, validation and fixed error wording. The WebAssembly
  component runs through the real host against fixture rows, rather than a native substitute.
- The installed component's five tool replies are compared with the existing TypeScript tool
  handlers on a disposable database. Generated ids and timestamps are masked; all other fields
  are compared. Tool writes are then read through the real routes. The earlier fourteen-step
  route replay remains in the same gate.
- Both table owner rules are checked with a second person. The same privacy assertion fails
  when each policy is replaced with an open rule, and passes after the owner rule is restored.
  A separate administrator also gets no private goal or evidence through tools or Today.
- Planted goal and evidence text is absent from stored job payloads and real host activity.
  The error-text assertion is run with its fixed-message protection removed, and the activity
  assertion with request logging deliberately added. Each fails with the protection removed;
  each passes again after restoration. The control script restores source even if a control
  fails. The manifest allows no job, model or network capability.
- The live gate installs the signed package and calls all five tools and Today through the
  real Rust HTTPS server. It uses real fixture account sign-in, verifies the certificate and
  origin, refuses an untrusted origin, checks missing sign-in and approval, reads tool-created goals through routes, checks
  consumed approval, and verifies a second account cannot read them. No response is intercepted
  or rewritten. The planted text is absent from the server log.

Commands run from `~/Jarv1s`, with task-owned `CARGO_HOME`, `RUSTUP_HOME` and
`CARGO_TARGET_DIR` in scratch storage. All commands below expect exit code **0**:

```bash
scripts/run-gate.sh start --gate test:rust-goals
scripts/run-gate.sh start --gate test:rust-goals-live
pnpm typecheck
pnpm check:file-size
```

The Goals gate includes the native tests, component build, package tests, installed tests and
source-removal privacy controls. Both builds execute tool tests: native fixture tests and real
installed-component database tests. Changed TypeScript files also pass ESLint; changed supported
files pass Prettier and changed Rust files pass rustfmt checks. The proof artifact records the
actual command output and the independent review.

### Not proven or not built

- No Today screen or chat approval screen. The Today screen is part 6; this part supplies only
  its data. A full chat conversation is not exercised; tools are called through the real host
  service and HTTPS transport using a fixture's trusted approval grant.
- No Memory sync or reconcile jobs. The task explicitly limits this part to tools and Today
  data, despite the broader plan's background-job row mentioning part 5. The package declares
  no queues. Account export and deletion remain as listed in the part 4 report.
- No physical phone, laptop or tailnet check. The live gate uses the real HTTPS server through this machine's
  non-loopback network address, with sharing enabled only on its disposable fixture. This part has no screen and does not establish second-device acceptance.
- No private user records or production database are used. No Workshop or Food work, global
  install, or new Rust crate is included.

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

## Web Research page reading (part 11)

Card JS-292. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

The Web Research package can now read pages. It has no screen, no database table and no new crate.

- **What already existed.** The server already had a safe "read a public page" service. It refuses
  anything that is not HTTPS on the normal port, refuses addresses with a password in them, checks
  every address a name points to and every redirect hop, follows the site's robots rules, spaces
  calls to one site one second apart, and caps time and size. That was built and tested earlier, so
  this part did not rebuild it.
- **The new tool.** The chat tool `web.read` takes up to five addresses and reads them one after
  another. Each good page comes back with its address, site, title, text (cut at 12,000
  characters), a 500 character excerpt, the time it was read and whether it was cut. A page that
  could not be read shows as skipped with one fixed reason word. The trace counts addresses asked
  for, read and skipped, and says if the five-address limit applied.
- **The text.** Scripts, styles, navigation, comments and tags are removed, six entities are
  decoded and white space is collapsed, the same way as the old reader.
- **A read route.** `POST /read` takes the same addresses for a signed-in person. A call that
  names no address gets a plain 400.
- **A package call.** `webRead` gives the same answer to other modules, so News can use it later.

### Differences from the old code (on purpose)

- Only HTTPS is read. The old tool also read plain HTTP.
- Robots rules and the one-second spacing now apply. The old tool applied neither.
- Only web pages and plain text are read. The old tool read any type.
- Addresses are read one at a time. The old tool read them side by side.
- A read that fails carries only a fixed reason, never the page or the error text. Two new
  reasons exist, `challenge` for a bot check page and an optional detail word.
- Text is never cut inside a character.
- The old module had no routes. The read route is new, added so the real server path can be
  checked.
- The `goal` input is still ignored, as before.

### Proof

| Claim                                      | Evidence                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text matches the old reader                | 34 pages, including odd ones, were run through the old reader. The new code gives the same title and text on all of them                                                                                             |
| Private and loopback addresses are refused | The real component and real host refused nine addresses (private, loopback, shared-range, localhost, and names that point at them). The site log shows none was contacted. Each guard was removed in turn and failed |
| Only HTTPS, port 443, no password          | Plain HTTP, another port and a password in the address are each refused. Each check was removed and the test failed                                                                                                  |
| Robots rules and spacing                   | A site that forbids everything is never asked for the page. A long wait is refused as `rate_limited`. Both checks were removed and the tests failed                                                                  |
| Private text stays private                 | The address goes only to the fetch call. The live run sent a marker inside a refused address; no table and not the server log held it. The scan failed with a leak planted                                           |
| Two people                                 | Two signed-in people each read through the real server and got their own answers. The package owns no tables, so there is no row rule to remove; the table scan covers three schemas                                 |
| Route and sign-in                          | Live: signed out gets 401, no address gets 400, a valid call gets 200 for two people                                                                                                                                 |
| Real public web                            | The live server read a real public page (title "Example Domain") for two people                                                                                                                                      |
| Reachable from another device              | The live server was reached through the machine's own network address. With sharing off it answered 403; after the administrator turned sharing on it answered 200                                                   |
| Native and WebAssembly builds              | 33 native tests; the same code as a component passes 9 package tests and 6 read tests in the real host                                                                                                               |

Guard-removal results, one run per removed check: the literal address check, the resolved
address check, the localhost name check, HTTPS only, port 443 only, the password check, robots
rules and the long-wait refusal each made at least one read test fail, and the restored code
passed.

Commands, all through `scripts/run-gate.sh` (expected exit code 0):

```bash
scripts/run-gate.sh start --gate test:rust-web-research
scripts/run-gate.sh start --gate test:rust-web-research-live
```

### Not proven or not built

- **No row-level-security test with a removable rule.** The package owns no tables, so there is
  no row rule to remove. The proof is the two-person live run and the planted-marker scan.
- **The approval default differs.** The old ruling made `web.read` run without a prompt. In
  Rust the prompt follows each account's action policy, which asks until a settings part exists.
- **News does not call `webRead` yet.** Wiring it is a News part.
- **Other-device check was from the same machine.** It used the machine's network address, not a
  phone. Nothing was checked from a second physical device.
- **The real internet was read only for one site.** The refusal of private addresses was proven
  against a local test site and a name table, not against hostile real sites.
- **Chat-model search results** still come back empty, as noted in part 10.

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
- **Markers.** Every private free-text value (check-in note, medicine name and note, dose, as-needed
  reason, therapy note) holds one token that starts with `MKR-` and names its owner, such as
  `MKR-THERAPY-A-02`. A later leak test plants the rows and searches logs, job payloads,
  activity rows and exports for those tokens. A helper returns each person's tokens.
- **Field names** are the ones the old routes return, so a later part can post a row or compare
  an answer without translating.

### Proof

| Claim                                               | Evidence                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each row has exactly the old route's fields         | A native test compares every row's key set with a list copied from the old Wellness response types (it would not notice later drift in those types)                                                                                                                                                                                            |
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
  as needed, weekdays, cycle). Every-n-hours, every-interval and monthly are added when part 14
  needs them.
- **Dosage, feeling words, body sensations and schedule times carry no marker.** They are plain
  generic values, so a leak search cannot find them.
- **Check-in feelings use the old taxonomy** only for core feelings plus three valid second-level
  words. Third-level words are left empty.
- **No expected figures** (30-day counts, insights). Parts 14 and 16 work them out from the old
  code on these rows.
- The numeric check-in values (intensity, energy) cannot carry a marker, so a leak test can only
  search their text.

## Wellness package: check-ins and assistant access (part 13)

Card JS-296. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

A new package in `modules/wellness`, with its manifest and no screens. It serves five routes that
behave like the old ones: save a mood check-in, read the history newest first in pages, change an
earlier check-in, read whether the assistant may use check-ins, and change that choice.

- **Same data.** The package owns the four existing Wellness tables, and its 16 database files are
  the old ones byte for byte. Installing it changes no saved data. The frozen list of file
  fingerprints already held all 16, so it did not change.
- **Same answers.** The check-in routes copy the old rules: the same six feelings and their
  second-level words, the same rating ranges, the same first-error wording, the same paging token
  and the same refusal for a stale or mismatched token. Changing a check-in still needs the feeling
  and still clears the third level.
- **Local day.** A new check-in stores the person's own date and time zone offset. The host's date
  call now also returns the offset, so the package needs no time zone library.
- **Assistant access.** The choice is stored in the same preference as before. Until a person
  chooses, access reads as on. The shell gets one more preference binding for it, and a true or
  false shape for stored values.
- **No model port.** The manifest asks for the database, the date call and the preference store,
  and nothing else. No check-in text can be sent to a model, a job, a log or the network.
- **App map.** The manifest lists the settings entry and the two features, with plain error
  descriptions. It lists no screens or navigation.

### Proof

| Claim                                              | Evidence                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes match the old handlers                      | The test runs the old routes on the test database and the new package side by side, with ids and times masked. 22 steps without ids and 7 with ids match. Paging tokens are compared by shape, not by value                                                                                                                |
| A second person cannot read or change check-ins    | Real database test through the installed package as two people. With the owner rule replaced by an open rule, the second person read the first person's row. With the rule restored, they read none                                                                                                                        |
| Check-in text stays out of logs, jobs and activity | The note is absent from job payloads, the activity record and the second person's answers. A guest test shows a host failure never echoes the note. That test was seen failing with the protection removed                                                                                                                 |
| No model port                                      | A test reads the manifest and expects exactly the database, date and preference ports                                                                                                                                                                                                                                      |
| Native and WebAssembly builds                      | The guest tests run natively (6 behaviour, 2 privacy). The same code was built as a WebAssembly component and loaded by the real host in the package tests (6)                                                                                                                                                             |
| A changed legacy database file stops the build     | Package test changes one byte of the first file and expects the build to refuse                                                                                                                                                                                                                                            |
| Works on the real Rust server from another device  | Live test starts the real server over https on a network address that is not loopback, with certificate checking and a trusted-origin list. An untrusted origin was refused (403) and signed-out calls got 401. Two people signed in, saved, paged, changed and set the choice. The test data never reached the server log |

Commands (expected exit code 0, both through `scripts/run-gate.sh`):

```bash
scripts/run-gate.sh start --gate test:rust-wellness
scripts/run-gate.sh start --gate test:rust-wellness-live
```

### Not proven or not built

- **The old energy-trend note is not written.** The old server wrote a fact about recent energy
  into chat memory when a check-in was saved or its energy changed, and removed it when assistant
  access was turned off. This package does not, so the earlier plan line that no Wellness data
  reaches a model is true here but differs from the old code. Part 16 must decide whether to bring
  it back.
- **Activity rows were not exercised.** The activity record only covers calls to service ports,
  and this package makes none, so it is empty. The check that it holds no note cannot fail today,
  and no guard-removal run was possible for it.
- **Part 12 fixtures were not used.** The tests plant one marker of their own. The shared fixture
  files are for the later medicine and insight parts.
- **Medicines, dose logs, therapy notes, insights, export, chat tools, reminders and the screens**
  are parts 14 to 18. The package's database files create those tables, but no route reaches them.
- **Queues.** No reminder or export queue is declared yet.
- **The old non-UUID id on a change call** is passed to the database and answers 500. The old
  server's answer for that input was not compared.
- **Odd inputs** (null or zero ratings, text for numbers, odd date strings) are compared only for
  the cases in the 29 steps. Other odd inputs follow the same hand-written rules but were not
  all compared.
- **The date window parser** accepts full timestamps and plain dates only. The old server accepted
  a few more date spellings.
- **No screens, so no click-through proof.** The live run used the routes only.
- **The shared local-date lookup gained one extra field** (the minutes offset from UTC). The
  existing account contracts test only reads other fields, and has no gate script of its own to
  run here, so it was not rerun. The Wellness gates use the new field against a real database.
- **Two other gates fail on main for unrelated reasons.** The weather preferences gate and the
  briefings gate fail before and after this change.

## Wellness package: medicines and dose logs (part 14)

Task JS-297. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A. No Vikunja card exists for this task, so there is no card line.

### What was built

The Wellness package now serves the medicine routes. There are 11 routes in all: add, list, read,
change and remove a medicine, set up its schedule, read a day's doses, log a dose, and read the
30-day adherence summary.

- **Same schedule rules.** All eight schedule kinds work as in the old code, including the old
  plain-calendar model, the one-minute match between a dose and its log, and the old way of
  reading odd input (empty values, single values in place of lists, unknown fields dropped).
- **Time zones.** Two kinds (every interval, monthly) use the medicine's own time zone. This needs
  the `chrono-tz` crate. It is the one flagged addition to the approved list, and it was decided
  before this part.
- **Counts for Briefings.** A counts-only function gives scheduled, taken, skipped, as-needed and
  the adherence rate. It holds no medicine names, and it needs the person's assistant-access choice
  to be on.
- **Reminder queue.** The manifest declares the queue. No worker runs it, as in the old code.
- **App map.** The manifest lists the two new features, with plain error descriptions.

### Differences from the old code (on purpose)

Three inputs now answer 400 where the old server answered 500: a date that does not exist when
reading a day's doses, a dose time that cannot be read, and a clock time that is not a real time
in the schedule times. All three are listed in the package changelog.

### Proof

| Claim                                             | Evidence                                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes match the old handlers                     | The old routes and the new package ran side by side on one test database. 25 create and list steps and 47 schedule, dose, summary and change steps match. A control run with protection removed was seen failing                    |
| A second person cannot read or change medicines   | Real database test as two people through the installed package, seen failing with the owner rule removed                                                                                                                            |
| Private text stays out of logs, jobs, activity    | Guest tests plus installed tests show medicine text only reaches the two medicine tables. A database failure never echoes it                                                                                                        |
| Counts hold no medicine list                      | A native test reads the output and finds counts only                                                                                                                                                                                |
| Native and WebAssembly builds                     | Native guest tests (13 behaviour, privacy) and the same code as a WebAssembly component in the package tests                                                                                                                        |
| Works on the real Rust server from another device | Live test on the real server over https on a non-loopback address, with certificate checking. It now covers the medicine routes. Gate exit code 0 on the branch before it was moved onto the newest main; not rerun after that move |

Commands (expected exit code 0, both through `scripts/run-gate.sh`):

```bash
scripts/run-gate.sh start --gate test:rust-wellness
scripts/run-gate.sh start --gate test:rust-wellness-live
```

### Not proven or not built

- **Golden 30-day counts.** The fixture checks for every-n-hours, every-interval and monthly were
  not added. The old-route comparison covers those kinds, but not at a fixed clock.
- **Briefings reading.** Briefings is shown to get counts only by a guest test and the manifest, not
  by a run of Briefings itself.
- **Daylight-saving cases** are covered by the comparison only, not by their own guest tests.
- **Chat tools** for medicines are part 16. Therapy notes, insights, export and the screens are
  later parts. No worker runs the reminder queue.
- **No screens, so no click-through proof.**

## Commitments package skeleton (part 7)

### What was built

- A Commitments package under `modules/commitments`. Its tables and saved data stay exactly as
  they were, because the old SQL files are used byte for byte (ledger "core-legacy"). It owns five
  tables and asks the host for two of them, plus the clock.
- Five routes: list suggestions (with a status filter), open one with its saved evidence, change
  its status, mark it as not owed (suppress), and resolve.
- The app map entries (feature descriptions and their errors) are in the manifest. No screens.
- Resolving is refused with "unavailable" and saves nothing. The old server does the same for
  every request, because no checker is ever connected to it.

### Differences from the old code (on purpose)

- A status change on a missing suggestion answers "Candidate not found" (404), and a malformed
  id answers 400. The old code answered with a server error for both.
- A malformed id now answers 400 on read and on resolve (the old resolve answered 503 without
  looking at the id). A suppress that names a malformed driving id answers 404 "Suppressor not
  found". The old code answered 500 for the read and suppress cases. None of these is replayed
  against the old routes.
- Marking a suggestion as not owed never saved which suggestion drove it, in the old code or here.

### Proof

| Claim                                    | Evidence                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route parity                             | 18 steps replayed against the old routes on the same database (list, filter, bad filter, read, status changes and refusals, resolve, suppress cases); answers match, ids and times masked                                 |
| A resolved suggestion stays resolved     | A suggestion with a saved resolution keeps it, as a database read confirms, through a status change and a suppress; the answer says it is resolved without exposing the reference                                         |
| A second person sees and changes nothing | Routes and direct database reads return nothing for them. With the owner rule removed they read all three rows (test fails the protection); with the rule restored, none                                                  |
| Private text stays private               | The marker title reaches no job row, no activity row and no second-person answer, and not the server log in the live run. A leak planted in the code was not tried                                                        |
| Native and WebAssembly builds            | 8 native tests; the same code as a component passes 6 package tests and 2 installed-package tests in the real host                                                                                                        |
| Live run                                 | Real Rust server over HTTPS, package installed from a signed test registry: signed out gets 401; owner lists, filters, reads, changes status and suppresses; resolve gets 503; the other person gets empty lists and 404s |

Commands, all through `scripts/run-gate.sh` (expected exit code 0):

```bash
scripts/run-gate.sh start --gate test:rust-commitments
scripts/run-gate.sh start --gate test:rust-commitments-live
```

### Not proven or not built

- **Expired snoozes are not replayed against the old routes.** The "pending review" and
  "snoozed" filters treat a past snooze as pending review, checked only in native tests. The new
  code reads the host clock where the old code used the database clock.
- **No way to create suggestions.** Finding them in email and chat (extraction, its start route
  and its state route) is part 8. The tests and the live run put rows in the table directly.
- **Resolve does nothing.** The real checker that confirms a linked task or draft exists is not
  built, in the old code or here.
- **No chat tools, background jobs, heartbeat, account export or delete, and no screen.**
- **No leak-planted check for private text.** The privacy test passes, but it was not seen failing
  with a leak added.
- **Other devices.** The live run was on the same machine.

## Wellness package: therapy notes, export and account sections (part 15)

Card JS-300. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

Eight more routes in the Wellness package, plus two calls the whole-account export and delete will
use. No screens.

- **Therapy notes.** List newest first, save one (optionally linked to one of your own check-ins and
  tagged with a feeling), and delete one. Wording of every refusal matches the old server, except
  one case listed below.
- **Selective export.** Ask for a date range and categories, check progress, download. The file is
  built by a background job that carries only the export id. It is kept 24 hours, then reads as
  gone (410), and its record is dropped after seven more days. A repeat request for the same range
  reuses the same job, and a different one while a job runs gets the old 409 wording. A job stuck
  for 15 minutes counts as failed. A failed build says so in fixed words and never echoes text.
- **Only chosen categories.** An unchosen category is left out of the file entirely.
- **Account sections.** One call returns the caller's check-ins and therapy notes for the account
  export. One deletes the caller's check-ins, therapy notes, medicines and dose logs and the
  saved export records and files. Both act on the caller only.
- **Same data.** No new database file. The four tables and their owner-only rules are the old ones.
- **App map.** The manifest lists the three features with plain error descriptions.

### Differences from the old code (on purpose)

- **Download is a JSON envelope** with the file name, type and page text, because a package route
  can only send JSON. The shell or screen turns it into a file.
- **Medicines and insights export** answer 400 "not available yet" until parts 14 and 16.
- **Owner name in the file** is the account id, because the package cannot read the users table.
- **Export records live in per-person package storage**, not the old export table.
- **A therapy note linked to a non-UUID id** answers 404. The old server answers 500.
- **A range with 1000 or more rows in one category** is refused with the "too large" message, because
  the host returns at most 1000 rows per query.

### Proof

| Claim                                          | Evidence                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routes match the old handlers                  | Old routes and the package run side by side, ids and times masked. 36 steps without ids and 7 with ids match, covering therapy notes (good and bad bodies, missing ids) and export validation (dates, range, categories) |
| A second person cannot read or delete notes    | Real database test as two people. With the owner rule opened the second person read the note, with it restored they read none. The second person also gets 404 on delete                                                 |
| Marker never reaches prompt, log or other file | Note text is absent from every queue and log table, the activity record, the real server log and the unchosen export. A guest test checks the job payload holds only the export id                                       |
| Expired export reads as gone                   | Guest test moves the clock. 23:59:59.999 after completion still downloads, 24 hours exactly gives 410, and the stored file is deleted. Seen failing with the expiry check removed                                        |
| Unselected categories absent                   | Guest and real-host tests ask for one category and look for the other's marker and heading. Seen failing with the selection check removed                                                                                |
| Account sections cover only the caller         | Real host test calls both sections as two people. The second person's rows stay                                                                                                                                          |
| Native and WebAssembly                         | Guest tests run natively (6 behaviour, 2 privacy, 16 new). The same code is built as a component and loaded by the real host (6 package tests, 3 installed tests)                                                        |
| Real server, other device, two people          | Live test over https on a non-loopback address with certificate checking and trusted origins. Notes and an export worked for two people, the second got 404, and the server log held no marker                           |

Commands (expected exit code 0, both through `scripts/run-gate.sh`):

```bash
scripts/run-gate.sh start --gate test:rust-wellness
scripts/run-gate.sh start --gate test:rust-wellness-live
```

### Not proven or not built

- **Real-host expiry.** Expiry was proven by moving the clock in the guest tests only. The real
  host run does not wait 24 hours.
- **Whole-account orchestration** is not built. Only the two section calls exist.
- **Two requests at once** can race, because package storage replaces the whole value on each
  write. The 409 rule is exact only for one request at a time.
- **Old export table rows** are not read, so exports made by the old server are not downloadable.
- **Old status and download routes** were not replayed, because they live in the old settings
  routes. Their wording was read from source.
- **The old export request** was replayed with a stand-in queue, so only its answers were compared.
- **Medicines and insights export** answer "not available yet". Chat tools and screens are part 16 and later.
- **Delete during a build.** An export being built while the person deletes their account data can save one page after the delete. It can never be downloaded, and the next delete removes it.
- **Many exports in a day.** All pages of one person share one stored value, so many exports inside 24 hours grow it. One at a time and the 24 hour expiry bound it.
- **Note list size.** The therapy note list relies on the host's own row cap and has no warning when it is reached.
- **The old energy-trend note** is still not written (see part 13).
- **Shared Rust toolchain folders.** Builds used the existing shared cargo and rustup folders
  unchanged, because offline builds need their cached crates. Only the build output folder was
  task-owned, and it is deleted when the task ends.

## Commitments extraction (part 8)

### What was built

- Finding suggestions in text. A quick word check drops text that cannot hold a promise. What is
  left goes to the person's configured model, and every answer is checked before it is kept. The
  model only proposes. Each suggestion starts as "pending review" and reaches no task list until
  the person accepts it.
- Email judging. One job reads a mail thread and decides whether it holds something the person
  owes. A thread is judged once per burst of new mail, after a three minute wait. A repeat request inside the same three minutes folds into the first, and the next window can queue again. A thread whose
  last message is from the person is not sent to the model, and a suggestion the person rejected
  stays rejected.
- Two routes: start an extraction, and read the saved extraction state. Starting one answers 202
  and queues a job.
- Seven chat tools: the heartbeat source, list, thread judgements, open one, and accept, reject
  and snooze. The last three need a current approval version, so a stale view of a suggestion
  cannot change it.
- A heartbeat source that lists accepted commitments due soon or overdue, with a revision that
  changes when the list changes.
- Two things offered to other packages: request a thread judgement, and prepare a chat action.
- The app map entries are in the manifest. No screens, no new tables, no new migration.

### Differences from the old code (on purpose)

- Job requests carry a source kind or a message id and nothing else. The old payload carried the
  person and a request key. The host now adds the person, and the request key is a stable id
  made from the person and the source.
- The guest has no log port, so warnings (for example an unreadable model answer) come back as
  the job result. They name the problem and never include text.
- The check that drops sign-in codes is a simple word check, and lengths count characters rather
  than UTF-16 units.

### Proof

| Claim                                                  | Evidence                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A canned model run                                     | Native tests with a canned model: a note becomes one pending suggestion with its evidence, text that fails the word check never reaches the model, and an unreadable answer gives a warning with no text. Run with a fake host, not the real one |
| A proposal reaches no task list before it is confirmed | New suggestions are saved as pending review. Accept, reject and snooze fail without the current approval version, and pass with it                                                                                                               |
| Job requests carry ids only                            | The queued row holds only the source kind, even when the request body includes text; asking twice queues one job. The live run checks the queue rows after a request that carried a planted marker                                               |
| A second person sees nothing                           | Extraction state and thread judgements return nothing for them. With each owner rule removed they read the row (the check fails); with the rule restored, none                                                                                   |
| Private text stays private                             | The marker reaches no job row and not the server log in the live run. Warnings carry no text                                                                                                                                                     |
| Route parity                                           | 24 steps replayed against the old routes on the same database, including the new start and state routes with a valid, an invalid and an empty request; answers match                                                                             |
| Native and WebAssembly builds                          | 28 native tests; the same code as a component passes 6 package tests (including the queue parameter checks) and 3 installed-package tests in the real host                                                                                       |
| Live run, reachable from another device                | Real Rust server over HTTPS on this machine's network address, not loopback, with certificate checking. An untrusted origin gets 403, signed out gets 401, start gets 202, an invalid source gets 400, the other person's state is empty         |

Commands, all through `scripts/run-gate.sh` (expected exit code 0). The task used its own build
folder, builds ran offline against the shared package cache, and nothing was installed globally.

```bash
scripts/run-gate.sh start --gate test:rust-commitments
scripts/run-gate.sh start --gate test:rust-commitments-live
```

### Not proven or not built

- **The canned model run is not through the installed host.** The installed test world has only
  Commitments in it, so no model or text source exists there. The run uses a fake host.
- **Email does not ask for judgements yet.** The judging job and the request are built and
  tested, but nothing in Email calls the request.
- **Chat and notes have no text provider.** Extraction for those sources warns "source provider
  missing" and stops.
- **Nothing starts extraction or judging by itself.** There is no schedule, Email does not call the
  request, and the app map says so.
- **Judgement skips calendar and notes context**, and the "sender was ruled not an obligation"
  rule is not built.
- **No "no model configured" message.** A missing model shows as a generic warning.
- **Chat sources ignore the person's time zone.**
- **No leak-planted check on the job payload.** The privacy tests pass, but a leak was not added
  to the code to watch them fail.
- **The live run never ran a job.** It showed the job queued, not the worker finishing it, because
  no model or text source exists on that server.

## Finance platform probe (part 19)

### Answer to plan section 5.3

The module host can hold Plaid's keys and bank tokens itself, so Finance does not need the
`credentials.read` exception. Four gaps stopped the old broker from doing Plaid. Each got a
small, general extension, and no package ever sees a key or a bank token.

| Gap in the old broker                                    | Extension                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Plaid wants its keys in the body of every call           | A credential can attach named fields to the body; the host sets them last |
| The bank token swap sends a one-time public token        | A new token swap kind sends companion keys plus that one input field      |
| Finance keeps one token per bank, the broker kept one    | Optional per-bank slots, with a forget operation                          |
| Replies carrying `link_token` or `public_token` were cut | A credential may list reply fields that stay visible by design            |

A failed swap returns `connected: false` and only Plaid's upper-case error code. Nothing is
stored and earlier banks are untouched.

### What was built

- Broker changes in the module host (manifest, credentials, runtime).
- A fake Plaid for tests that copies Plaid's rules: keys in every body, a public token works
  once, a bank token works only for its own bank, Plaid's error codes, every call recorded.
- Five host tests and four fake-Plaid contract tests.

### Proof

| Check                                                                                  | Result                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bank link through the real component host and encrypted store (`plaid_probe`, 5 tests) | passed                                                                                                                                                                                                                                                                                                                     |
| Fake Plaid contract tests (`standins/tests/plaid.rs`, 4 tests)                         | passed                                                                                                                                                                                                                                                                                                                     |
| Whole module host native suite                                                         | passed                                                                                                                                                                                                                                                                                                                     |
| Planted client id, secret and bank token searched in replies and on disk               | never found                                                                                                                                                                                                                                                                                                                |
| Remove the name-based reply stripping                                                  | leak test failed, restored                                                                                                                                                                                                                                                                                                 |
| Remove per-person separation                                                           | second-person test failed, restored                                                                                                                                                                                                                                                                                        |
| Let the module's own fields win over the host's                                        | override test failed, restored                                                                                                                                                                                                                                                                                             |
| Live run: real server, real Plaid host, marker keys                                    | passed: Plaid answered INVALID_FIELD, the package saw only that code; signed out got 401; second person saw no bank (trivially, since nobody linked one; person-to-person separation is proven against the fake Plaid only); key scan of log, tables, data folder and package found nothing, and a planted leak was caught |
| Old broker shapes against the fake Plaid                                               | refused with INVALID_API_KEYS                                                                                                                                                                                                                                                                                              |

Commands, from `rust-spike`:

```
cargo +1.95.0 test --locked --offline --manifest-path module-host/Cargo.toml --test plaid_probe
```

```
cargo +1.95.0 test --locked --offline --manifest-path standins/Cargo.toml --test plaid
```

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-plaid-live
```

### Not proven or not built

- **WebAssembly.** The host and the fake Plaid are native test code. The host tests run a real
  WebAssembly sample, and the live run uses a small probe package built as real WebAssembly.
- **Live run used marker keys, not a real bank.** The real server called the real Plaid host
  and Plaid refused the keys, so the success path was proven only against the fake Plaid.
- **A real Plaid account** is part 36. Real Plaid replies may differ from the fake.
- **Package declarations are checked.** A bank swap must be per person, only link and public
  tokens can be exposed in replies, and a shared credential cannot be forgotten by one person.
  A test tries each and was seen failing with the check removed.
- **Link and public tokens reach the module** on purpose. Only keys and bank tokens are hidden.
- **No App Map entries,** because no screen, setting or route was added.
- **Route parity** does not apply, since no route was added.

## Finance package skeleton (part 20)

### What was built

- The Finance package: manifest with App Map entries, the old ledger kept as a module-legacy
  ledger (42 SQL files, 24 tables), the account list, manual account create and manual entries.
- Six routes and four tools. The old code had no HTTP routes, so the routes exist for the live
  proof and for later screens. Tools and routes share one code path.
- Old rules kept: operation id must be a UUID v4 and is stored as `manual:<uuid>`, 12 currencies,
  6 account types and their stored kinds, no future dates, trimmed names, note and amount limits,
  the ordered-JSON digest, the balance direction per account type, and the old result codes.
- Host change 1: legacy-ledger tables get owner-only row-level security and grants at install,
  because the old SQL has none. Tables that already have policies are left alone.
- Host change 2: a typed insert may name a column called `actor` (the old activity table has
  one). Only column names inside `values` are exempt. Identity keys anywhere else, or nested in
  a value, are still refused. One host unit test covers it.

### Proof

| Check                                                                                     | Result                                                                                                            |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Native guest tests (`finance.rs` 18, `privacy.rs` 4)                                      | passed                                                                                                            |
| Package tests (6) and the real component built as WebAssembly                             | passed, component loads in the real host                                                                          |
| Installed package, two people plus an admin, row-level security                           | passed; with security removed the admin saw rows and the second person listed A's account (RED), restored (GREEN) |
| Same operation id from two people makes one account each                                  | passed                                                                                                            |
| Chat writes need an exact, one-use approval tied to the account                           | passed                                                                                                            |
| Planted name, note and amounts searched in 14 tables, job payloads and activity rows      | found only in ledger rows                                                                                         |
| Put the amount into the activity row                                                      | host scan failed, restored                                                                                        |
| Let a host failure echo its text                                                          | guest test failed, restored                                                                                       |
| Live run: real server, real HTTPS on a non-loopback address, untrusted origin, signed out | passed: 403 for untrusted origin, 401 signed out, account and entry worked, second person saw none                |
| Moss reachable from another device                                                        | passed, same live run                                                                                             |

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-finance
```

```
scripts/run-gate.sh start --gate test:rust-finance-live
```

### Deliberate differences from the old code

- Activity rows hold ids only. The old rows could hold more.
- Refusals come back as `{"status":"error","code","message"}` data from tools and as HTTP 4xx
  from routes.
- The category list is the 16 seeded defaults, or the saved list once the budget policy says
  categories are ready. The old key-value fallback is not built.
- Two writers on one account use a revision check, not a row lock. The loser rereads once, so
  a repeated operation answers unchanged. A second loss fails the call with no balance change.
- The account list sorts by account id in the database, so mixed manual and bank ids may order
  differently from the old list.
- A missing time zone and an unavailable old storage upgrade show as a generic tool failure, not
  the old named errors.

### Not proven or not built

- **Parity against the running old code.** The old Finance had no routes. Rules, codes and
  digests are checked by table-driven cases copied from the old handlers, and the digest was
  checked equal to node's earlier. The old handlers were not run side by side.
- **Shared accounts.** The shared-accounts mirror is not built, so the list shows own accounts.
- **Bank link, sync, budgets, screens** belong to later parts.
- **The wasm run is the packaged component loaded by the installed and live tests.** The guest
  unit tests themselves run native only.
- **Rollback after a late failure** is not shown by a test. The host rolls the whole call back,
  but no test forces a failure after the balance moves.
- **The privacy scan reads database tables and the server log,** not the chat approval record.
- **The two negative controls** cover the leak routes that were wired. Other fields were not
  each given a control.

## Meals package, kitchen and household (part 28)

### What existed before this part

Nothing for Meals existed before this part. Part 19 only built the bank token exchange through
the host, so nothing was reused.

### What was built

- **The Meals package.** A manifest, a changelog, an icon, and a WebAssembly guest that
  serves the kitchen and household tools. The package carries all 27 old SQL files untouched,
  so all 20 Meals tables exist after install. A changed byte in any file stops the build.
- **Four tools.** Read the kitchen, save the kitchen, save a household member, remove a
  household member. They use the same wording for bad input as the old tools. The
  guest never writes SQL. It asks the host for typed queries on four tables.
- **The first read never writes.** A new person sees a default kitchen with their own "You"
  member. The same ids are stored on the first save.
- **App map entries** for the tools are in the manifest.
- **No host change.** Meals tables are in the host's frozen list of old tables, so the host
  already gives them the owner-only rules and runs queries as the shared app role.
- **Nothing more.** Plans, recipes, lists, pantry and log tools are later parts.

### Differences from the old code (on purpose)

- Old Meals had no web routes. The new package has one route, used by chat to run a tool.
  Every write goes through the host's one-use approval, which the old tools did not need.
- The guest hand-writes MD5 so the default kitchen ids match the database's own. No new
  crate was added.

### Proof

Native tests for the guest (13 pass) and WebAssembly package tests against the real host (6
pass), then the database tests through the gate, which finished with exit code 0. This part changes no host code.

- **Tool parity.** 15 steps run on the old handlers and on the installed package, with ids and
  times masked. Every reply matched, including the bad-input replies.
- **Two people.** A second person and an admin cannot read, change or remove the first
  person's kitchen or household. The check was seen failing with the generated privacy rule
  removed from each table, then passing when it was put back.
- **Private text.** A planted household name never reached stored jobs, host activity or the
  live server log.
- **Two protections removed.** The fixed error text and the activity record were each removed
  and the matching test failed.
- **Live run.** The real Rust server, over HTTPS on a real network address, installed the
  package and ran the tools. It finished with exit code 0, including a refused untrusted origin,
  a refused second person and no marker text in the activity record or server log.

Commands, from the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-meals
```

```
scripts/run-gate.sh start --gate test:rust-meals-live
```

Both are expected to finish with exit code 0.

### Not proven or not built

- **No screens.** None were asked for.
- **Only four tools of the old set.** The rest come in later parts.
- **The second person in the live run** is only shown being refused. The strong isolation
  proof is the database test.
- **Route parity** applies only in that old Meals had no routes. There is nothing to compare.
- **Release note** is not applicable.

## Meals planning (part 29)

### What existed before this part

Part 28 gave Meals a package with the kitchen and household tools. Nothing for plans or
recipes existed in Rust.

### What was built

- **Planning rules.** Date handling, the day and meal skeleton, portion sizes, the calorie band
  and the recipe title key, ported from the old planning code.
- **The safety rule.** The allergy and dietary check, the merge of the rule result with the
  model's own safety answer, and the brand-name rule.
- **Recipe answers read strictly.** The recipe and safety answers from the model are parsed
  with fixed error text, and the prompts that ask for them are built in Rust.
- **Pantry name matching.** Matching an ingredient to a pantry item by name, and finding
  ingredients that are not in the pantry.
- **The recipe drafting loop.** Draft, check safety, retry with the problem named, and give up
  after a fixed number of tries. It runs against a stand-in model.
- **Plan storage.** Plans, days, meals, eaters and recipes are read and written through the
  host's typed queries. There are no transactions, so a repeated create with the same key
  finishes a half-written plan, and day and meal changes use compare-and-set updates.
- **Four plan tools.** Create, get, current and control (stop, resume, retry a day,
  regenerate). Writes cross the host's one-use approval.
- **The plan-day job.** Writes one day at a time through the drafting loop, reads the pantry
  when the plan uses it, and chains the next pending day. A failed enqueue pauses the plan.
- **Manifest, app map and changelog** carry the new tools, the job queue and the model and
  jobs ports.
- **Calories per serving stay empty.** The estimator is part 31. Pantry quantity maths is
  part 30.

### Proof

- 23 native tests pass for the guest. The drafting loop is proven with a canned model
  (clean draft, retry after a safety failure, retry after a malformed answer, giving up,
  brand-name rejection).
- The package gate passes: native tests, the WebAssembly build, package tests and the
  installed-package tests.
- One installed test proves plans are owner-only (a second person and the admin see nothing
  and cannot stop a plan), that removing the owner rule on the plan and day tables makes the
  second person see rows (so the check can fail), that the same key gives one plan, and that
  a planted private marker is in no job payload and no activity row.

### Not proven or not built

- **Tools not built.** Meal edit, swap, servings and favourites edit, plan delete, meal get,
  meal cooked, meal rate, day edit and re-plan are not built. Control rejects re-plan.
- **The job has no native or installed test.** Only the drafting loop it calls is tested,
  with a canned model. The store and plan code have no native unit tests of their own.
- **No route parity run against the old handlers** for the plan tools, and no live run on the
  real Rust server.
- **Live model run.** The model dependency (JS-307) is not merged, so nothing has run against
  a real model.
- **Known gaps from review, not fixed.** A day or meal left in the writing state by a killed
  job is never claimed again. A repeat create with the same key returns the plan as it is and
  does not finish a half-written one (the store comment overstates this). A failed first
  enqueue pauses the plan without telling the caller. Regenerate leaves the old recipe rows
  behind. A regenerate across several days queues only the first day.
- **Ratings vetoes** are not applied when drafting.
- **Enqueue limits** are approximated. The host has no "limited" answer, so a failed enqueue
  pauses the plan.
- **Numeric columns** may come back as numbers or text from the host. The store accepts both.
- **No tracking card** for JS-308 was found in Vikunja.
- **Release note** is not applicable.

## Meals lists and pantry (part 30)

### What existed before this part

Parts 28 and 29 gave Meals a package with the kitchen, household and plan tools and the
plan-day job. There was no shopping list and no pantry in Rust. The pantry was read by the
planner but could not be edited.

### What was built

- **Unit maths.** Unit names, conversion between compatible units, and the rounding and
  display rules, ported from the old code.
- **List build and reconcile rules.** A list is built from the ingredients of the plan's meals,
  merged by name and unit, with pantry coverage marked. Reconcile keeps manual lines, keeps
  ticked lines, keeps bought lines, and only adds or removes what the plan changed.
- **Pantry coverage.** A line is covered when the pantry or the staples already hold it.
- **Five list tools.** Get, build, edit (add, update, remove, tick, untick), bought and clear.
- **Two pantry tools.** Get and edit, for stock items and for staples (add, update, remove).
- **Hooks.** The plan-day job rebuilds the list after it finishes a day. A pantry edit
  re-checks coverage on the list.
- **Mark bought.** Moves each bought line into the pantry once, even when repeated.
- **Undo records.** Removing a line or a pantry item and marking lines bought each write an
  undo record before or after the change, as the old code did.
- **Manifest, app map and changelog** carry the seven new tools, the three new table grants
  and two chat features.

### Differences from the old code (on purpose)

- There are no database transactions in the host. Marking lines bought runs in a fixed order
  (pantry rows, then the lines, then the undo record). The pantry rows get fixed ids built
  from the line and its last-change time, so a repeat after a crash finishes the work and adds
  no second row, unless a tick, untick or rebuild changed that line in between. A repeat after
  full success is refused with the old "no shopping list line" message. A crash after the lines change loses only the undo record.
- Sorting names uses a simple locale-style comparison. It matches the old order for plain
  Latin names and may differ for rare accents.
- Bought lines older than one day are deleted when the list is rebuilt after a plan or pantry
  change, using the host clock. Reading the list does not sweep. The old code did the same.
- A bought call that names the same line twice adds one pantry row. The old code added two.
- Tick or untick with an empty line list gives "lineId is required" instead of the old
  "lineIds must hold 1 to 100 line ids".
- Staples have no changed-at column, so a rename writes the name directly.

### Proof

- Native guest tests pass: 33 unit tests, 8 list and pantry tests (empty read writes nothing,
  manual line life cycle with undo, the old error messages, build from a plan with labels
  such as "Mon dinner", bought once with undo, clear touches only the lines, pantry and
  staple rules, a second person sees nothing), and the privacy test with the new tools.
- The package gate passes: native tests, the WebAssembly build, package tests (6) and the
  installed-package tests (5), all in one run.
- Route parity against the old handlers: a 44-step script runs the old handlers and the new
  package on the same fixtures and compares answers, with ids and timestamps masked.
- Row-level security: a second person sees and changes nothing in the five new tables, and
  removing the owner rule on each table makes the check fail, then it passes after restore.
- Clearing a list changed only that list's lines. A digest of every other table, including
  the second person's rows, is the same before and after.
- A planted private word is in no job row and no activity row, and the privacy control that
  plants it in a host call is seen failing.

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-meals
```

```
scripts/run-gate.sh start --gate test:rust-meals-live
```

The live run passed on the real Rust server over real HTTPS on a non-loopback address, with no response rewriting and certificate checks on. It added a list and a pantry item, read them back, marked the line bought, cleared the list, and showed the pantry kept the item. A second person was refused (403) on clearing, and the list stayed. The private word was absent from activity and the server log. The same run showed an untrusted origin refused, which covers reaching Moss from another device.

The first run of the package gate failed at once because the worktree had no installed web
packages, and the second failed because the private Rust folder lacked the WebAssembly
target. Neither was a code fault.

### Not proven or not built

- **Undo restore** is not built. The undo records are written but nothing reads them back,
  and the tool descriptions now say so.
- **Concurrent bought calls** may add a pantry row for a line another call already marked.
- **No screens** were built.
- **Plan delete hook** does not apply, because no plan delete tool exists. The hook runs
  only after the day job.
- **Name order** is an approximation, see above.
- **Crash window** in mark bought is described above and was reasoned through, not forced.
- **No tracking card** for JS-310 was found in Vikunja after three searches.
- **Release note** is not applicable.

## Meals food log and estimates (part 31)

### What existed before this part

Parts 28 to 30 gave Meals the kitchen, household, plans, lists and pantry. There was no food
log in Rust and no estimate job.

### What was built

- **Six log tools.** List, summarize, add, re-estimate, correct and delete.
- **Estimate job.** Adding an entry queues one job that asks the model for the foods in the
  meal and a figure for each nutrient. The answer is checked against a fixed schema first.
- **Estimate states.** Waiting, needs details, estimated and failed. An entry shows as waiting,
  with no figures, until the model answers.
- **Unknown is not zero.** A figure the model did not give stays empty. Totals add up only the
  foods that know that figure. A figure outside its ceiling is dropped as unknown.
- **Times.** An entry keeps its calendar day and zone offset from the day it was made. A local
  time is read in the person's zone and refused when a clock change skipped or repeated it.
- **Manifest and changelog** carry the six tools, the three log tables, the job, the chat
  feature and the longer model call limit (30 seconds). The app map comes from the manifest.

### Differences from the old code (on purpose)

- The job queue key is built from the entry, its revision and its last-change time, so a retry
  after a failure gets a fresh key. The old key was one fixed text per revision. The job
  parameters are named `entry-id` and `revision`; the old code used `entryId` and `revision`.
- There are no database transactions. Writes compare the revision first, then add rows by fixed
  id. A crash between the two leaves a waiting entry that a re-estimate recovers.
- If the queue refuses the job, the entry is marked failed at once. The old code left it waiting.
- A delete or other tool call with an id that is not a valid id gets the plain "no log entry"
  refusal. The old code leaked a raw database error.
- A local time inside a clock-change gap or repeat is refused. The old code guessed.

### Proof

- Native guest tests pass: 44 unit tests and 22 log tests, with model answers checked against
  the schema, unknown staying empty, bad answers failing, model down then retry, stale
  revisions, queue down, clock-change refusal, and two people kept apart.
- Real database: the new tools match the old handlers step for step (31 steps including the
  estimate job), a second person sees and changes nothing in the three tables with the owner
  rule seen failing when removed, and a planted word is in no job row or activity row.
- The sum of an entry's foods equals the stored total, and unknown stays empty in the table.
- Live run on the real server over real HTTPS: a real model (gpt-5.6-luna through the local
  proxy) estimated a real entry in 12 seconds. The entry showed as waiting with no figures
  first, then as an estimate of 294 kcal. The model key is not in the server log and the second
  person sees no entry. The manifest asks for the 30 second call limit.

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-meals
```

```
scripts/run-gate.sh start --gate test:rust-meals-live
```

Both ended with exit code 0. Earlier runs failed for test faults, none in the module: no
installed web packages, the Rust tools not on the path, two log tests taking each other's
queued jobs, a comparison test that ran only the last job, and a live run where the proxy's
Claude sign-in had expired.

### Not proven or not built

- **Voice and photo capture** only record the capture kind. Nothing reads audio or images.
- **The default clock time for a meal type** is tested natively only, because the old-code
  comparison would depend on the real clock.
- **No screens** were built.
- **Release note** is not applicable.

## Finance transactions (part 22)

### What was built

- Transactions: month query with filters, search, notes and splits; set a category; confirm what Moss sorted; bulk categorize and bulk confirm; save and read a note; split across up to 20 categories.
- Payee rules: set a rule, list, preview what a rule would change, turn rules on or off.
- Categories: add or rename inside a group.
- Sorting: rule first, then the bank's own category, then an AI guess (the AI step is a stand-in, see below). The tiers are the old ones. A rule always confirms. A guess under 0.6 confidence needs a look. Otherwise a known payee follows the "sorting" tier (trusted by default) and a new payee follows "sorting_new" (asks each time by default). Only the trusted tier confirms without asking. The tiers are read live from the host's action policy and fall back to those defaults.
- CSV import: parse, preview with duplicate choices, and apply. Caps stay at 1 MiB, 200 rows, 500 KiB per row, 50 columns. `csv` 1.4.0 is pinned (`=1.4.0`), the one approved new crate.
- Routes (module-relative, all sign-in): screen routes for each action above, and chat routes under `/finance/chat/...` for the assistant's writes. Every route is declared in the manifest, with tools, risk, features, errors and policy routes. Package version is 0.2.0.

### Proof

| Check                                                                                         | Result                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Native guest tests (25 unit, finance 18, import 5, isolation 4, privacy 6, transactions 14)   | passed                                                                                       |
| Package tests (6) and the real component built as WebAssembly, run against the real host      | passed, including the new table and action-policy grants                                     |
| CSV fixture at both caps (1 MiB, 200 rows) read back from a real file; one step over each cap | passed; both over-cap files refused with the old messages                                    |
| An import saved twice by replay                                                               | stays one set of rows, one balance move, one receipt, one activity row                       |
| Sorting tiers, including the trusted tier that applies without asking                         | passed; a second sort run changes nothing                                                    |
| Two people, guest level: second person reads and writes A's transactions, rules and notes     | nothing seen, nothing changed. With the owner filter switched off the same check fails (RED) |
| Planted payee, note and amount searched in activity rows and every non-database host call     | none found; a planted leak is caught by the same scan (control)                              |
| Live run: real server, real HTTPS on a non-loopback address, no response rewriting            | passed: query, category, note, import, replay stays 3 rows, sorting, second person sees none |
| Stored job rows searched for the planted text in the live run                                 | none found; the same search finds the text in the transactions table (control)               |
| Moss reachable from another device                                                            | passed, same live run (non-loopback address, certificate checked, untrusted origin refused)  |

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-finance
```

```
scripts/run-gate.sh start --gate test:rust-finance-live
```

Both ended with exit code 0. The first run of the package gate failed because a test still expected the imports table to be refused. The test was updated because the table is now granted.

### Deliberate differences from the old code

- The old write version (row id plus the database's hidden change counter) is replaced by a hash of the fields a writer can change. Writes still refuse a stale version.
- The old queue jobs for categorize, review and split run as part of the request, in one database transaction. No job is queued, so no job payload can carry private text.
- A new `/finance/import/parse` route reads the file on the server. The old code parsed in the browser.
- A batch review checks every row before it writes the first, because a chat tool call commits whatever it wrote before a refusal. A chat route now answers with the refusal's status (409, 404 or 400) instead of always 200.
- Bulk categorize writes one activity row with the count. The old code wrote none.
- The CSV reader is the `csv` crate, 1.4.0 pinned, with extra checks for stray quotes. A one-column file with blank lines is refused.
- Letters in payee keys follow Rust's definition of a letter, not the old pattern for Unicode letters. Rare scripts may group differently.

### Not proven or not built

- The AI guess step has a trait and a fake only. The host-backed version is not built, so sorting here never asks a model.
- Archiving a category is not built (it needs budget data from part 23).
- Transactions export and reports, and the shared household mirror, belong to part 25.
- The host stores tiers but does not enforce tool approval by tier. Enforcement is in the sorting code and the one-use approval on chat writes.
- The unreachable error code for an over-long rule payee exists but cannot fire, because the 200-byte cap is hit first.
- Route parity with the old handlers is checked through ported messages, status codes and shapes in the guest tests. The old handlers were not run side by side with the new ones.
- Row-level security for the two new tables (rules, imports) is proven through the live run (second person sees none and cannot write) and the guest-level check. It was not separately re-run in Postgres with the protection removed.
- The stored-job-row search was not seen failing with protection off, because Finance queues no jobs. The control shows the search can find stored text.
- No screens were built.

## Finance budgets (part 23)

### What was built

- Setup: choose the budget currency once (it cannot change afterwards) and say whether old budget data may be left behind. Repeating the same setup changes nothing.
- Status for a month: money left to assign, each category's assigned, spent and available amounts, with unspent money carried forward and overspending taken out of next month's pool. Transfers between a person's own accounts are left out, including a matched pair within three days.
- Assign and move: set what a category gets for a month, move money between categories or from the unassigned pool, and apply up to 20 changes together. Each save carries the review the person was looking at.
- Drafts: build a draft budget from the last three complete months of stored transactions (monthly average, planned amount rounded up to the next five dollars, steady charges grouped as Bills, income as the middle monthly figure). A draft can be read, edited line by line, and started once.
- The assistant's writes use `/finance/chat/budget/...` routes, each needing the host's one-use approval. The screen routes sit under `/finance/budget/...`. Package version is 0.3.0, with the new tables, routes, tools, risk levels, features and errors in the manifest.

### Proof

| Check                                                                                     | Result                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Native guest tests (40 unit, budget 19, plus the older suites)                            | passed                                                                                                                                        |
| Package tests and the real component built as WebAssembly, run against the real host      | passed, including the four new table grants and the refused tables                                                                            |
| Draft figures come from stored records                                                    | passed in the guest tests and against the real database: 30000, 31234 and 32000 became 31078 and 31500                                        |
| An uncertain save saves nothing and says so                                               | a stale review gets a 409 with "Refresh and review"; rows and revision are unchanged. A draft start that fails part way rolls back everything |
| Two people, real database: second person and an admin read and change none of the budget  | passed. With row security switched off the same check fails (RED), and passes with it back on                                                 |
| Private text searched for in job rows, host call logs, activity rows and the queue tables | none found; a planted leak is caught by the same scan, and a control that puts amounts into budget activity makes the test fail               |
| Live run: real server, real HTTPS on a non-loopback address, no response rewriting        | passed: setup, assign, a stale review refused (409), a draft from stored rows, chat route refused without approval, second person sees none   |
| Moss reachable from another device                                                        | same live run: non-loopback address, certificate checked, untrusted origin refused, sign-in                                                   |

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-finance
```

```
scripts/run-gate.sh start --gate test:rust-finance-live
```

Both ended with exit code 0. The first package gate run failed twice before it passed: the worktree had no dependencies installed, and then a test module lacked an import. Neither touched product behaviour.

### Deliberate differences from the old code

- The budget-apply queue is gone. Applying changes runs inside the request in one database transaction, so no job payload exists that could carry private content.
- Budget activity rows hold the month and category ids only. They hold no amounts and no undo record, so undoing a budget change is not built.
- The review check is a policy revision plus a fingerprint of the budget columns, computed by the module. A save runs one conditional update on the revision and refuses on zero rows.
- A chat route answers with the refusal's own status (409, 404 or 400) instead of always 200.

### Not proven or not built

- A concurrent writer between the module's fingerprint read and the revision update is guarded by the update itself, but that narrow window was not exercised with two real simultaneous writers.
- Flex pools, targets and target funding, card reserves and bills (part 24), shared accounts and reports (part 25), and category archiving are not built.
- Draft build and start do not refuse while flex pools are active, because flex pools do not exist yet.
- Bank balance history written by bank sync (part 21) is not used by the budget yet. Budget figures come from the ledger and the saved balance snapshots only.
- Route parity with the old handlers is checked through ported messages, status codes and shapes in the guest tests. The old handlers were not run side by side with the new ones.
- Review notes left as they are: starting a draft that was discarded after a new setup returns a host error instead of a plain refusal (nothing is saved); a draft edit from the screen is recorded as changed by Moss; a move that is refused has no test showing the stored rows stay unchanged; a refund posted to the income category lowers the pool twice; draft months are counted from all transactions, not only the budget currency.
- No screens were built.
