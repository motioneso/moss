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

| Claim                                    | Check                                                                                       | Result                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Same answers as the old routes           | 173 steps replayed through the old routes and the installed package, ids and times masked   | Matched                                     |
| Old SQL rules still hold                 | Direct SQL inserts of a repeat choice and a repeat exclusion                                | Refused                                     |
| Another person sees nothing              | A second person and an admin list, delete and change A's rows                               | Nothing seen, nothing changed               |
| That check can fail                      | Row security removed from five tables, B reads A's rows; restored, B reads nothing          | Seen failing, then passing, on each table   |
| Typed text stays out of everything else  | Planted marker typed into every field, 53 tables and job payloads scanned                   | Found only in the owner's own exclusion row |
| Export is the owner's only               | A's export holds A's rows and not B's                                                       | Passed                                      |
| Package builds native and as WebAssembly | Guest tests native (18), package tests against the built component (6 package, 4 installed) | Passed                                      |
| Works on the real server over HTTPS      | Real server, real login, two people save choices, exclude a publisher, ask for a topic      | Passed; each person saw only their own      |

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
- Domains with non-ASCII letters answer "invalid" where the old code converted them. All tests use
  plain ASCII names.
- Fetching, reading articles, source setup, credentials, chat tools and every News screen.
- Reaching the server from a phone or another computer. The package adds no listener. The live run
  used the local secure address only.
