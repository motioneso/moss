# Rust server and app slice 12 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A. Task JS-145 / Card 551.

## Qualified in this run

The real Linux native app connected to the real HTTPS server from a separate Docker bridge
network namespace. This closes the slice 12 **separate-network-namespace** acceptance path,
not physical second-machine or installer qualification. Product code is unchanged from merged
slice 11 (`431ad0d38`); this checkpoint adds the plan and acceptance report.

The published Herdr recipe proof is `rust-port-server-and-app-b9a6`, titled
**Rust port: server and app slice 12 · Proof**. It contains current screenshots, executable
assertion output, live socket/namespace evidence and the successful database harness receipt.
Private network addresses and proof images stay outside this public repository.

The actual sequence was:

1. Build the server, native app, WebAssembly UI and binding helper with task-owned Cargo home,
   rustup home and target directories, using existing declared dependencies offline.
2. Start a fresh database through `scripts/run-gate.sh`, run its migrations, create a throwaway
   owner through the real setup API and enable Sharing through the real authenticated API.
   The server used a newly generated, self-signed certificate covering its configured origins.
3. Start the native app with a new data folder inside a Docker bridge namespace. Record that
   its network namespace differs from the server's, then choose **Another computer** and enter
   the server's configured LAN HTTPS address through the native window.
4. Sign in to the server's Sharing page in the task browser. Compare all thirty-two certificate
   bytes copied from the native comparison screen with the Sharing DOM and the generated public
   certificate. The executable comparison passed. Choose **It matches** in the native app;
   verify its saved remote origin and pin match what was displayed.
5. Sign in through the native app's real remote sign-in page. Today rendered with the new
   **Namespace proof owner** account and the explicit **SAMPLE DATA** label. Assertions against
   text copied from that native window found the owner name, Today content and timeline heading.
   Live socket inspection showed HTTPS connections from the app namespace to the server's LAN
   address. No server responses were intercepted, rewritten or mocked.
6. End the proof harness normally. Its gate receipt reports `DONE rc=0` and removal of the
   throwaway database container.

## Runtime and verification boundaries

The native app used the host's installed filesystem and libraries mounted read-only into an
existing Docker image, with its own writable data directory and virtual display. The harness
allowed `SYS_ADMIN` and disabled Docker's seccomp filter. It did not explicitly disable the
native app's WebKit sandbox; this run makes no sandbox-isolation claim.

The local task Chromium browser needed `--no-sandbox` and ignored the local test certificate.
Those launch options had to be supplied consistently on every task-browser command. The native
remote app used its ordinary certificate-comparison and pinning path. An initial harness run
aborted when the local proof browser could not start; the successful run used a fresh database,
owner, certificate and app data folder. The proof records the successful run's code and result.

Native app/server and WebAssembly builds passed. The native app suite passed **24 tests**, with
**one provisioning test ignored**; notification receipt tests passed **11 tests**. The live
harness is an isolated database run, not `verify:foundation`, CI e2e, or the ignored local
provisioning test. Broader static-check outcomes belong to the PR/proof receipt, rather than
being implied by the native build.

The shell's Today data remains sample data. Seeing the Workshop link in its navigation does
not mean Workshop was ported. No screen, setting or capability declaration changed, so no
app-map edit was needed for this documentation/proof checkpoint.

## Left to full section 13 parity

1. Linux runtime shared-library/OpenSSL/certificate closure and uninstall preserving user
   instances. This namespace harness reuses host libraries and does not qualify clean-machine
   installation. Signing and updates remain Phase 7 work.
2. The real server/module-worker reminder scheduler, durable server-side acknowledgements,
   an independent notification process after the app quits, and saved-server activation routing.
   Slice 11 receipts remain browser-profile local.
3. Windows supervisor assembly: authenticated runner handshake, startup locks, process identity
   and recovery, initdb password/log I/O, state deletion, orderly PostgreSQL shutdown and Stop
   transport. Qualify bundled PostgreSQL under a standard Windows account, including interrupted
   initialization, multiple instances, crashes and Stop/start races, before enabling creation
   or Stop in the Windows app.
4. Native macOS/Windows app and certificate runtime qualification, and operating-system trust
   for public certificates. `rustls-platform-verifier` remains unapproved and was not added.
5. Physical second-device and tailnet transport qualification. This checkpoint exercised the
   separately permitted network-namespace alternative. Local server creation/start through
   **This computer** was not exercised in this run.

Workshop and Food remain unported. Section 13 remains incomplete. This is a remote HTTPS
acceptance checkpoint, with no packaging, background-notification or Windows enablement claim.
