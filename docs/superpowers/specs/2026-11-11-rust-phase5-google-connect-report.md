# Rust phase 5, part 6: Google connect (report)

Task JS-230, part of issue 4027. Covers connecting a person's own Google account (Gmail and
Calendar) to the Connectors package. No sync and no Email understanding are in this part.

## What was built

| Piece                                                                        | Where it lives                         |
| ---------------------------------------------------------------------------- | -------------------------------------- |
| Start and finish routes, same bodies, codes and errors as the old server     | Connectors package (`google.rs`)       |
| Consent address, token exchange, refresh, sign-in-needed marking, rate limit | Connectors host (`host/src/google.rs`) |
| Pending sign-in table, owner-only, used as the old app used it               | Existing `connector_oauth_pending`     |
| Client secret, access token, refresh token                                   | Sealed in the existing envelope        |
| Connect Google screen on Connections                                         | Connectors UI                          |
| Chat guidance tool (legacy), app-map entries, remediation                    | Package manifest                       |
| Fake Google process for live runs                                            | `rust-spike/standins` (`fake-google`)  |
| Test-only Google address setting                                             | Shell `test_only_google_token_url`     |

## Rules kept

- Token exchange and refresh happen in the host. The package never sees a token.
- A token with more than 60 seconds left is reused. Otherwise it is refreshed.
- Google answering 400, 401 or 403 to a refresh marks the account as needing sign-in
  (health value "auth-error"). A network failure or a 5xx leaves the account untouched.
- Refreshes for one person share a single request.
- Five finish attempts per person per minute. The sixth answers 429 with the old body.
- The test-only address accepts only plain http on this machine. It is off in a normal install
  and the server prints a warning when it is on.
- No new third-party crate. The lock files gained only links to crates already present and to
  the in-repo fake Google (used by tests).

## Proof

| Claim                                                      | Evidence                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes match the old server                                | 59 route cases built from the old code, all pass                                                                                                                                                                                                                                            |
| Full connect, refresh, revoked token, revoke               | Host tests against the fake Google, run through the gate script on a throwaway database                                                                                                                                                                                                     |
| Another person cannot start, finish or revoke a connection | Host test with a second person. It was seen failing with row security switched off                                                                                                                                                                                                          |
| Secrets stay sealed                                        | Test with marker secrets across every answer and stored row. It was seen failing when the pending row stored the secret unsealed                                                                                                                                                            |
| Real server                                                | Live run: real HTTPS server, real sign-in, real browser, fake Google behind the test-only address. Connected over HTTP and through the screen. The client secret and tokens were absent from the server log and every stored row. A control search proved the search can find stored values |
| Builds                                                     | Native and WebAssembly builds with tests pass through the gate                                                                                                                                                                                                                              |

One attempted failure did not trip the test. Adding the token bundle to the host's answer was
not caught, because the package only passes on the account part of that answer. The package is
a second layer of defence, so that change is harmless and no test was added for it.

## Things worth knowing

- The module screen runs in a sandbox that does not allow opening windows. The screen tries to
  open the consent page, and always shows the consent address so the person can copy it into a
  new tab. The sandbox was not loosened because every module shares it.
- Finishing a connection when a Google account already exists updates that account and clears
  a revoked state.

## Not proven

- A real Google consent screen and the real token endpoint over HTTPS. That needs Ben and a
  throwaway Google account.
- The onboarding connector step. The Rust shell has no onboarding hook yet, so the offer sits
  on the Connections screen (a Connect Google button) and in the manifest and app-map text.
- The desktop loopback catch (optional, skipped).
- Sync after connecting. No job is queued by this part, so no job payload could be searched.
  Part 7 does that and will call the refresh.
- The five-a-minute limit is held in memory per server run and resets on restart.
- A second physical device, and a second person over HTTP (setup allows one owner here).
