# Rust Phase 5: Meals, Finance, Wellness and the rest report

Part of https://github.com/motioneso/moss/issues/4027. This report follows the plan in
`2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. Each part adds its own section
here as it is built.

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
