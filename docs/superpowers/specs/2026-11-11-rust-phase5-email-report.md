# Rust Phase 5: Email package (part 3) report

Card JS-225. Part of [issue 4027](https://github.com/motioneso/moss/issues/4027). Release note
Category: N/A.

## What was built

The Email package keeps each person's cached mail messages and their Email preferences. It reads
and writes the same database tables as the old app, so existing rows carry over. It makes no
network calls, sends nothing and calls no model.

- Two message routes (list and detail) with the same bodies, status codes and not-found answer as
  the old app.
- Briefing settings, task creation mode and the remaining Email preferences, stored and served like
  the old routes, with the old defaults when nothing is saved.
- Two small routes the old screen reached through core routes: the "include email in briefings"
  switch and the "draft replies without asking" choice.
- A public API so Connectors can later add and update cached messages. Today only a test writer
  uses it. Calendar and other callers still fail closed.
- The Email settings screen in the house style, plus the app map entries in the package manifest.
- A sharing declaration for messages, so a message shared with another person can be read by them
  and changed only with manage access. This needed a reviewed change to the host's list of
  shareable tables.
- The old SQL files stay byte for byte where they were. A test checks all eight against the
  inventory.

## Proof

| Claim                        | Evidence                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes match the old app     | 20 cases run against the old Fastify routes and the new ones, compared exactly                                                                                                                                             |
| Second person sees nothing   | Database test; seen failing with row security switched off (the foreign person reached the message), then passing with it on                                                                                               |
| Sharing works and is limited | Database test: grantee can read, can change only with manage, and an unshared message leaks when row security is off (so the check has teeth)                                                                              |
| No message content leaks     | Package test with a marker body and address: they reach only the cache write, never an error. Live run: absent from the server log and every job and audit row, with a control search that finds them in the message table |
| Native and WebAssembly       | 13 guest tests native; 6 package tests run the real WebAssembly build; 3 screen tests                                                                                                                                      |
| Live run                     | Real server over HTTPS, real sign-in, real browser: the settings screen showed the saved choices, a click and a menu change saved and survived a reload                                                                    |

Commands: `pnpm test:rust-email` and `pnpm test:rust-email-live`, both through the gate script.

## Differences from the old app

- A malformed message id answers 404. The old server answered 500.
- The excerpt cap of 500 counts characters, the old code counted UTF-16 units. They differ only
  for rare characters outside the basic range.
- Briefing source and draft policy are package routes now. The old app served them from core.

## Not proven

- A second physical device. The live run used one browser on this machine.
- A second person over the network. Setup allows one owner, so the second person is proven in the
  database test only.
- Inserting and updating messages through the public API on the real server. Only the guest tests
  and the database tests cover it, and nothing calls it yet.
- The old triage-preservation behaviour on update. It belongs with sync, a later part.
- Connectors will need to call Email while Email requires Connectors. That is a possible circular
  install order and needs a decision in the sync part.
- The marker search over the server log covers the live run only.
