# Moss Computer: isolated offline candidate

Internal qualification for #3578, part of #3577. This is not an installer or a
shipped Moss capability. See the [spec](../../docs/superpowers/specs/2026-10-23-moss-computer-persistent-desktop.md)
and [plan](../../docs/superpowers/plans/2026-10-23-moss-computer-isolated-qualification.md).

Reuse Debian's Xfce, TigerVNC, noVNC and Firefox ESR packages plus the hash-pinned
Websockify 0.13 wheel (Debian's 0.10 lacks its Unix listener). The
desktop is unprivileged, has no network, and exposes its viewer through a Unix
socket. A separate unprivileged Nginx container serves immutable packaged viewer
assets over authenticated HTTPS/WSS on a reserved loopback port. Its read-only
socket mount contains no gateway keys or host sockets. Client certificates here
are synthetic proof identities; they do not implement Moss ownership checks.
Only the trusted gateway has a bridge network and loopback-published listener;
the desktop has no bridge, route or published port.

Build locally from this directory, record the resulting image ID and package
inventory, and use that ID for both services. Apt inputs are mutable: the base
pin alone does not promise build reproducibility. No AI provider is involved.

An attended proof prepares dedicated directories for persistent home, sockets and
gateway configuration outside the repository, with mode 0700 and UID/GID 1000.
Generate an ephemeral proof CA, owner client and server certificate there. Render
only `${COMPUTER_PORT}` in `gateway.conf.template`; preserve Nginx variables.
Never reuse a real client credential, browser profile, Moss data or production
network. Do not commit generated credentials or runtime data.

Set the required `COMPUTER_*` variables shown in `compose.yaml`, use `devports`
to reserve the loopback port, and inspect the fully resolved configuration before
launch. Launch only while an independent fail-closed supervisor and active finish
operator cover the run. The supervisor must stop both labelled services on
deadline, lost heartbeat, measurement failure, data threshold or low host
headroom. A 10 GiB sampled data threshold is monitoring, not a quota; reserve at
least 20 GiB additional free space as overshoot margin. No unattended run is
authorised by these files. There is deliberately no automatic launcher.

Use noVNC's `vnc.html?autoconnect=1&resize=scale` for desktop/terminal input.
Launch the browser from the terminal with
`firefox-esr --no-remote --profile "$HOME/.mozilla/firefox/moss" file:///opt/computer/fixture.html`.
Verify its actual sandbox before accepting browser use. Do not set sandbox
disabling environment variables, add `--no-sandbox`, or relax container security.

Persistence means the home/profile directory remains when the desktop container
is removed and recreated from the same image ID. Use `Files/` for designated
files. Processes and image-installed packages are not persisted. Disabling means
stop the services, retaining the home. Deleting that home is a separate explicit
operation. Retain it at proof closure; stop/remove only proof containers, stop the
supervisor, release the reserved port and delete ephemeral proof keys.

The offline browser does not establish Internet browsing, Moss auth/session
revocation, download confinement, remote MacBook viewing or supported platforms.
Those remain separate integration/release gates. No automatic production change
or restart is performed.
