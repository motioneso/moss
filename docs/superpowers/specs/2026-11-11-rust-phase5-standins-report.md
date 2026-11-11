# Rust Phase 5: stand-in servers for tests (Connectors part 2)

Part of #4027. Built in `rust-spike/standins`, a test-only crate that nothing ships or depends on.

## What was built

| Stand-in    | What it answers                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fake Google | Sign-in code exchange, token refresh, revoked token, wrong client. Gmail profile, message list with paging, message get (full, minimal, metadata, raw, multipart), history (added, deleted, label change, too old), send. Calendar list, event list, insert, change, delete. |
| Fake IMAP   | Login (right and wrong password, connection-limit refusal), folder list, select, search, fetch (whole message, header only, "changed since"), flag change, delete, expunge. Plain or TLS.                                                                                    |
| Fake SMTP   | Sign-in (two methods, right and wrong password), send with every recipient and the message recorded, daily-limit refusal. Plain or TLS.                                                                                                                                      |

Tests start each stand-in on a free local port, change its state (add, change or delete a
message, revoke a token, switch on a rate limit) and read back what was sent.

## What each failure case returns

| Case                                             | Reply                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Wrong IMAP password                              | `NO [AUTHENTICATIONFAILED] Authentication failed.` and the mailbox stays closed  |
| Wrong SMTP password                              | `535 5.7.8 Error: authentication failed`                                         |
| Self-signed certificate, client does not know it | Handshake fails with "unknown issuer"; no login is attempted                     |
| Certificate for another host                     | Handshake fails with "not valid for name"                                        |
| Revoked Google token                             | `400 invalid_grant`, "Token has been expired or revoked."                        |
| Used or wrong sign-in code                       | `400 invalid_grant`, "Bad Request"                                               |
| Google rate limit                                | `429`, `Retry-After: 7`, reason `rateLimitExceeded`, status `RESOURCE_EXHAUSTED` |
| Expired access token                             | `401`, status `UNAUTHENTICATED`, reason `authError`                              |
| Too-old Gmail history                            | `404 NOT_FOUND` (client must resync)                                             |
| IMAP connection limit                            | `NO [ALERT] Too many simultaneous connections. (Failure)`                        |
| SMTP daily limit                                 | `550 5.4.5 Daily user sending limit exceeded.`                                   |

## Proof

- Gate run `scripts/run-gate.sh start --gate test:rust-standins`: 37 tests pass, native build.
- Wrong-password path seen failing first: with the password check removed, the IMAP test failed
  because the server answered `OK ... Logged in`; with the check restored it passes.
- Response shapes: tests compare the key set of each served reply with the matching fixture.
- Fixtures: a test scans every fixture and fails on any address outside `example.com` (one invented Google calendar id at `google.com` is allowed).
- No new crate. Every package in the crate's lock file already appears in another lock file in
  the repo (checked by comparing package names). The IMAP and SMTP servers are hand-written line
  protocols over TCP.

## Fixtures and personal data

Fixtures are in `rust-spike/standins/fixtures/`. Names are invented (Alice Example, Bob Sample,
Carol Placeholder, Dave Invented), addresses are `example.com`, ids and tokens are made up.
A reviewer should read each one. The two TLS key pairs are throwaway test keys, made with the
system `openssl` tool, valid for 100 years, and trusted by nothing.

## Not proven

- Nothing here is checked against a real provider. The shapes follow Google's published
  response formats and Dovecot and Postfix wording from memory; a real account is still needed
  to confirm them (Connectors part 13).
- No STARTTLS (only TLS from the first byte), no IMAP IDLE, APPEND or COPY, no SMTP size limits.
- IMAP "changed" means a flag change; real servers cannot edit a stored message.
- Gmail covers one text part or one multipart level, not attachments, and ignores the search query.
- Calendar paging, sync tokens and time filters are simplified: the sync token is fixed.
- Google's real OAuth consent page and PKCE are not imitated, only the token endpoint.
