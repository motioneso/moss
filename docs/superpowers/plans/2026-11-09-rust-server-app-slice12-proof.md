# Rust server/app slice 12: remote HTTPS proof checkpoint

Part of https://github.com/motioneso/moss/issues/4027. Task JS-145 / Card 551.
Release note Category: N/A.

The first checkpoint qualifies the existing native app against a real HTTPS server from a
separate network namespace. It precedes any further packaging, notification or Windows work.

## Procedure

1. Use the merged slice 11 implementation. Build the native app, server and WebAssembly shell
   with task-owned Cargo home, rustup home and target directories. Install only dependencies
   already declared in the project.
2. Start the server against a fresh database through `scripts/run-gate.sh`. Create a throwaway
   owner and certificate, enable Sharing, and retain the public certificate code for comparison.
3. Run the native app in a Docker bridge network namespace using the host's existing libraries.
   Give it a separate app data directory and a task-owned virtual display. Record both namespace
   identities. This qualifies network separation, not a clean-machine installation.
4. Add the remote HTTPS address through the native app, compare the displayed code with the
   server's Sharing screen, confirm it, sign in through the real page and open Today. Record
   real screenshots and bounded textual evidence; never mock the server responses.
5. Publish a recipe proof artifact with explicit limits. Run the relevant checks, commit a
   checkpoint report, obtain an independent read-only review and submit Ready for playtest.
   Stop the task-owned processes and release its ports.

## Checkpoint boundary

This work does not qualify Linux shared-library/OpenSSL/certificate packaging or uninstall,
notifications after app quit, the server reminder scheduler, server-side delivery receipts,
Windows supervisor assembly, or macOS/Windows runtime behavior. No new dependency or
`rustls-platform-verifier` is approved by this plan. Workshop and Food remain unported.

Proof artifacts stay outside the repository. Public reports omit private network addresses,
credentials and local machine details. Today currently renders labelled sample shell data;
loading it does not prove module data parity.
