# Rust server/app slice 16: native Linux local creation checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-157 / Card 563. Category: N/A.

## What this checkpoint provides

The assembled native Linux app has been exercised through This computer with an empty data
folder: it creates its database using the existing Phase 1 supervisor, starts its local HTTPS
server, opens sign-in, creates an owner through the real form, signs out, signs back in and loads
Today. No product Rust code needed changing on this path. Today still shows the existing shell's
labelled sample content; this does not qualify real Today data or module integration.

`test:rust-linux-creation` reuses the slice 15 scratch-root desktop assembly. It checks the fresh
cluster, applied migrations, verified HTTPS hello, setup becoming complete after the native form
submission, and pgvector. It captures cropped real UI images at each step, including returning
sign-in, Today and the account name. These images require visual inspection: the tool does not
make semantic DOM assertions that sign-out, sign-in or Today succeeded. Its passing exit code
alone must not be cited as proof of those UI outcomes. No network responses are substituted.

The fixture explicitly focuses the native window in the minimal test desktop. The
fixture uses keyboard activation for form links because pointer link activation did not reliably
work in this window-manager-free desktop. Normal-desktop pointer behavior remains unqualified. An initial replay assumed the running origin
always used the numeric loopback address; the app correctly advertised localhost instead. The
proof now accepts either loopback name and verifies the certificate against the numeric address.
These are proof-fixture limitations; this checkpoint makes no production-app pointer fix.

## Assembly and qualification boundary

The explicit inputs are the slice 14 app/server/supervisor and web build, assembled with the
slice 15 desktop stage and its Phase 1 PostgreSQL bundle. The app, server, network, supervisor
and shell UI sources have no changes since that build's checkpoint. No new Rust compilation or
Rust test result is claimed. The proof creates a new ordinary-uid scratch root, with no host
mounts and no external network. The app chooses its normal port inside that namespace; no host
port is published. The database and server are removed with the disposable container at exit.

Software rendering and compositing disabled, the explicit Xvfb/X11/D-Bus test desktop, and the
fixed-path WebKit payload remain the slice 15 boundary. No sandbox-disable flag is set. Logs
still report missing optional GStreamer appsink and an empty GnuTLS system trust store in that
root; the pinned local certificate path works. Public OS certificate trust, media and a general
installer are not qualified. The task's browser failed Chrome sandbox startup; screenshots here
are from the actual native WebKit app in the task-owned test desktop.

## Checks

Packaging tests pass all twelve cases. The proof's missing-WebKit-helper negative control fails
before the helper is restored. The final keyboard-driven local creation replay passed through verify-gate; its sign-out,
returning sign-in and Today captures were visually inspected. Project static results are recorded
in the task's proof artifact and PR. Proof files and generated account,
database and tool output stay outside the repository.

## Left unbuilt, in order

1. Server/module-worker reminder scheduling and durable server-side acknowledgements.
2. An independent notification process surviving app quit and saved-server activation routing.
3. Windows supervisor assembly and Stop under an ordinary account, before enabling app creation.
4. Normal-desktop pointer link qualification, full Linux desktop-login autostart,
   hardware/composited rendering, target-root installation
   and removal integration, and general clean-machine installation.
5. Native macOS/Windows app and certificate qualification, operating-system public certificate
   trust, physical second-device LAN/tailnet HTTPS proof, signing, updates and production installers.

No rustls-platform-verifier or new dependency was added. Workshop and Food remain unported.
This is a local UI qualification checkpoint; section 13 parity remains incomplete.
