# Rust Phase 5: News, Sports and Weather report

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
routes still serve them. The Weather package declares its entries in its manifest in part 20b.

### Not proven

- A Weather package using these two entries on the real server. None exists until part 20b, so
  the live run used Sports, which shares the same port and the same wiring.
- A phone or another computer reaching the server. This part adds no listener or screen.
- The 6-hour address guess, the forecast and the search routes. Those are part 20b.
