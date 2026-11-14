# Rust Phase 5: News, Sports and Weather report

Card JS-272. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A. Plan: `2026-11-13-rust-phase5-news-sports-weather-plan.md`.

## Part 1: host public-web fetch mode

### What was built

A package can now read public websites the person adds, through the existing fetch port, without
naming each site in advance. It asks for the resource `public-web`. The install review shows
"Read public websites you add". It builds no screen and no News, Sports or Weather package, and
adds no crate.

- Only HTTPS on the standard port, with no password in the address, and no `localhost` names.
- Every step of a redirect repeats every check (three redirects at most).
- The site name is looked up once. Every answer must be a public address, and the connection is
  pinned to those answers, so a second lookup cannot swap in a private one. Private, loopback,
  home-network, tailnet and 6to4 addresses are refused.
- The site's robots file is read first (longest match wins, an allow beats a disallow of equal
  length, cached 30 minutes). Percent escapes of plain characters are compared decoded, blank lines and comments do not end a group, and a very long disallow stays in force. Matching has a work limit and refuses the read when it runs out. A missing file allows everything. An unreadable or failing file blocks
  the read. Only a subreddit feed address (`/r/<name>/hot.rss`, `new.rss` or `top.rss` on the Reddit host) may skip it, and only when the package asks.
- One call per host per second by default. A wait over 10 seconds is refused as `rate_limited`.
- Caps: 500,000 bytes by default (5 MiB ceiling), 8 seconds by default (20 second ceiling).
- Failure reasons: `blocked`, `robots`, `rate_limited`, `http_error`, `challenge`, `timeout`,
  `network`, `not_https`. Extra detail: `invalid_response`, `response_too_large`,
  `unsupported_content_type`. A failure never carries the response body.
- The per-person activity record names the port, operation and resource name only.
- A package cannot combine `public-web` with the private-address switch, and no other resource
  may use the reserved name.

### Proof

| Claim                                                                                                                | Evidence                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private, loopback, home-network, tailnet, reserved and name-resolves-private are refused and never reach the network | 12 integration tests through a real installed guest; the site log shows no hit                                                                                                                                                                                               |
| Every redirect hop is checked again                                                                                  | test with six private targets plus http and non-standard port                                                                                                                                                                                                                |
| Robots refusal, unreadable file blocks, Reddit-only exception                                                        | three tests                                                                                                                                                                                                                                                                  |
| Every failure reason                                                                                                 | server failure test, size and time test, pacing test                                                                                                                                                                                                                         |
| Each guard fails when removed                                                                                        | `tools/remove-public-web-protections.py`: 12 controls, all failed as expected                                                                                                                                                                                                |
| Second person cannot see the first person's activity, and no request text is recorded                                | activity test, plus two controls                                                                                                                                                                                                                                             |
| Native tests                                                                                                         | 32 library tests, 12 fetch tests, and the boundaries, services, registry, install, frame and lifecycle suites                                                                                                                                                                |
| Live run                                                                                                             | the `test:rust-public-web` gate through verify-gate: real moss-shell, real application, installed package, real internet. example.com read (200, 577 bytes); 10.0.0.5, 127.0.0.1, localhost, 100.64.0.9, [::1], http and port 8443 refused; server answered `/api/hello` 200 |

### Review

Round 1 (Codex) found four major and one minor issue in the robots rules (matching could hold the
host's thread, the Reddit exception covered every Reddit path, percent-encoded paths bypassed
disallows, blank lines dropped later rules, long disallows vanished). All five are fixed with tests.
It found no way to reach a private address and no leak into the activity record.

### Not proven or not built

- `aborted` is not produced. A guest cannot cancel a host call, so there is nothing to abort.
- This part has no database tables. The second-person test covers the per-account activity record.
- The robots cache and the pacing are shared by the whole install, not per person.
- Real-internet behaviour was run against one site (example.com). Redirects to private addresses
  and robots on real sites were proven only against the local fixture.
- The live run reached the guest through the application's install path, not through an HTTP route,
  because a route's input is not a raw port request. The server was started and answered.
- WebAssembly side: the guest in every test is a real component run by the host. No package crate
  was built, because this part has none.
- Moss's app map has no core Rust entry for a permission line. The only user-visible text is the
  install-review wording above, in the manifest code. No screen or setting changed.
- `tokio-rustls` was not added. The fixture site is served with a self-signed certificate that the
  test adds to the trust list.

Card JS-273. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

## Sports package skeleton (part 10)

### What was built

The Sports package keeps each person's followed leagues and teams, and their choice of leagues for
the standings view. It reads and writes the same tables as the old app, so existing rows carry
over. It makes no network calls and shows no screen.

- Follows: list, follow a whole league, choose a team on a followed league, and remove a follow,
  with the same bodies, status codes and messages as the old routes.
- Whole-league follows never repeat. A second follow of the same league returns the first row.
- Standings choices: read and save the chosen leagues (kept in catalog order, an empty list is a
  real choice) and the last standings view the person looked at.
- Follow identity: a saved team follow is matched to the provider's team list by the same rules as
  the old code, so an older follow still finds its team.
- Data export for all six Sports tables and delete-account counts.
- App map entries in the package manifest (follows settings entry, team identity, remembered
  standings, one error code with a remediation).
- The twelve old SQL files stay byte for byte where they were. A test checks them against the
  inventory.
- Changes outside Sports: the host can now read and replace two saved settings for a package
  through fixed bindings, with a shape check before anything is stored. The shell grants Sports
  only those two keys.

### Proof

All checks ran on a throwaway database through the verify gate, against the installed package.

| Claim                                    | Check                                                                                      | Result                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Same answers as the old routes           | 30 steps replayed through the old routes and the installed package, ids and times masked   | Matched                                                                      |
| Whole-league rule from SQL 0186          | Direct SQL insert of a repeat row is refused                                               | Passed                                                                       |
| Clean-up rule from SQL 0185              | Three repeats planted, the real file run, one row left                                     | Passed                                                                       |
| Another person sees nothing              | A second person and an admin list, delete and change A's follow                            | Nothing seen, nothing changed                                                |
| That check can fail                      | Row security removed from the follows table, B reads A's follow; restored, B reads nothing | Seen failing, then passing                                                   |
| Typed text stays out of everything else  | Planted marker typed into every field, 37 tables and job payloads scanned                  | Not found; the guest test also failed first when a leak was added on purpose |
| Export is the owner's only               | A's export holds A's follow and not B's, all five sections present                         | Passed                                                                       |
| Package builds native and as WebAssembly | Guest tests native (29), package tests against the built component (6)                     | Passed                                                                       |
| Works on the real server over HTTPS      | Real server, real login, two people add, change, list, remove follows and set standings    | Passed; each person saw only their own                                       |

### A deliberate fix

The old Standings preferences route answers every bad request with a 500 "Internal Server Error",
because its error reply is declared in a way that cannot carry the message. The new route answers
400 with the message the old code meant to send. This is the only place the new package answers
differently from the old routes.

### Not proven

- Following a team on a live installed package. The team list comes from the sports data provider,
  which needs the network and is part 11. With no list the package refuses a team follow, as the old
  app does during a provider outage. The matching rules are tested with a stand-in list.
- Any screen. The package declares none.
- Reaching the server from a phone or another computer. The package adds no listener. The live run
  used the local secure address only.
- Behaviour with the other five Sports tables beyond export and counts. They are written by later
  parts.
- The old routes reply to a missing follow on the team route with 404, but only once the team is
  accepted. Tested in the guest, not against a live team list.

## Weather saved place and unit (part 20a)

Card JS-275. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

### What was built

The server can now keep a person's saved weather place and unit for a package, and refuses
anything that does not fit. There is no Weather package yet (part 20b), so nobody sees a change.

- A saved place must be a latitude within 90, a longitude within 180 and a name of 1 to 200
  characters that is not blank, with nothing else in it. Length is counted the way the old app
  counted it, so an emoji takes two.
- A unit must be one of two words, metric or imperial.
- Both are stored in the same two saved-setting entries the old Settings routes used, so a place
  saved today is still there after the move.
- A stored value that no longer fits reads as "not set" instead of reaching the package.
- The two grants live in one function that both the server and the tests use, so the tests
  cannot drift from what the server grants. The permission the Weather manifest will carry is
  checked in as a test file, and a test checks that each resource it names has a grant.
- The server grants these two entries to the module named weather and to no other. The package
  cannot pick the entry, the person or the checks.

### Proof

Run through the verify gate on a throwaway database, and with a single check removed at a time.

| Claim                                       | Check                                                                                                                                   | Result                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bad values are refused                      | Latitude 90.5 and -91, longitude 181 and -180.1, 201-character and blank names, an extra field, a missing field, wrong types, bad units | All refused; the stored values did not change          |
| Each check can fail                         | Seven copies of the host, each with one check removed (both limits, name length, blank name, exact fields, unit list, read re-check)    | Each copy failed its own test; the real code passes    |
| One person's write never touches another's  | Two people and an admin write and read; stored rows compared                                                                            | Each saw only their own; the owner's row was unchanged |
| That check can fail                         | Row security removed on the preferences table, then restored                                                                            | Seen failing, then passing                             |
| A value written by TypeScript reads in Rust | The real TypeScript preferences code saved a place and unit; Rust read them                                                             | Same values                                            |
| And the other way                           | Rust saved a new place and unit; the TypeScript code read them                                                                          | Same values                                            |
| Private text stays out of everything else   | A planted place name saved and also sent in refused writes; every table in three schemas scanned and the refusal message read           | Found only in the preference row it was saved to       |
| The server still starts and serves          | Real server over HTTPS with the Sports package, which uses the same port; two people set and read standings choices                     | Passed                                                 |

### Builds

The checks live in the module host, which runs natively and has no WebAssembly build. The tests
reach it through the real WebAssembly guest interface (the sample component), so the path a
package takes is the one exercised. Nothing in this part compiles to WebAssembly.

### App map

No entry changes. The Account screen's weather unit and place wording stays true because the old
routes still serve them. The Weather package declares its entries, and the permission fragment
checked in here, in its manifest in part 20b.

### Not proven

- Server log files. The port writes no log lines and its refusal message holds no input, but the
  test does not capture the server's log output.
- The server's own grant for Weather through a real guest. The tests use the same grant function
  the server uses, but no installed guest reaches it through the server until part 20b.
- A Weather package using these two entries on the real server. None exists until part 20b, so
  the live run used Sports, which shares the same port and the same wiring.
- A phone or another computer reaching the server. This part adds no listener or screen.
- The 6-hour address guess, the forecast and the search routes. Those are part 20b.

## Sports public data from ESPN (part 11)

### What was built

The Sports package now reads ESPN's public sports data. It still shows no screen.

- League catalog: all 64 leagues and tournaments, grouped by confederation, in the old order.
- League clubs: loaded only when a league is opened. Large leagues are read in pages of 100 clubs,
  because one college football page is over the 1 MB size the host allows for a reply.
- Club search across every league: needs two characters, fetches at most five leagues that are not
  stored yet, stops sooner after about two seconds, and says `partial` when it left leagues out.
- Scoreboard, standings and news lists are built and tested but not offered as routes yet.
- A shared store keeps only public data (club lists one day, scoreboards three minutes, standings
  and news ten minutes). A failed ESPN call returns an empty answer marked degraded and stores
  nothing.
- Routes: catalog, a league's clubs, and club search, with the same bodies and messages as the old
  ones.
- The package may fetch only the two ESPN hosts, and asks the host for a larger work allowance.
- App map entries in the package manifest.

### Proof

| Claim                          | Check                                                                                 | Result                            |
| ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------- |
| Same answers as the old code   | Old code run on recorded ESPN pages gave the expected output; 31 route steps compared | Matched                           |
| Search cap holds               | Test counts leagues fetched (exactly five); fails when the cap is six                 | Passed                            |
| Search time limit              | A clock that moves forward on each fetch stops the search after one league            | Passed                            |
| Nothing personal in the store  | Planted text and the person's id searched for in the store and in fetched addresses   | Not found                         |
| Another person sees no follows | Second person against real Postgres, seen failing with row security removed           | Failed without it, passed with it |
| Private text stays out of logs | Existing scan of tables and job payloads                                              | Passed                            |
| Native and WebAssembly builds  | Guest tests native, package tests against the built component                         | Passed                            |
| Works on the real server       | Real server, real ESPN over HTTPS, two people; all four college leagues loaded        | Passed                            |

### Not proven

- Fetch limits for ESPN image hosts. The manifest has no field for them, so they are not enforced.
- College football standings. The page is 2.6 MB, over the reply limit, so it reads as degraded.
- Two searches saving the store at the same moment can lose one update.
- A cold search of the biggest leagues (college football takes about three seconds) could still
  reach the five second call limit if the first league is slow. The time limit makes this unlikely.
- Scoreboard, standings and news have no routes, so they are tested only through the code.
- No Vikunja card was found for this task.
- Any screen.
