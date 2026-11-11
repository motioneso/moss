# Rust Phase 5: Connectors part 1 report

Card JS-224. Branch `task/224-rust-port-phase-5-email-and-connectors-p`. Part of issue 4027.

## What was built

The Connectors package keeps the list of mail and calendar accounts, what each one may be used
for, and whether it is healthy. It reads and writes the same database tables as the old app, so
existing accounts carry over. It makes no network calls.

- Eight routes with the same bodies, status codes and not-found answers as the old app: providers,
  list and create accounts, edit, revoke, read and set feature grants, and the admin list.
- Account secrets are sealed in the same envelope the old app uses. Responses carry only a safe
  summary.
- Feature grants for Email and Calendar. A missing setting means on. Each change writes one audit
  row in the same transaction.
- The health model for mail (six states) and for Outlook (eight states), each mapping tested.
- The Settings, Connections screen, in the house style, plus the app map entries and the audit
  wording for connections.
- The old SQL files stay byte for byte where they were. A test checks all 18 against the inventory.

## Proof

| Claim                            | Evidence                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes match the old app         | 44 cases run against both implementations and compared                                                                                         |
| Health and grant logic match     | 192 cases run against both and compared                                                                                                        |
| Second person sees nothing       | Database test; seen failing with row security switched off, then passing                                                                       |
| No secret leaks                  | Marker password and tokens searched in every response; seen in none                                                                            |
| Marker absent on the real server | Searched the server log and every job, audit and account row; a control search proves the search can find a stored value                       |
| Secret is sealed at rest         | The stored row holds one envelope, not the plain text                                                                                          |
| Old and new ciphers agree        | Existing portability tests cover both directions with the label "connector secret" (old-made opens in Rust, Rust-made opens in the old cipher) |
| Native and WebAssembly           | Guest tests native; package tests run the real WebAssembly build                                                                               |
| Live run                         | Real server over HTTPS, real sign-in, real browser: routes answered, Connections screen opened with the account and no secret                  |

Commands: `pnpm test:rust-connectors` (through the gate script) and
`pnpm test:rust-connectors-live` (through the gate script).

## Not proven

- A second physical device. The live run used one browser on this machine.
- A second person over the network. Setup allows one owner, so the second person is proven in the
  database test only.
- The marker search over logs covers the server log of the live run. No other log source exists in
  part 1, and part 1 queues no jobs.
- Revoke does not cancel sync jobs, because part 1 has none. The sync part must do this.
- The Outlook health states are mapped and tested in the package, but the screen shows mail states
  only, and there is no admin audit screen in Rust yet. The audit wording lives with the screen
  model and is tested there.
- Google, IMAP and Outlook sign-in are listed but not connected. Calendar's calls into Connectors
  still fail closed.
- Revoke state and the scopes edit were checked on the real server through the routes, not by
  clicking in the screen.
