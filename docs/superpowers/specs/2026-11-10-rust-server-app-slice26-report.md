# Rust server and app, slice 26 report

Part of https://github.com/motioneso/moss/issues/4027. Release note: Category N/A.

## What changed

- The database supervisor (`moss-db`) now builds and runs on Windows. `init`, `up`, `status` and `stop` work there.
  - The database starts inside a Windows job object, so it dies with its supervisor.
  - Stop asks the supervisor through a request file in the private run folder, and the supervisor stops Postgres in order with `pg_ctl kill`.
  - Windows serves loopback TCP only, so the Unix socket settings are left out.
  - The first run writes initdb straight into the pinned data folder, with a marker file that shows an unfinished first run.
- The app starts the database supervisor and the server detached and without a console window on Windows, and checks a process id through the Windows process API instead of assuming it is alive.
- macOS: a click that launches the notifier (none was running) now opens its page. The system hands the clicked alert over in the launch notification, and the delegate routes it through the same link opener.
- New CI workflow `rust-windows-supervisor.yml` proves the Windows supervisor on a real runner.

## Proof

- Windows runner, as a throwaway standard user, real Postgres with pgvector built from source, real migrations: init, up (migrated, ready), status shows the supervisor, stop, status shows none, up again (restart), status, stop. All passed.
- macOS runner: the new test builds the launch notification the way the system does and calls the method the system calls. It checks that the page request arrives and that a plain launch opens nothing.

## Not proven

- Start, stop and restart of the whole local server (not just the database) from the app on Windows. The database half is proven. The server half and the app buttons were not run on Windows.
- A real click on a real macOS alert when no notifier is running. The test calls the launch method directly.
- Installed module pages behind alert links, rendered in the real web build. Not started: it needs the browser harness with the compiled web build and an installed module. The server side (sign-in, screen address, screen files) was already proven for People in slice 19.
- Windows database process cleanup after a supervisor crash (the Unix leftover scan has no Windows version yet).
- Windows cannot use Unix sockets, so the app's proof checks and `check`, `hold` and `at-rest` commands stay Unix only.
