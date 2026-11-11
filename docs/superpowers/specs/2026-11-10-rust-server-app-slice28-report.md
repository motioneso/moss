# Rust server and app, slice 28 report

Part of https://github.com/motioneso/moss/issues/4027. Release note: Category N/A.

This slice branches from slice 27 and also carries its commits, because slice 27 was still
open when this work started. Items below come from slice 27's Not proven list.

## What changed

- Windows disk encryption check. `moss-db at-rest` now runs on Windows.
  - It checks the drive of each data folder, the paging file ("Swap") and the crash dump setting.
  - An administrator gets the full BitLocker answer. A standard user gets the answer Windows
    shows in its shell for that drive, or "unknown". Unknown never produces an "encrypted" claim.
  - Crash dumps are read from the registry, paging files from Windows management data.
- OpenSSL ships inside a Windows install, in an `openssl` folder beside the app. Setup uses that
  copy first and falls back to the search path only when the folder is missing. Setup no longer
  stops at "needs openssl" on a machine that has none.
- Network address proof on Windows. A new test makes a certificate that names the machine's
  network address, starts the server, and asks it through that address with the app's own
  connect check.
- A script that drives the app window's buttons through the web engine's debugging port. It
  could not run (see Not proven).

## Proof

All on a Windows runner, as a throwaway standard user, against the real HTTPS server and a real
Postgres with pgvector.

- Disk encryption check, as administrator and as a standard user. Output line:
  `WINDOWS AT-REST PROOF: administrator and standard user both answered in the plain form`.
  The administrator run reported the data drive, swap and crash dumps as not protected. The
  standard user run reported "unknown" and claimed no protection.
- App setup, start, stop, restart and stop, with every OpenSSL removed from the account's search
  path and the test asserting that `openssl` cannot be found there. Output line:
  `WINDOWS APP LIFECYCLE PROOF: setup, start, stop, restart, stop all passed`.
- Network address. With sharing off, the certificate was readable through the address, and the
  server answered the app's check with the sharing-off refusal. After turning sharing on and
  restarting, the same address answered as a Moss server. Output line:
  `WINDOWS NETWORK ADDRESS PROOF: refused with sharing off, answered with sharing on`.
- Windows supervisor proof from slice 27 still passes.

## Not proven

- The app's Start, Stop and Restart buttons were not clicked on Windows. The app and its web
  engine start on the runner, and the engine is handed the debugging-port option (its command
  line shows it), but it never opens the port. No answer on the loopback address, `localhost` or
  the IPv6 loopback, and no port file in its data folder. No browser policy is set on the runner.
  Three diagnostic rounds found no cause. The script `windows-buttons-inner.ps1` stays in the
  repo and runs on every Windows job. When the port is missing it reports "NOT RUN" and the job
  stays green. If the port ever opens, the same script clicks the buttons and fails the job on
  any later problem. Restart has no button of its own. It is Stop followed by Open.
- Windows Firewall and a second machine. The network address test runs on the same computer.
  Windows Firewall only filters connections from other machines, so a same-machine request
  through the network address does not exercise it. A phone or laptop on the network is still
  needed. The server listens on all addresses by default, so the firewall prompt and rule are
  the open question.
- The shipped OpenSSL is Git's copy, staged by the proof script. A real release bundle, with its
  own licence notice and update path, is not built.
- The "encrypted" result on Windows is only tested through the parsers. The runner's disk is not
  encrypted, so no live run reaches it.
- A standard user usually gets "unknown" for a drive. A real report to that user will say so.
  Whether that is useful enough, or whether the app should ask for a one-time administrator
  check, is a product decision.
- Pointer clicks sent through a debugging port are not a physical mouse, if that proof ever runs.
- A real click on a real macOS alert. No Mac runner exists. The steps for Ben are in the slice 27
  report.
