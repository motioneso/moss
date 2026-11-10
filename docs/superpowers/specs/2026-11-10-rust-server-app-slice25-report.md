# Rust server and app, slice 25 report

Date 2026-11-10. Card JS-208. Part of https://github.com/motioneso/moss/issues/4027.

## What was built

| Piece                        | State                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Windows alert click          | Built. The notifier owns a hidden tray icon. A balloon click (NIN_BALLOONUSERCLICK) hands the alert's server and page to the window app.  |
| macOS alert click            | Built. The notifier registers a notification-center delegate. A click reads the server and page from the alert and hands them to the app. |
| Windows stop file on Windows | Proven on a hosted Windows runner against a real HTTPS server: a stale file is ignored and a file naming the server's process stops it.   |
| Pages behind alert links     | Proven live on Linux against the real web build (not the fixture page). See Proof.                                                        |

## How it works

- `notifier_session` gives the headless notifier what each platform needs to hear a click: a hidden tray icon on Windows, a delegate plus a pumped run loop on macOS.
- `notify_link` remembers the server and page with the alert. A click calls `link::open`, the same hand-off Linux uses (path rule, window lock, 60 second limit).
- The CI workflow now also triggers on changes under `rust-spike/network/**`.

## Proof

1. Runner jobs on Ubuntu, Windows and macOS all pass (run 42882732644), including the Windows balloon-click test, the Windows stop-file test and the page-link hand-off test.
2. `pnpm test:rust-click-live` through the gate script, with the real web build served by the real server and the real app window:
   - a click with no window open starts the app and consumes the request;
   - after signing in, a click moves the open window to the Modules page, then Tasks, then back to Today, with no second window;
   - screen thumbnail distances: Today vs Modules 32.0, Modules vs Tasks 38.8, Today vs the return to Today 0.005;
   - a second launch exits and leaves one window;
   - a stop request naming another process leaves the server up, and one naming it stops it.

## Not proven

- A physical click on a real Windows or macOS desktop. The Windows test sends the balloon-click message to the hidden window. The macOS test calls the delegate directly.
- Real desktop alert services. Linux uses a stand-in with the same message interface.
- The macOS cold start from a click when no notifier is running.
- The Tasks link opens the "Not built in the Rust app yet" page on this branch. Installed module pages behind links were not rendered.
- The pages were identified by screen picture distance and read by eye, not by text.
- The Windows supervisor assembly is still not built.
