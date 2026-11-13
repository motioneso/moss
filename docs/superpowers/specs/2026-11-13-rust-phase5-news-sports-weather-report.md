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
