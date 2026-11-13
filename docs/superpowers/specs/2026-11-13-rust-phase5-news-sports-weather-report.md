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
