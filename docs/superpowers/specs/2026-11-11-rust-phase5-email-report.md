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
- The host does all mail traffic, seals the password and stores it. The sealed bundle uses the
  same AES-256-GCM format as the old app, and the password never reaches logs, jobs, answers or
  stored rows in plain text. Accounts stay private to their owner through row-level security.
- The password does pass through the guest. The server hands the whole request body to the
  package, the guest checks it and forwards it to the host in one call, and the guest never keeps
  or returns it. The guest is the signed Connectors package, not outside code. Keeping the
  password out of the guest entirely would mean the host taking the body before the package runs.
  That changes how every module is called, so it needs a decision before it is built.
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
- All 29 new packages in the host lock file are under permissive licences (MIT, Apache-2.0, Zlib,
  0BSD, or CDLA-Permissive-2.0 for the root certificate list). self_cell offers Apache-2.0 as an
  alternative to GPL-2.0, and Apache-2.0 is the one that applies. The repo has no dependency
  licence checker and installing one needs approval, so the check was a read of each package's
  declared licence.

## Proof

- Stand-in IMAP and SMTP servers on this machine, with real TLS and throwaway certificates:
  good sign-in, wrong password on IMAP and on SMTP, connection limit, untrusted certificate,
  wrong-host certificate, and a closed port.
- A two-person test in the database, seen failing with row security switched off.
- A password marker searched for in every answer, the log and every stored row, with a check that
  the search finds a planted value.
- A live run on the real server over HTTPS against a stand-in mail server.

## Differences from the old app

- The 79 route comparisons stand in fake sign-in results keyed on the password, so they prove
  status codes, answer shapes and error text, not the real sign-in classification. The
  classification is proven only against the stand-in servers.
- A wrong SMTP password and any certificate error are now reported as "rejected username/password"
  and "could not establish a secure connection". The old code reported both as "could not reach
  the mail server".
- Reaching the mail server through plain mode tries an upgrade to TLS and carries on without it if
  the server refuses, as the old library did.

## Not proven

- A real mail account. None is reachable from here.
- The STARTTLS upgrade, on IMAP or SMTP. The stand-in has none.
- A second physical device.
- The test-only mail setting is refused by any release build of the server, so a production
  install cannot be pointed at a stand-in server. That refusal was written but not run, because
  every gate here uses a debug build.
- No logger is installed in the shell, so the IMAP library's trace lines go nowhere. If a logger
  is added later, check that it does not print login lines.

# Part 5: IMAP sync

## What was built

- A connected Yahoo, Proton Bridge, iCloud or Fastmail account is read every 15 minutes, and once
  straight after connecting. Revoking the account stops the schedule.
- Each run lists the Inbox for the last 30 days (newest 5,000 at most), compares the list with
  what Email already holds, fetches only new or changed messages, and saves them through Email's
  public API. Messages the server no longer lists are removed from Email, but only inside the
  30-day window, so older cached mail stays.
- A message is saved as sender, recipients, subject, time and a plain-text preview of up to 500
  characters. Sign-in code messages get no preview when the subject is in English and mentions a code. The host reads at most 128 KB of a message.
- A run handles 50 messages and then queues itself for the next 50, so one run stays inside the
  time and fuel limits. The connection's health shows the last run, its result and the counts.
- Overwriting a message from a sync keeps the summary and signals Email already worked out.
- Read and unread changes are not copied. No screen was built.
- Email gains two operations (a cache key list with sizes, and prune) and an owner-only delete
  rule. The server adds that rule when it installs Email, driven by a new manifest list
  (`ownerDelete`), because module SQL cannot hold a grant or a policy and a core migration runs
  before the Email table exists. A share never grants delete.
- Connectors now declares a 200M fuel limit, as People and Meetings do. The default of 10M was
  too small for a 500-message mailbox.

## Third-party code

| Crate        | Version | Licence           | Why                                                    |
| ------------ | ------- | ----------------- | ------------------------------------------------------ |
| mail-parser  | 0.11.9  | Apache-2.0 OR MIT | Reads message headers and text. Used by the host only. |
| hashify      | 0.2.9   | Apache-2.0 OR MIT | Pulled in by mail-parser.                              |
| futures-util | 0.3.34  | MIT OR Apache-2.0 | Already in the tree. Now a direct host dependency.     |

- The parser is outside the guest, so message text never enters WebAssembly.

## Proof

- Scripted tests of the sync loop in the guest (10), including paging, prune and
  an auth failure.
- A stand-in IMAP server on this machine, with real TLS, for listing and fetching.
- Email database tests with two people (14 pass): prune touches only the owner's mail, a view
  share cannot delete, and loosening the delete rule makes the same call delete (seen red).
- Cost of one run inside WebAssembly (debug build, fuel against the 200M limit):

| Messages | First step | Last step (prune) |
| -------- | ---------- | ----------------- |
| 50       | 6.9M       | 6.9M              |
| 500      | 8.6M       | 10.8M             |
| 5,000    | 28.3M      | 51.8M             |

- A live run on the real server over HTTPS, with Email and Connectors both installed from a
  signed registry: three messages cached through Email, one rewritten and replaced, one removed
  and gone, only the changed message fetched again, sync recorded as success. The mail text and
  password were searched for in the log and every row outside Email's own cache, including job
  payloads and activity, and found nowhere.

## Differences from the old app

- The old app never removed mail the server dropped. This one does, inside the 30-day window, judged by the server's arrival date. A listing that comes back short is never used to delete.
- Messages are read in steps of 50 with a fresh listing each run, so a large mailbox costs more
  listings than the old single pass.

## Not proven

- A real mail account. None is reachable from here.
- A release build. The first call into Email compiles its component inside the caller's 5 second
  limit. A debug build is slow enough to hit it, so the live test warms Email first. A release
  build should be far faster, but that was not measured.
- Mailboxes above 5,000 messages in the window. The cost grows with size, and 5,000 is the cap.
- Flag (read, unread) changes.
- The module-host change that emits the delete rule has been run only through the Email database
  tests and the live run, not through an upgrade of an install that already has Email.

# Part 8: Email understanding

## What was built

- A pass that reads cached mail the person has not been understood yet and stores a summary and
  signals on each message. It runs on request (`POST /understand`) and handles a batch at a time.
  It returns only counts: how many were understood, how many failed, and whether an AI service
  still needs choosing.
- Mail the person sent from their own address, and sign-in code messages, are settled without any
  model call.
- Everything else goes to the person's configured AI model through the router. No provider or
  model is named. The model sees only the cached subject, sender and preview text, and the received
  day and today's day in the person's timezone.
- A first call asks six yes/no questions and turns the answers into a category. A call that is
  unsure, or that fails, falls back to the general model, which writes the summary and signals.
  A first-pass gate then decides whether a message is noise, worth knowing, or maybe owed.
- Failures count as attempts per message. A message that fails five times stops being retried.
  A changed message (new revision) starts again from zero.
- Triage feedback and action suppression (dismiss, reset, evidence, deadlines) are stored in the
  Connectors tables and read through Email, one owner at a time.
- If no AI service is chosen, or the service is down, the pass stops with a plain "Email could
  not reach your AI service" message and counts no attempt, so mail is never abandoned because of
  the service. The router hides which of the two it was.
- The app map entries in the Email manifest cover the new routes, resources and two new features.

## Proof

- Fixed fake-model cases ported from the old tests: sign-in code rule (9), gate, sorting and
  reply parsing (9), the whole pass with a scripted model (6).
- The pass tests check that sign-in and own-sent mail make zero model calls, that a failure counts
  an attempt and the pass carries on, that a missing AI setup writes nothing, and that prompts
  carry only cached text and results carry none of it.
- Email database tests with two people: pending mail carries the local day and known senders,
  stored results leave the list, failures stop at five, a new revision resets attempts, and a
  second person neither sees nor changes the first person's mail, suppression or feedback. The
  protection was switched off in one test and the leak was seen.
- Native and WebAssembly builds, with tests in both.
- A live run on the real server over HTTPS with the stand-in mail setup: the pass without a
  session is refused, the first pass settles the person's own message, the second finds nothing,
  and the message text and address are found nowhere in the log, job payloads or activity rows.

## Differences from the old app

- The input is the cached preview (up to 500 characters), not the 20,000-character body.
- Messages are handled one call at a time, not in batches.
- The six questions are one structured call, because the Rust router has no sorting-model
  capability. A failed sorting call falls back to the general model.
- The bulk hint reads the list-unsubscribe flag when present, else the word "unsubscribe".
- Accent folding uses a hand table, and the sign-in rule is hand-written, with no regex look-around.
- A known sender is taken from who the person has written to, because Email may not read People.
- Threads are linked by message id and references, because IMAP has no thread id.
- Suppression needs Connectors installed.

## Not proven

- A real model pass. It needs a configured AI service and Ben.
- Today and briefing refresh using these results (not part of this part).
- Gmail mail (part 7 is separate).
