# Rust server/app slice 13: Linux headless runtime checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Category: N/A. JS-146 / Card 555.

## What this checkpoint provides

The unsigned staging tool can now collect the headless server, database supervisor and
PostgreSQL ELF dependencies, including loadable extensions, together with OpenSSL, a public
CA snapshot and C.UTF-8 locale data. Its explicit `moss-run` launcher selects that runtime
without changing executable identity. The stage still contains both the app and server.
This is a build-platform ABI checkpoint, not a general Linux installer.

The ordinary-owner maintenance command checks its inventory before removing unchanged install
files. It refuses redirected directories, changed files and detected running install programs,
including a supervisor that disables crash dumps and hides its `/proc` executable link. It
preserves unlisted files and instance folders, even inside the install directory. Disable
start at login, quit the app and stop servers before running it; do not start programs during
uninstall. It is not an atomic lifecycle lock against concurrent launches.

The app map records the headless packaging capability and keeps desktop closure unqualified.
No screen or setting was added. The app's provisioning and autostart paths still launch the
programs directly, so they do not yet select this new runtime launcher.

## Real proof and checks

The clean-root harness imports a scratch Docker filesystem containing the stage and an explicit
shell/interpreter baseline, runs as an ordinary user with no host mounts or external network,
and exercises:

- An OpenSSL command failing when its bundled libcrypto is removed, then succeeding after
  restoration; real RSA certificate generation and parsing of the bundled public CA snapshot.
- The canonical Phase 1 supervisor creating a fresh database, applying schema migrations,
  loading pgvector, and writing and reading data.
- The real server serving HTTPS hello with certificate verification against the generated
  local certificate, followed by orderly server and database Stop.
- Uninstall of a stage containing that real instance, comparing every retained instance file
  by SHA-256 before and after.

The baseline uses the staged libc and interpreter when constructing its prerequisite paths;
it rejects a stage missing either. Other baseline utility dependencies are explicit harness
prerequisites. This is not proof that every possible runtime load or distribution works.
The public CA snapshot is parsed, not tested against a live publicly signed endpoint.

Packaging tests cover changed-file refusal, path/link boundaries, retained data, missing ELF
libraries, OpenSSL operation and protected live-process refusal. The protected-process test
was observed failing against the original executable-link-only guard, then passing with the
fallback. Existing negative-control outputs and current successful runs are retained in the
Herdr proof artifact, outside this public repository.

Task-owned Rust homes and targets were used to build the app, server, database supervisor and
WebAssembly UI. The canonical PostgreSQL bundle build passed. Root lint, root/web/external-module
typechecks, file-size and app-map checks passed. Formatting is checked over tracked files;
a broad filesystem walk encountered transient Python caches and was stopped. The isolated
runtime gate is narrower than `verify:foundation`; CI and full browser e2e are not claimed.

## Review disposition

The first read-only Claude review found a conditional major requiring a passing clean-root
receipt before publishing proof. That receipt passed. Its minor observations prompted use of
the staged libc/interpreter in the harness baseline, preservation of links in the uninstall
copy, and retention of the caller's PATH after the bundled OpenSSL directory. The remaining
minor observations are explicit limits: public CA parsing is not OS trust, app startup is not
wired to the launcher, directory symlinks may remain as unlisted entries, and PostgreSQL
libraries can be duplicated between its tree and the collected closure.

## Left unbuilt, in order

1. Native Linux WebKit app runtime/resources and launcher/autostart integration on a clean
   machine. This remains part of the first parity item, ahead of reminder work. Signing,
   updates and a production installer remain Phase 7 work.
2. Server/module-worker reminder scheduling, durable server-side acknowledgements, an independent
   notification process surviving app quit, and saved-server activation routing.
3. Local server creation and start through **This computer**, exercised live on Linux using
   the assembled runtime rather than host libraries.
4. Windows supervisor assembly and Stop: qualify the assembled lifecycle with bundled
   PostgreSQL under a standard account before enabling Windows creation or Stop.
5. Native macOS/Windows app and certificate qualification, operating-system trust for public
   certificates, physical second-device and tailnet proof. Slice 12's separate-network-namespace
   HTTPS result is not reclassified as physical-device proof here.

No rustls-platform-verifier was added. Workshop and Food remain unported. Full section 13
parity is incomplete. Resume with the Linux native app closure, not reminder scheduling.
