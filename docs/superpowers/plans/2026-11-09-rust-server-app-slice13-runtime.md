# Rust server/app slice 13: Linux server runtime checkpoint

Part of https://github.com/motioneso/moss/issues/4027. JS-146 / Card 555. Category: N/A.

Continue slice 12 in the approved order, stopping at a small, independently reviewable
Linux packaging checkpoint. The first checkpoint closes the **headless server** runtime,
not the native WebKit app. Native desktop runtime packaging remains part of the first
remaining parity item; do not start reminders or Windows assembly ahead of it.

1. Extend the existing unsigned staging tool, reusing the Phase 1 schema inventory and
   database supervisor. An explicit Linux server option copies ELF dependencies for the
   server, supervisor, PostgreSQL programs and loadable extensions, plus the existing
   OpenSSL executable and a public CA bundle. It does not install or download dependencies.
2. Supply an environment launcher that retains the programs' real executable identities,
   isolates the runtime library search path and selects the bundled OpenSSL configuration
   and CA files. The target still needs the build platform's ELF interpreter ABI and a
   POSIX shell. This is not a cross-distribution compatibility claim.
3. Supply a Python maintenance command removing only unchanged inventory entries. Refuse
   live install executables, path escapes, redirected directories and changed files before
   deletion. Preserve unlisted files, including instance folders placed inside the install.
   Quit the app, disable start at login and stop servers before uninstalling.
4. Test the staging/uninstall failure boundaries and exercise real server/database/OpenSSL
   programs in a clean root without host library mounts. Record exactly which startup and
   certificate operations ran; a version command alone cannot prove database provisioning.
5. Run project checks, obtain a fresh read-only Claude review, publish a recipe proof,
   push a checkpoint PR and list everything still unbuilt before Ready to Playtest.

No rustls-platform-verifier or new third-party package. Workshop and Food remain unported.
Reminder scheduling, acknowledgements, a notification process surviving app quit, saved-server
activation, live This computer creation, Windows assembly and non-Linux trust qualification
are outside this checkpoint. Full section 13 parity is not claimed.
