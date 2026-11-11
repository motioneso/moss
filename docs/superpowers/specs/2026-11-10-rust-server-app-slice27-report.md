# Rust server and app, slice 27 report

Part of https://github.com/motioneso/moss/issues/4027. Release note: Category N/A.

## What changed

- The app now sets up, starts, stops and restarts a whole local server (database plus web server) on Windows.
  - Setup makes the instance folder, a local certificate, the database and the server's credentials.
  - The database keeps one fixed port per instance on Windows (saved in `database.port`). Before this, every restart picked a new random port and the saved database address went stale, so the server refused to start the second time.
- Three Windows bugs found by the real runner are fixed.
  - Saving a private file renamed it while it was still open, which Windows refuses. The file is now closed first, the rename retries briefly, and a stubborn case falls back to an in-place write.
  - The web server crashed while shutting down on a stop request, because a timer was built outside the async runtime. It now builds inside it.
  - A failed secure start now prints its reason in the server log.
- Setup failures in the app now print which step failed (certificate, folder, lock, port, file write).
- The database supervisor's crash case is covered on Windows. After a forced kill of the supervisor, the database process dies with it, a restart recovers, and a row written before the crash is still there.
- The proof checks `check` and `hold` now run over loopback TCP, so they work on Windows. `at-rest` stays Unix only.
- The CI workflow `rust-windows-supervisor.yml` now also builds the web server and the app and runs the lifecycle proof as a throwaway standard user.

## Proof

- Windows runner, standard user, real Postgres with pgvector, real migrations. The app's own setup, start, stop and restart functions ran twice in a row (first start, then restart). Each round checked the server answers over HTTPS, the server process is alive, stop ends the process, the address stops answering, and the database is stopped. Output line: `WINDOWS APP LIFECYCLE PROOF: setup, start, stop, restart, stop all passed`.
- Windows runner, supervisor: init, up, status, stop, restart, crash cleanup, crash recovery, stop. Output line: `WINDOWS SUPERVISOR PROOF: init, up, status, stop, restart, crash cleanup, crash recovery, stop all passed`.
- Real browser on Linux, real HTTPS server, the real built web app, an installed Tasks module, a real signed-in account with sample data. The Tasks entry in the sidebar opens the Tasks page inside the module frame, and the page shows its filters and list. Screenshots stay in scratch and the proof artifact carries the crop.

## Not proven

- The app's own Start, Stop and Restart buttons were not clicked on Windows. The proof calls the same two functions the buttons call. No Windows runner can drive the desktop window here.
- A page opened from an alert link was not clicked. The browser proof opens the installed module page from the sidebar entry, through the same module frame the alert link lands on. The alert-to-page path itself is covered by earlier slices.
- A real click on a real macOS alert with no notifier running. No Mac runner exists. The steps for Ben are below.
- `at-rest` has no Windows version. The plan is a disk-encryption query (BitLocker status for the data drive) that reports encrypted, not encrypted, or unknown. The query needs administrator rights, so it needs its own throwaway-admin runner step and a decision on what a standard user sees.
- A real Windows install must ship its own copy of `openssl`. The proof used the copy that comes with Git on the runner. Without one, setup stops with the "needs openssl" message.
- The Windows proof database address works only on the same computer (loopback). Phone and LAN access on Windows is not exercised.

## For Ben on the MacBook

The Linux click script uses a stand-in alert service, so it cannot stand in for this check. The check needs the Moss app installed on the Mac, with a connected server that can raise an alert with a link.

1. Quit Moss and anything named moss-app in Activity Monitor, so no notifier is running.
2. From another device, make the server raise an alert that carries a link (any notice with a link to a page).
3. Wait for the alert to appear on the Mac, then click it in Notification Centre.
4. Moss should launch and open the linked page.
5. If it opens the home page, or nothing opens, that is the failure to report, with the time of the click.
