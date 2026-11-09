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

- Independent `cargo build` for the production native API source passes for
  `x86_64-pc-windows-gnu` and `aarch64-apple-darwin`. The small native-check package compiles those
  exact source files without the server's C/TLS dependencies; it does not replace a native run.
- Full app cross-checks were attempted. Windows stops in the existing ring build because MinGW
  GCC is absent; macOS stops in the existing Objective-C helper because there is no Apple-capable
  compiler/SDK. Neither full app cross-build is claimed passing. Those toolchains would enable
  full builds; none was installed.
- Linux app/server build and 21 native app tests passed after the review fixes.
  JavaScript notification tests pass for initial silence, new-item delivery, duplicate polls,
  focus suppression, account changes and sign-out.
- Fresh unsigned Linux staging and the ignored live provision test passed through the isolated
  gate: two new instances, real bundled PostgreSQL 17.11, pgvector, schema and running supervisors.
- The first app started the local server, signed in through the real form and reached Today.
  A second app connected to the second server by its non-loopback LAN HTTPS address, compared
  its actual certificate fingerprint, signed in and reached Today. This was the same physical
  host, not a second device. Today still labels its existing sample content.
- With notifications enabled in the scratch preference file and the app restarted, a real
  recipient notification inserted through the runtime database role and a real chat API reply
  produced both native desktop banners while the server page was in the background. A screenshot
  and the matching desktop-bus calls record delivery. The setting toggle itself was not exercised.
  The initial keystroke-driven sign-in attempt failed; the successful run pasted the generated
  fixture credentials without printing them and cleared the clipboard afterward.
- The live gate ended with rc=0 and stopped both servers and databases and released their ports.
  The task browser also opened the remote HTTPS sign-in page (with its test-only certificate-error
  override); that browser result does not establish the native app's certificate checks.
- Full repository check results, native cross-build output, screenshots and independent review
  results are recorded in the checkpoint proof artifact and pull request.

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

## Review follow-up

The first independent Claude review found one major: Win32 tray callbacks and Explorer restart
broadcasts were handled in the message loop instead of the window procedure. Both now run in
the procedure for sent and posted messages. The actual Windows backend cross-build was rerun.
Native Windows runtime proof is still outstanding.

Minor findings addressed: banners have a minimum interval per kind, general notifications use
the title "Moss notification", and unread identities use the notification ID so editing a row
alone does not generate another banner. macOS API comments now explicitly leave compatibility
qualification open. Remaining minor findings below the fix bar are disclosed: Windows balloons
need a working tray icon; the icons are a system Windows icon and a text M on macOS; macOS uses
the deprecated notification API; hidden web-view timers may be throttled; and the shell's
positional chat message IDs can suppress a new reply after a thread reset. Chat polling follows
a successful account/notices response so it shares that account baseline. The staged directory
is intentionally per-user (0700), not a shared system install.
