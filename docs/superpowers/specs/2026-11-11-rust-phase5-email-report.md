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

- The message list is read in pages of 200 so a large mailbox fits the host's response limit. A
  database test with 2,400 messages proves no gaps or repeats, and that one unpaged read would
  not fit.
- A malformed message id answers 404. The old server answered 500.
- The excerpt cap of 500 counts characters, the old code counted UTF-16 units. They differ only
  for rare characters outside the basic range.
- Briefing source and draft policy are package routes now. The old app served them from core.

## Not proven

- A second physical device. The live run used one browser on this machine.
- A second person over the network. Setup allows one owner, so the second person is proven in the
  database test only.
- Inserting and updating messages through the public API on the real server, as the owner, a
  second person and a manage-share person. The guest tests and the database tests cover each layer
  separately, and nothing calls it yet. The sync part must add that assembled test.
- The old triage-preservation behaviour on update. It belongs with sync, a later part.
- Connectors will need to call Email while Email requires Connectors. That is a possible circular
  install order and needs a decision in the sync part.
- The marker search over the server log covers the live run only.

# Part 4: IMAP and SMTP connect

## What was built

- The Connectors package can now save a mail account for Yahoo, Proton Bridge, iCloud or Fastmail
  and test the sign-in first. Two routes: `POST /api/connectors/imap/test-connection` and
  `POST /api/connectors/imap/connect`. Status codes, answer shapes and error text match the old
  routes (79 route comparisons pass against the real old route code).
- The server addresses come only from the provider choice. A request cannot name a host or port,
  so it cannot point the server at an internal address.
- The host does all mail traffic and keeps the password. The sealed bundle uses the same
  AES-256-GCM format as the old app, and the password never reaches the guest, logs, jobs or
  answers. Accounts stay private to their owner through row-level security.
- A failed sign-in saves nothing. Connecting again with the same account updates the same row.
- No screen was built. No approved connection-form mockup exists in
  `docs/superpowers/specs/mockups`, so the form waits for a design discussion with Ben.
- Nothing is scheduled. The 15-minute sync belongs to part 5.

## Third-party code

| Crate      | Version | Licence           | Why                                                                                                                  |
| ---------- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| async-imap | 0.12    | MIT OR Apache-2.0 | Maintained by the Delta Chat team, last release 2026-09-30. Pure Rust, runs on tokio, no OpenSSL.                    |
| lettre     | 0.11.23 | MIT               | The standard Rust SMTP client, last release 2026-08-03. Features limited to tokio and rustls with the ring provider. |

- The mail parser is not added in part 4, because connect never reads a message. mail-parser
  1.0.1 is the recommendation for part 5, after its licence is checked there.
- tokio-rustls 0.26 and webpki-roots 1 are now direct dependencies of the host. Both were already
  in the lock file. Ben should know, since the approval named three crate kinds.
- The tree has no OpenSSL, no aws-lc and no platform verifier.

## Proof

- Stand-in IMAP and SMTP servers on this machine, with real TLS and throwaway certificates:
  good sign-in, wrong password on IMAP and on SMTP, connection limit, untrusted certificate,
  wrong-host certificate, and a closed port.
- A two-person test in the database, seen failing with row security switched off.
- A password marker searched for in every answer, the log and every stored row, with a check that
  the search finds a planted value.
- A live run on the real server over HTTPS against a stand-in mail server.

## Differences from the old app

- A wrong SMTP password and any certificate error are now reported as "rejected username/password"
  and "could not establish a secure connection". The old code reported both as "could not reach
  the mail server".
- Reaching the mail server through plain mode tries an upgrade to TLS and carries on without it if
  the server refuses, as the old library did.

## Not proven

- A real mail account. None is reachable from here.
- The STARTTLS upgrade, on IMAP or SMTP. The stand-in has none.
- A second physical device.
- No logger is installed in the shell, so the IMAP library's trace lines go nowhere. If a logger
  is added later, check that it does not print login lines.
