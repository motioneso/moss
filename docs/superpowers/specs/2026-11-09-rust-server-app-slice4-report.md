# Rust server and app slice 4 checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A.

This checkpoint builds on slice 2 (#4095) and merged slice 3 (#4104). It adds native desktop
backends and connected notification delivery and stages an unsigned Linux installation. It does
not close section 13 parity. Workshop and Food are not ported.

## Built

- Windows: a Win32 notification-area icon, restore and Desktop settings actions, recovery when
  Explorer restarts, current-user login registration per app data folder, and notification
  balloons through Shell_NotifyIconW.
- macOS: an AppKit menu-bar item with Open Moss and Desktop settings, a per-user LaunchAgent for
  each app data folder, and native notifications. OS permission and an installed app bundle are
  still needed for delivery.
- Connected notification delivery: the selected server web profile polls every five seconds.
  Existing unread items and replies are quiet on first load and account changes. New unread
  notifications and assistant replies produce generic banners only while the server page is in
  the background and desktop notifications are allowed. Reading notifications is unchanged.
- An authenticated, actor-scoped, no-store endpoint returns unread notification identities;
  notification and chat text is not put in desktop banners. The native IPC bridge accepts only
  notice kinds from the selected server origin and ignores results from a previous server.
- `rust-spike/shell/tools/stage-install.py` assembles already-built app, server, database
  supervisor, web assets, a Phase 1 PostgreSQL bundle and schema in a new folder. It reads the
  canonical migration directories from the supervisor, checks required executables/extensions,
  rejects bundle links escaping the installation, and writes a SHA-256 inventory. This is an
  unsigned staging step, not a signed distribution installer.
- App-map declarations and the split design describe the actual controls and remaining limits.
  No third-party dependency was added. The existing Foundation dependency enables its required
  `std` feature explicitly.

## Checks and live proof

- Independent `cargo check` for the production native API source passes for
  `x86_64-pc-windows-gnu` and `aarch64-apple-darwin`. The small native-check package compiles those
  exact source files without the server's C/TLS dependencies; it does not replace a native run.
- Full app cross-checks were attempted. Windows stops in the existing ring build because MinGW
  GCC is absent; macOS stops in the existing Objective-C helper because there is no Apple-capable
  compiler/SDK. Neither full app cross-build is claimed passing. Those toolchains would enable
  full builds; none was installed.
- Linux app/server build and 21 native app tests passed before the final live proof additions.
  JavaScript notification tests pass for initial silence, new-item delivery, duplicate polls,
  focus suppression, account changes and sign-out.
- Full project checks, fresh staged provisioning, live two-app HTTPS proof and independent
  review are in progress at this checkpoint draft. Final results will replace this paragraph.

## Left to full section 13 parity

1. Windows local setup and Stop remain unavailable. The canonical Phase 1 database supervisor
   uses Unix sockets, flock, Unix process enumeration and signals, crash-dump controls and
   pre-exec hooks; it needs the designed Windows transport, process lifecycle and ACL work.
   The app's start lock and server executable naming also need Windows qualification. This
   checkpoint deliberately does not build a second database provisioner or fake shutdown with
   forced termination. A full Windows supervisor port is a separate context-sized slice.
2. Native macOS/Windows runtime proof for tray lifetime, login/logout, notification permission,
   bundle identity and pinned web-view certificates; full linked cross-builds and signing.
3. An end-user installer and update/uninstall behavior, app bundle metadata, packaged OpenSSL
   or replacement certificate generation, bundled shared-library closure, and Phase 7 signing.
   The staging step expects the existing Phase 1 PostgreSQL bundle and built web/program files.
4. Notifications after quitting or disconnecting, background delivery for servers that are not
   open, OS click-to-open routing, and durable delivery acknowledgement. Chat polls the existing
   shell thread; it does not supply a missing reminder scheduler or port module workers.
5. Real second-physical-device proof. A second app using this box's non-loopback LAN HTTPS
   address proves the remote flow on the same host; it is not proof of another physical device.
6. Operating-system public-certificate trust. `rustls-platform-verifier` remains unapproved and
   was not added. It would let the native hello/probe validate a public certificate's chain,
   hostname, validity and platform trust decisions against the OS trust store (including local
   enterprise roots), so a trusted public endpoint need not require manual leaf-pin confirmation.
   It would not replace self-signed fingerprint comparison, bypass pin mismatches, configure
   Sharing, install a CA, fix a wrong origin or qualify the web views' certificate paths.

## Tracking

The connected Vikunja search has no JS-110/slice 4 card. Its numeric task 110 is not assumed to be
this work, and no unrelated card was changed. Herdr tracks this checkpoint and acceptance.
