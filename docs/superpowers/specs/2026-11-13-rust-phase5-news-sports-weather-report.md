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

Cards JS-273 and JS-274. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
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

Card JS-276. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

## News package skeleton (part 3)

### What was built

The News package keeps each person's News choices, excluded publishers, added sources and topics.
It reads and writes the same eight tables as the old app, so existing rows carry over. It makes no
network calls and shows no screen.

- Choices: list, save (a repeat returns the same row) and remove, with the old answers.
- Excluded publishers: add (up to 100), remove, with the old rules for what counts as a valid domain.
- Added sources and topics: the personalization read, removing a source, removing a topic.
- Adding or changing a topic checks the input like the old app, then answers 503 "Topic discovery
  requires web search", because the package has no web search yet.
- Catalog of the nine built-in sources and eight topics.
- Refresh state is only read. The package answers "idle" and never writes it.
- Data export for the owner's added sources, topics and exclusions, and delete-account counts for
  all eight tables.
- App map entries in the package manifest (settings entry, three features, two error codes).
- The nine old SQL files stay byte for byte where they were. A test checks them.

### Proof

All checks ran on a throwaway database through the verify gate, against the installed package.

| Claim                                    | Check                                                                                       | Result                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Same answers as the old routes           | 176 steps replayed through the old routes and the installed package, ids and times masked   | Matched                                          |
| Old SQL rules still hold                 | Direct SQL inserts of a repeat choice and a repeat exclusion                                | Refused                                          |
| Another person sees nothing              | A second person and an admin list, delete and change A's rows                               | Nothing seen, nothing changed                    |
| That check can fail                      | Row security removed from all eight tables, B reads A's rows; restored, B reads nothing     | Seen failing, then passing, on each of the eight |
| Typed text stays out of everything else  | Planted marker typed into every field, 53 tables and job payloads scanned                   | Found only in the owner's own exclusion row      |
| Export is the owner's only               | A's export holds A's rows and not B's                                                       | Passed                                           |
| Package builds native and as WebAssembly | Guest tests native (18), package tests against the built component (6 package, 4 installed) | Passed                                           |
| Works on the real server over HTTPS      | Real server, real login, two people save choices, exclude a publisher, ask for a topic      | Passed; each person saw only their own           |

### Not proven or not built

- Refresh state is never written. Part 5b owns it, so the refresh block in the old routes' answers
  is left out of the comparison.
- Excluding a publisher or removing a source does not trim the saved feed. The saved feed table has
  no row id, and the host's typed database port can only change a row by id. The old routes trim it.
  Nothing in this package shows the saved feed articles, and the count in the personalization read is
  left out of the comparison.
- Availability is a fixed answer (no model, no web search). Real availability comes with the parts
  that have a model and search.
- Adding or changing a topic always answers 503 after its checks. The old app can discover topics
  with web search.
- The limit checks (100 exclusions and the other caps) count and then insert, so two requests at the
  same moment could pass the limit by one.
- Domains with non-ASCII letters are converted to their `xn--` form by a hand-written converter
  that only lowercases. Exotic case folding the old URL parser does (for example full-width
  letters) is not copied.
- Fetching, reading articles, source setup, credentials, chat tools and every News screen.
- Reaching the server from a phone or another computer. The package adds no listener. The live run
  used the local secure address only.

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

## Weather package (part 20b)

Card JS-278. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A. No screens (part 21).

### What was built

Weather is now an installable package. It shows today's weather and an hourly forecast for each
person's saved place, or a guessed place when none is saved.

- Routes: today, forecast, place (read and save), place search, place lookup by point, unit (read
  and save). They moved from Settings and now sit under the Weather package's own path.
- Tools for chat: forecast, search places, read and save the place, read and save the unit.
- Outside services: Open-Meteo forecast and search, Nominatim place lookup, ipwho.is for the
  address guess, and a table of cities for each saved time zone when the guess is not possible.
- Forecasts are cached for 30 minutes in one shared store with no person or place name in the key.
  The guess is cached per person for 6 hours, and the address itself is never stored.
- A reading is stale when it was fetched over 30 minutes ago or observed over 2 hours ago.
- Addresses that are loopback, private, link-local, broadcast, tailnet (100.64.0.0/10) or the IPv6
  equivalents are skipped, including IPv4 addresses wrapped in IPv6.
- Host plumbing: a package that declares it needs the connecting address gets the directly
  connected peer address, and nothing from forwarding headers. A read-only entry for the saved
  time zone. A default User-Agent on outside requests.
- Briefings now includes a one-line weather section, using Weather's public api, with a visible
  gap when Weather is missing or fails.

### Proof

| Claim                                           | Check                                                                                                                                          | Result                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Real forecast through the real fetch path       | The installed package on the real server over HTTPS fetched live Open-Meteo for a saved place; today and a 12-hour window returned             | Passed                     |
| Saved place survives the move                   | Place and unit saved through the new routes read back; stored in the same entries the old Settings routes used                                 | Passed                     |
| Two people stay apart                           | Second person's place and unit unchanged after the owner saved; their today is empty                                                           | Passed                     |
| Tailnet and other private addresses are skipped | Guest tests over each address range, with the skip removed the test fails                                                                      | Seen failing, then passing |
| Stale after two hours                           | Guest test at the boundary; fails with the rule removed                                                                                        | Seen failing, then passing |
| Cache keys carry no person data                 | Guest tests read every stored key                                                                                                              | Passed                     |
| Briefings shows weather                         | Briefings gate, 3 new unit tests plus the installed run                                                                                        | Passed                     |
| Private place never in the server log           | Planted name and coordinates saved over HTTPS, log searched                                                                                    | Not found                  |
| Private place in no other table                 | Planted name and coordinates, every table in three schemas searched except the saved-setting row; a leak planted on purpose made the scan fail | Seen failing, then passing |
| Native and WebAssembly builds                   | Guest tests natively, component built for WebAssembly, package tests against it                                                                | Passed                     |

### Differences from the old app

- Today returns an empty answer when a service fails, marked unavailable so Briefings can show a
  gap. The old route returned an error in some cases.
- The address guess is cached per person in the shared store, not in server memory, because each
  call runs in a fresh instance.
- Behind a proxy the connecting address is the proxy, so the guess is skipped and the time zone
  city applies.
- The package serves its routes under its own path, and the server keeps the four old Settings
  paths (place, search, reverse, unit) as aliases to them for the support window. Error bodies keep the old shape (400 with a message, 502 with
  an error).
- The Briefings 10 second limit on its weather read is not enforced inside the package.
- The visual forecast snapshot is not built.

### App map

The manifest declares the navigation, the settings (place and unit) and the features (chat
actions, today, visual forecast). The Account screen wording stays true.

### Not proven

- A phone or another computer reaching Weather over HTTPS. Only this machine was used.
- The tailnet skip end to end on the real server. It is proven in the guest, and the live test
  connects from loopback, which is also skipped.
- Route parity against the old handlers by running both. Bodies and statuses were copied by
  reading the old code.
- The live row-security failure for Weather. Weather has no tables. Row security on the saved
  settings was proven in part 20a.
- Job payloads and activity rows from a real chat run. Weather writes none, and the scan found no
  planted text in any table.
- Two requests at once can overwrite each other's freshly cached forecast, because the shared
  cache is read and written whole. The cost is one extra outside fetch, never wrong data.
- The visual forecast and the screens (part 21).

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

## Sports overview core (part 12a)

### What was built

The Sports package now answers the overview, the standings view and the latest result, with the
same bodies as the old routes. It still shows no screen.

- Followed clubs appear as cards. A club followed in two competitions (for example a league and a
  cup) shows one card. The league follow names the card, and the newest follow breaks a tie.
- A card carries the live or finished game, the last five results, the next match and the league
  standing line. A follow saved without a permanent club id is listed for the person to resolve
  and never gets a score.
- With nothing followed, the overview shows a default slate of five major leagues.
- ESPN days follow US Eastern time, with the daylight saving rule written out because the package
  has no time zone database. The overview reads yesterday and today in that zone.
- The standings route answers a competition's standings, split into conference and division
  views, and adds the games around today once a tournament's group stage is complete.
- The latest result reads one club's last ninety days from ESPN, across every competition the
  person follows it in.
- The shared store gained two public datasets (club schedule ten minutes, club results three
  minutes). It holds only public ESPN data, keyed by competition, club and day.
- The manifest lists the three routes, the two store names and four app map entries.

### Proof

| Claim                                  | Check                                                                                                                                             | Result                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Same answers as the old code           | The old overview, standings and result routes were run on recorded ESPN pages for four scenarios and 12 requests, then compared field by field    | Matched                                                                                                                         |
| A club in two competitions is one card | One club followed in a league and a cup, plus a second club in the same league                                                                    | One card, then two cards                                                                                                        |
| Evening games land on the right day    | Winter and summer instants, both daylight saving edges, month and year edges, and the dates the overview sent to ESPN for a 22:00 Eastern evening | Eastern day used, not the UTC day                                                                                               |
| Speed                                  | A warm overview with two followed clubs, 30 runs, native build                                                                                    | Native p95 9.9 ms, budget 50 ms                                                                                                 |
| Another person sees nothing            | Second person against real Postgres through the installed package, seen failing with row security removed                                         | Failed without it, passed with it                                                                                               |
| Private text stays out                 | Planted text in a follow searched for in the shared store, outgoing addresses and every host call that is not the person's own table              | Not found                                                                                                                       |
| Native and WebAssembly builds          | Guest tests native, package tests against the built component                                                                                     | Passed                                                                                                                          |
| Works on the real server               | Real server, real ESPN over HTTPS, two people: one card with standings, the other person sees none                                                | Overview answered 200 in 1.67 s cold; second person got 200; standings 200; results answered "needs_team" for an ambiguous name |

### Not proven

- Headlines, top stories, league news, the gameday hero slides, the featured story body and the
  tonight band are part 12b. The overview returns them empty and the hero in story mode with no
  headline, so the old screen would show less than it does today.
- The old overview also loads headlines. Parity compares everything except those fields.
- The old result route stamps its own clock. The new one uses the host clock, so that one field
  is compared for shape only.
- Daylight saving is a written rule for years from 2007. A future change of the US rule would need
  an edit.
- The speed budget is set in the module registry design as p95 route time against the native
  build. Only the native number is measured here.
- A club schedule read has no host-side cap beyond the general fetch limits.
- Any screen.

## Part 2: shared feed reader

### What was built

A small library at `~/Jarv1s/modules/news/reader`. It reads news feeds from text it is handed. It opens no connection, reads no file and writes no log.

- Reads RSS and Atom feeds into headlines, with date, picture and a short summary.
- Cleans feed text: strips markup, decodes character codes, trims long text.
- Reads a subreddit's public feed and keeps only the posts that link out to a publisher.
- Works out which publisher a web address belongs to, using the public suffix list.

It carries no screens, settings, routes, tables or errors a person can see. The plan puts app map entries with the screens (part 8), so this part adds none.

### New libraries

Only the three Ben approved, pinned in the lock file: `scraper` 0.29.0, `quick-xml` 0.42.0, `psl` 2.1.253. Each builds for WebAssembly. The reader depends on all three and builds for WebAssembly, and the test run inside the WebAssembly module uses all three.

### What was proven

| Claim                                                    | How                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same results as the old reader                           | The old TypeScript reader was run on 522 cases. The Rust reader matches every one.                                                                                  |
| Old fixture feeds give the same items                    | BBC, Guardian, NPR and Verge captures, run through each source's picture rules.                                                                                     |
| Edge cases match                                         | 69 invented feeds, 54 web addresses, 26 text cases, 19 dates, 31 subreddit inputs, 34 Reddit posts, 14 Reddit feeds.                                                |
| Fixtures hold no personal data                           | A scan in the test run (emails, phone numbers, private addresses). Author names were removed from the fixtures.                                                     |
| Native and WebAssembly                                   | The same 522 cases pass natively and inside a WebAssembly module under Node.                                                                                        |
| A second person never sees the first person's text       | Test below.                                                                                                                                                         |
| Private text cannot reach logs, job payloads or activity | The library takes text in and returns values. A source scan flags print, log, file, network and shared-state calls. It is a guard, not a proof for all future code. |
| Real feeds                                               | The built reader parsed live BBC (30 items), NPR (10), Guardian (30), Verge (10) and the NFL subreddit (10 headlines).                                              |

### Row-level security: honest answer

The reader has no tables, so there is no row-level security to test here. The nearest real property is that it keeps nothing between calls. The test runs one person's feed and another person's feed across eight threads, 200 rounds each, and fails if any of the first person's marker text shows up in the second person's results. It was seen failing when a leaky shared cache was added to the library, and then reverted. The same mutation also trips the source scan. The real row-level security tests belong to part 3, where the News tables arrive.

### How to run

```
scripts/run-gate.sh start --gate test:rust-news-reader
```

The golden file is regenerated from the old code with `modules/news/reader/tools/legacy-golden.ts`.

### Not proven

- Not run through the real Rust server. The reader is not wired into any package until parts 3 and 4, so no server route calls it yet.
- Not run in a browser or on a phone. There is no screen.
- Host names fold fullwidth letters, ideographic full stops and soft hyphens, but other Unicode compatibility folding is not applied, so a rare look-alike host could still differ from the old code.
- Public suffix answers match `tldts` on a 34-host list, not on every host.
- Dates without a zone are read as UTC. The old code read them in the server's zone. Feeds seen so far always carry a zone.
- Live feed shapes can drift. Only part 22's live pass checks that over time.

### Review round 1

Codex found no blocker and two major problems, both fixed: a feed tag with tens of thousands of attributes took 17 seconds (now linear, with a test), and look-alike host names (fullwidth letters) bypassed the Reddit-internal link rule. Four minor ones were fixed too: overflowing ports, malformed IPv6 hosts, mixed-case hex codes in Reddit titles, and gaps in the source scan.

## Part 4: adding a news source (JS-279)

Previewing and saving a source, finding a site's feed, the content-policy check, the short-lived preview store and subreddit sources now run inside the News package. Built on part 1 (public-web fetch), part 2 (reader) and part 3 (package skeleton). No screens.

### What was built

- Two routes: preview a typed address or subreddit, and save a previewed source by its confirmation id.
- Feed finder: reads the page, follows its feed link, falls back to scraping the page, and accepts a feed address directly.
- Policy check: an unseen publisher is judged by the person's configured model, with the page text sent as marked untrusted data. A verdict is remembered for 24 hours per person and publisher. A followed redirect to a publisher with no remembered verdict never calls the model.
- Preview store: kept in the person's own key-value file, 10 minutes, at most 10 per person. Another person's confirmation id finds nothing.
- Save rules follow the old routes: expired or taken preview answers 409, duplicate source 409, over the limit 400, replacing a source resets its failure count.
- The availability answer now reports adding by address as on. Name search and free-form topics stay off.
- App map: the manifest lists the two routes, the new capabilities, the new error and the updated "added sources" feature text.

### Proof

| Claim                                                     | Evidence                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each fetch failure reaches the preview                    | 18 package tests, including all 8 failure reasons                                                                                                                                                                                                       |
| Sites with and without a feed link                        | Fixture sites: feed link, scrape fallback, direct feed                                                                                                                                                                                                  |
| Same answers as the old routes                            | The installed test replays refusals, a preview, a save, a repeat save and the later reads against the old handlers and compares step by step                                                                                                            |
| A second person cannot see or use the first person's data | Real Postgres test. Person B and an admin cannot see A's saved sources, and B cannot see A's verdict or save or reuse A's preview. With row security removed, the sources and verdicts tables leak (RED).                                               |
| Typed text stays out of logs, jobs and activity           | A feed address carrying a planted marker is previewed and saved. The marker is then found only in the person's own saved source row across 53 scanned tables, and the package only uses the database, key-value, fetch, model and context ports         |
| Native and WebAssembly                                    | The gate builds the component and runs package tests in both                                                                                                                                                                                            |
| Real server, real fetch                                   | The live test starts the real Rust server over HTTPS, previews and saves the real BBC news feed through the server's own public-web fetch, and confirms a second person cannot save the preview or see the source. Nothing was intercepted or rewritten |

### How to run

```
scripts/run-gate.sh start --gate test:rust-news
```

```
scripts/run-gate.sh start --gate test:rust-news-live
```

### Not proven

- The live test server has no text model. The live run shows the honest "unavailable" answer first, then plants the person's own remembered verdict for the BBC domain so the real fetch, preview and save can finish. A real model verdict on a real site was not exercised.
- The host cannot say whether a model is set up, so the model fingerprint is fixed and the availability flag is always on. A missing model shows up when a preview is tried.
- Name search (typing a publisher name instead of an address) needs web search and is not built.
- The old "no JSON model" prerequisite is not built.
- Two previews started at the same moment can lose one write, because the preview file is read and written without a lock.
- A preview is not strictly single-use under concurrent saves. Two saves of one preview at the same instant can both succeed, and a concurrent new preview can bring back a used one. The host key-value port reads and writes a whole file with no compare-and-swap, so closing this needs a host change.
- A remembered approval (24 hours) is not tied to the model in use, because the host gives no model identity. If the person changes or removes their model, an approved publisher stays approved until the memory expires. Closing this needs the host to report a model fingerprint.
- Reddit redirects are refused after the redirected request was made, not before. The host still only fetches public addresses.
- The row-security test shows the leak with protection removed for sources and verdicts, but does not re-run the admin query after protection is restored, and does not try an admin save of someone else's preview.
- The publisher connection offer (part 6) and the refresh after saving (part 5b) are not built.
- The page parser differs from the old one on odd markup. Only the fixture sites and one real feed were compared.
- The preview label for the BBC feed shows the domain, not the feed's own title. Not checked against the old label for a real site.
- Hermetic database tests stub the public web; only the live run uses the real fetch.

### Review round 1

Codex found no blocker, three major and two minor points. Fixed: the privacy test now completes a real preview and save with the marker in hand. Recorded above as not closed because they need a host change: single-use previews under concurrency, and verdicts tied to the model. The two minor points are listed in the not-proven list.

## Part 15: host browser port

Adds a host "browser" port. A route call hands it a page address the person confirmed and a list of
allowed hosts. The host renders the page in a pinned, sandboxed Chromium and returns the title, up
to 20,000 characters of text and up to five link candidates. The Sports package will use it to find
headlines on script-heavy publisher pages.

### What was built

- Chromium runs under `bwrap` in its own network namespace, so it has no route out. Chromium's own
  sandbox stays on. If either layer cannot start, the port answers `unsupported`. There is no
  fallback to a browser with network access.
- The host talks to the browser over its debugging pipe with a small hand-written client. No new
  crate was added.
- Every page request is paused and answered by the host's safe public-web fetch. Only GET over
  HTTPS on port 443 to an allowed host is answered. Everything else is refused.
- Caps: 20 s per render (also bounded by the call's own time), 40 requests, 4 at once, 10 MB in
  total, 2 MB per response, five candidates.
- Only a route call may use the port. A job call is refused and no browser starts. Only one render
  runs at a time (`busy`).
- One pinned Chrome for Testing build (157.0.8103.78) with a checksum, kept outside the repo and
  never installed system-wide. `tools/fetch-chrome.sh` downloads and verifies it.
- The manifest accepts a `browser` capability only with the `public-web` resource, and shows the
  line "Open pages you confirm in a sandboxed browser". The package SDK has `render_page`.
- The server reads an optional `browser_dir` setting. Absent means the port answers `unsupported`.
- No screens. No core app-map entry exists for a permission line (same as part 1), so none was added.

### Proof

| Claim                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket, WebRTC and preconnect reach nothing                                          | probe test against a loopback listener                                                                                                                                                                                                                                                                                                                                                                                       |
| The same probes reach the listener when the namespace is removed                        | control test (`Isolation::None`, proof feature only)                                                                                                                                                                                                                                                                                                                                                                         |
| Off-list, private, non-HTTPS and direct requests are refused, each guard seen failing   | guard test with the host list, the private check and the sandbox each removed in turn                                                                                                                                                                                                                                                                                                                                        |
| Job calls refused, nothing started                                                      | job test                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Caps on requests, response size, total bytes and time hold                              | cap test, including a page that hangs                                                                                                                                                                                                                                                                                                                                                                                        |
| Missing browser or missing sandbox gives `unsupported`                                  | two tests                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Private text stays out of activity, and a second person never sees the first's activity | per-person activity test, seen failing when the two people share one store                                                                                                                                                                                                                                                                                                                                                   |
| Manifest and SDK                                                                        | 3 manifest tests, 1 SDK contract test, 8 unit tests in the browser module                                                                                                                                                                                                                                                                                                                                                    |
| Native tests                                                                            | full module-host suite green                                                                                                                                                                                                                                                                                                                                                                                                 |
| Live run                                                                                | `test:rust-browser-live` through verify-gate: real moss-shell, real application, installed package, real internet. example.com rendered (title "Example Domain", 2 requests, 911 characters). 10.0.0.5, 127.0.0.1 and localhost listed by the package were refused at fetch time. [::1], http, port 8443 and an unlisted host were refused up front. The server started with `browser_dir` set and answered `/api/hello` 200 |

### How to run

```
MOSS_BROWSER_DIR=<folder> scripts/run-gate.sh start --gate test:rust-browser-live
```

The ignored sandbox tests run with `module-host/tools/browser-gate.sh` after `tools/fetch-chrome.sh`.

### Review

Round 1 (Codex) found two major and one minor issue (download cap checked after downloading, a
stuck browser could hold the render slot, returned address could differ from the page read). Round 2
found three major and one minor issue in the fixes (a failed download refunded in full, the watchdog
could signal a reused process id, a slow earlier navigation could overwrite a later one, HTTP error
answers charged in full). All are fixed. No private-network escape, cross-person leak or unisolated
fallback was found in either round.

### Not proven

- DNS, prefetch and service worker reaching the listener without the namespace were not seen.
  Interception already stops prefetch and the worker script, and the system resolver cannot be
  watched from the test. The namespace removal control shows WebSocket, WebRTC and preconnect only.
- Server log output was not captured by the tests, so "no private text in logs" rests on the
  browser's output being discarded and the code never logging page text.
- The WebAssembly build of the whole module host fails on dependencies (wasm32-wasip2 for memchr and
  zmij). The browser client is native-host only by design, and the SDK tests run natively.
- The host's default route deadline is about 5 s. A render needs up to 20 s, so the Sports package
  needs a raised budget.
- The watchdog that kills a stuck browser is tested on its own (a sleeping process). No test makes
  a real browser stop reading its pipe, so its use inside a render is reviewed but not run.
- Two page navigations racing each other are ordered by when the page asked, not tested with a
  real slow-then-fast pair. Only a plain script navigation is tested.
- The 10 MB total reserves 2 MB per request before downloading. Near the limit, a request can be
  refused while others are still in flight, even if its real size would have fit. A download that
  fails part way counts as a full 2 MB, so the total is never under-counted.
- Reaching the browser port from a phone or another computer was not tested. The port adds no
  listener. The live run reached the server on this machine only.
- The live run reached the guest through the install path, not an HTTP route, as in part 14.
