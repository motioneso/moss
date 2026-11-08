# Rust port, Phase 4 part 2: sign-in and secure sharing

JS-44, Card 520. Part of #4027. Implements the network slice of the approved Rust port plan
and data/install rules. Code: `rust-spike/network/`, integrated into `rust-spike/shell/`.

## What works

Moss now serves the Rust shell through HTTPS and requires sign-in before private pages, app
files, chat or account data. The first owner creates their account on the computer running Moss.
An administrator can then turn on LAN and tailnet sharing, see the exact trusted addresses,
check the public certificate fingerprint, download the public certificate, and sign out.
Sharing starts off and the saved switch takes effect on subsequent requests, including existing
connections. The account button opens these settings on desktop and phone.

The new network crate wraps the entire private router, including its fallback. It reuses the
Phase 2 password hashing, signed sessions, expiry, revocation and account-state checks. Browser
sign-in replies explicitly allowlist public user fields: the session travels in the Secure,
HttpOnly, SameSite=Lax cookie, without a token in the JSON body. The shell uses the authenticated
account's name and separate per-account chat state; runner requests carry that account's UUID.
Today remains labelled sample data. No Workshop or Food functionality was ported.

Every request must name an exact configured HTTPS Host. State-changing requests also need an
Origin matching that request's authority. Wrong, duplicate, missing write and null origins are
refused; a different address in the same trust list is not a substitute. Cross-site browser
requests are refused. Forwarded headers grant neither network nor rate-limit trust. Owner setup
requires both a loopback peer and loopback authority and closes once an owner exists.

Sign-in allows five attempts per peer (IPv6 addresses share a /64 bucket) and one hundred remote
attempts per minute, with a separate local budget. Incomplete sign-in bodies time out after three
seconds before taking a password-check slot or setup lock. Auth bodies are limited to sixteen
kilobytes; chat retains axum's two-megabyte default. At most four password checks run together.
Remote connections cannot consume the owner's local connection reserve. Request logs contain a fixed event label and status,
without request paths, queries, headers or bodies. The TLS layer does not log parser input.

## Certificates and setup

The local-certificate command uses the already installed OpenSSL to make a thirty-day
certificate for the exact configured names and addresses, including server-authentication usage. It creates a private folder and
owner-only key. It does not install tools or trust roots. The server also loads supplied PEM
chains and keys, including certificates obtained through an operator's existing Tailscale
workflow. There is no plaintext or forwarded-proxy bypass mode.

Configuration, database credentials and signing/encryption keys stay in owner-only files outside
`~/Jarv1s`, vaults and agent folders. Startup verifies the existing app/auth database roles and
refuses roles that bypass row security. Read `rust-spike/network/README.md` for the configuration,
certificate and run commands. The listener is explicitly configured; use loopback for a local
install. An all-interface bind permits the sharing switch to work without restarting, but while
off it still accepts TCP/TLS handshakes before refusing remote application requests.

The operator must verify and trust a local certificate on each device. The sharing screen shows
the leaf fingerprint and downloads only the parsed public leaf, even if the configured PEM file
also contains other material. Certificate renewal, firewall changes, automatic key-store
provisioning and a packaged installation wizard remain installation work. They are not implied
by this server slice. Further registration stays closed until People management is ported.

## What was checked

All database checks used verify-gate's fresh throwaway Postgres, built from the repository's
migrations. No installed app or real account data was changed. Development ports were claimed
and released through devports. No global tools were installed.

- Eight Rust tests pass, covering Host/origin refusal, remote access while sharing is off,
  duplicate headers, exact address matching, the live policy switch, sign-in limits and browser
  response filtering. The initial three policy tests were observed failing before the guard.
- Three removal controls build deliberately weakened copies outside the worktree and run the
  same live assertions. Removing authentication fails with `Signed-out request reached private
data`. Adding request logging fails with `Session token or password appeared in server logs`.
  Removing response filtering fails with `Session token appeared in browser JSON`. Restoring
  the protections passes. No weakened mode is present in the shipped code.
- The real TLS listener refuses wrong Host/origin, signed-out APIs, chat, pages and app files.
  First-owner setup writes the existing scrypt hash format and refuses later or remote signup.
  The sharing choice persists, sign-out revokes the session, cross-site writes fail and forged
  forwarded addresses cannot evade the sign-in limit. Cookie, path, query and header probes
  leave the actual session token absent from server logs.
- A real password sign-in through the machine's second, non-loopback network address reaches
  the account and Today APIs. The client verifies the certificate chain and the target address's
  certificate SAN. This uses a second network address on the same Linux computer, not a separate
  physical device.
- In the task browser, the real sign-in form opens Today, the account button opens Sharing,
  saving the switch enables the second address, and a fresh sign-in there shows the real account
  name. Sign out returns to sign-in and a subsequent private account read is refused. Phone and
  desktop screenshots are in the task's proof artifact, outside this public repository.
  The isolated browser accepts the test certificate; certificate/hostname verification is
  independently enforced by the live HTTPS client above.
- The Rust shell and wasm UI build. Rust tests and network clippy pass. App-map tests check the Rust declarations against real Rust routes.
  The production build and lookup service exclude Rust entries; `scripts/build-app-map.ts --rust`
  produces a separate Rust artifact. A mixed-artifact lookup test also covers this boundary. Repository lint, format, file-size and type checks pass; their output is retained in the
  proof artifact.

## Independent review and corrections

The first Claude review found two major issues. Both were reproduced before correction:

```text
Stalled bodies blocked normal sign-in
429 !== 200
app-map integrity: 1 failed | 17 passed
```

Reading incomplete bodies before taking scarce slots fixes the first; the same live test now
signs in normally while four other requests remain unfinished. Separate runtime map builds and
lookup filtering fix the second. The final live check also verifies the body deadline, oversized
body refusal and the downloaded certificate's exact public bytes.

Minor findings addressed: separate local sign-in/connection budgets; IPv6 /64 limiting; retrying
transient accept errors; certificate server-auth usage; the desktop's configured local origin;
caching public theme files while keeping private replies uncacheable; and restoring the chat
body limit. The initial actual Host/origin failing-first output is recorded in the proof artifact;
a broken intermediate commit is not required to preserve that observation. Physical iPhone
qualification remains unproven, as listed below. No claim of automatic device trust is made.

## Limits and next integration

No physical phone/laptop, real tailnet certificate, Windows or macOS run was performed. Supplied
certificate loading is implemented; issuing certificates through Tailscale and the device trust
experience still need their own qualification. The desktop webview requires OS certificate
trust and was not exercised here. Accounts sharing one OS user do not isolate that user's files;
the sharing screen states that limitation.

At the last fetch, `origin/main` is `7da1c03e3`; the Phase 4b report is absent there. The network
wrapper accepts a private axum router so the package host can sit behind the same boundary when
that phase lands. This task neither substitutes built-in modules for packages nor changes the
download registry design. Phase 4b integration is not claimed as tested.
