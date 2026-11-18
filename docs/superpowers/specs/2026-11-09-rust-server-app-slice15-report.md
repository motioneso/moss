# Rust server/app slice 15: native Linux resource checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-154 / Card 562. Category: N/A.

## What this checkpoint provides

Unsigned staging now has a separate `--linux-desktop-runtime` option. It includes the existing
app/server/database runtime plus WebKit's three helper programs and injected bundle, a GIO TLS
backend and its module cache, compiled schemas, MIME cache, basic fonts and a Mesa software
renderer with the EGL/GLES libraries WebKit loads dynamically. The server-only runtime option
retains its previous boundary. No dependency was installed and no Rust source was changed.

The host's release WebKit has absolute helper paths compiled into it. A live execution trace
showed the staged WebKit library still launching host helpers at those paths. Desktop staging
therefore records an explicit target-root payload under `runtime/rootfs`, with its absolute
installation paths in closure metadata. A root assembler deploys those files into its new root;
staging itself never changes host system directories. The launcher reports missing helper files
before launching the app. It does not verify the version of helpers already present on a host.

Other desktop data and the software renderer are selected from the install by `moss-run`.
This remains a build-platform ABI checkpoint, not a relocatable desktop bundle or a general
installer. The ordinary-owner uninstaller inventories and removes the staged payload, not copies
that an assembler deployed outside the installation. A future installer must own that lifecycle.
The app map describes the payload and these limits.

## Live evidence and checks

The native app's real first-run screen rendered in an isolated scratch Docker root with no
host mounts, no external network and ordinary uid 1000. The explicit test desktop contains Xvfb,
X11 utilities and a D-Bus session, not a host desktop mount. Software rendering uses compositing
disabled, with portal/accessibility services omitted. No sandbox-disable flag was set. This does
not qualify hardware rendering or every Linux desktop environment.

An initial missing-helper negative control reproduced WebKit's native abort (exit 133). During
assembly, restoring helpers exposed missing Mesa and GLES inputs, which are now staged. The
final launcher instead refuses a missing helper with a clear target-root payload error.

In the assembled native app, the real Desktop settings button saved Start Moss at login. After
quitting, GLib's desktop-file launcher parsed that generated entry and relaunched the app through
`moss-run`, preserving its selected data and install paths. To reach Servers without provisioning
a database, this isolated settings case used a separate app data folder containing a stale
last-server reference and an empty saved-server list. It is a desktop-settings qualification,
not evidence of This computer creation, a working remote connection or a real desktop login.

The automated `test:rust-linux-desktop` proof assembles and removes its own clean root. It records
a missing-helper control, native window/process checks, logs and a cropped screenshot for visual
inspection. Early proof-fixture attempts stalled because its minimal D-Bus policy allowed
sending but not receiving replies; the isolated test bus now allows replies. Those failed runs
are not passing evidence. The task browser also failed its own Chrome sandbox startup; native
WebKit UI evidence uses the task-owned Xvfb and real pointer/keyboard actions instead.

Packaging tests pass all twelve cases, including desktop payload dependencies and the launcher's
resource selection. No new Rust build or Rust test result is claimed: this packaging checkpoint
uses the existing slice 14 app/server/supervisor and web build as explicit assembly inputs.
The full foundation/database gate, CI and physical second-device proof are not claimed.
Proof artifacts, tool logs and generated data remain outside the public repository.

## Left unbuilt, in order

1. Full desktop-login autostart qualification, hardware/composited rendering, target-root
   installation/removal integration and general clean-machine Linux installation. This checkpoint
   demonstrates the software-rendered root and generated-entry launch, not all of those paths.
2. Creation and start through **This computer** in that assembled native Linux app. The previous
   function-level lifecycle proof is not the requested UI qualification.
3. Server/module-worker reminder scheduling, durable server-side acknowledgements, an independent
   notification process surviving app quit, and saved-server activation routing.
4. Windows supervisor assembly and Stop under a standard account before enabling app creation.
5. Native macOS/Windows app and certificate qualification, operating-system public certificate
   trust, physical second-device LAN/tailnet HTTPS proof, signing, updates and production installers.

No rustls-platform-verifier was added. Workshop and Food remain unported. Section 13 parity
remains incomplete; continue Linux qualification before reminder work.
