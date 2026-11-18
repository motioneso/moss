# Rust sign-in and network boundary

JS-44, Card 520, part of #4027. The server requires this HTTPS boundary for browsers, phones and
the desktop app. There is no plaintext or unsigned-in runner mode.

Build with the repo's Rust toolchain:

```sh
cargo +1.95.0 test --manifest-path rust-spike/network/Cargo.toml
cargo +1.95.0 build --manifest-path rust-spike/shell/Cargo.toml -p moss-shell
```

Keep configuration and credentials outside `~/Jarv1s`, vaults, agent homes and exports. Use a
private directory (`0700`) and owner-only files (`0600`) on Unix. Windows deployments must apply
user-only ACLs through the installer; that platform has not been qualified by this Linux run.

Network configuration (addresses below are documentation examples; obtain a development port
with `devports claim`):

```json
{
  "listen": "0.0.0.0:5180",
  "origins": ["https://localhost:5180", "https://127.0.0.1:5180", "https://moss.example:5180"],
  "sharing": false,
  "certificate": "/private/moss/certificate.pem",
  "private_key": "/private/moss/key.pem",
  "credentials": "/private/moss/credentials.json"
}
```

The credential file has four fields, provisioned by the installation's secret store:
`app_url`, `auth_url`, `auth_secret` (at least 32 random characters) and `connector_key` (the
existing connector encryption key). Database roles must be `jarvis_app_runtime` and
`jarvis_auth_runtime` with `NOBYPASSRLS`; startup verifies both. No database URL or signing key
is accepted on a command line, exposed to pages, or copied from the environment by this entrypoint.
This file is the headless-service handoff; a desktop keychain provisioning screen remains with
the installer phase. Run the existing migrations through the installation database lifecycle.

## Certificates

- **Local:** `moss-network local-certificate <new-private-folder> <https-origin> [...]` makes a
  thirty-day self-signed certificate with an exact SAN for each configured hostname/IP. It uses
  an already installed OpenSSL command, and never installs software or machine trust roots.
  Verify the public certificate's fingerprint locally and on the other device before trusting
  it there. Transfer the public certificate only; keep `key.pem` on the host. Renew by generating
  a new private folder, updating the configured certificate/key, and restarting Moss. Browsers
  warn until trust is established; do not bypass warnings on an unverified remote certificate.
- **Tailnet:** the operator obtains a certificate using their existing Tailscale certificate
  workflow, then configures the resulting certificate/key and exact HTTPS tailnet origin.
  Include loopback as an origin for setup/recovery; if that certificate does not cover loopback,
  first perform local setup with a local certificate, then switch certificates and restart.
  This task does not change tailnet ACLs, run Tailscale Serve, or terminate TLS at a proxy.
- **Your own:** configure a PEM chain and matching private key whose SANs cover the addresses
  people use. The server accepts normal CA-signed certificates and validates the key pair at
  startup. Certificate renewal is an operator task in this slice.

## First run and sharing

Run `moss-shell serve --network <configuration> --web <built-shell-web-folder>` and visit a
configured loopback address. Create the first administrator at `/setup`. Setup refuses remote
peers and remote authorities, even with sharing enabled, and closes once an owner exists. Further
account registration is deliberately closed at this entrypoint until People management is ported.

At `/settings/sharing`, an authenticated administrator enables LAN/tailnet access. The switch
persists before taking effect. Off refuses remote peers **and** non-loopback authorities, even
on existing connections. Binding all interfaces is permitted while off so the switch can work
without a restart; TCP/TLS handshakes may still reach the listener. A loopback-only bind remains
local even with the switch on. Firewall rules and external reachability remain operator choices.

Every request checks an exact Host authority. Every state-changing request requires an Origin
equal to that authority's configured HTTPS origin. Forwarded headers confer no trust. Sign-in
uses five attempts per peer (IPv6 /64) and one hundred per minute for remote peers, with a
separate local budget. Incomplete sign-in bodies time out after three seconds before taking one
of four password-check slots; auth bodies are limited to sixteen kilobytes. Remote connections
cannot consume the local connection reserve. Browser sessions use the existing signed Secure, HttpOnly, SameSite=Lax cookie;
the response body's user fields are explicitly allowlisted. Sign out revokes the stored session.
Unknown routes, static app files and private pages are behind the same authentication boundary.

The shell still labels Today as sample data. Its sample conversation and runner account are
selected by the authenticated actor, never a global `local` account. This phase adds no modules.

Database/live checks must run through `scripts/run-gate.sh start --gate rust-spike/network/tools/gate.sh`.

The app map is built separately for each runtime: `pnpm build:app-map` describes the existing
TypeScript app; `pnpm exec tsx scripts/build-app-map.ts --rust` writes `dist/rust-app-map.json`
with the new Rust-specific declarations. The TypeScript lookup service also filters Rust
entries from mixed or stale artifacts. The Rust assistant's map consumption remains a later
integration, alongside the module host.
