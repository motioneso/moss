# Rust server and app, slice 24 report

Date 2026-11-10. Card JS-203. Part of https://github.com/motioneso/moss/issues/4027.

## What was built

| Piece                                            | State                                                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Clickable desktop alerts                         | Built on Linux. A notification with a page link offers an Open action. Clicking it opens that page.                                           |
| Saved-server routing                             | Built. The click names a saved server and a page. The app switches to that server and loads the page.                                         |
| One window per data folder                       | Built. A second launch raises the first window and exits. A click with no window running starts one.                                          |
| Stop request file                                | Built. Windows has no stop signal, so the server also watches a file in its folder. It stops only when the file holds its own process number. |
| Windows supervisor assembly                      | Not built. Only the stop route it needs exists.                                                                                               |
| Notification process (quiet hours, links, dedup) | Already built in slice 23. This slice only added click handling to it.                                                                        |

## How the click works

1. The notifier shows an alert and remembers which server and page it belongs to.
2. A click arrives from the desktop. The notifier checks the page path (same origin only, no scheme, no host, no backslash).
3. The notifier writes an open request into the data folder and starts the app if no window holds the window lock.
4. The running window reads the request within 0.4 seconds, raises itself and loads the page. A request older than 60 seconds is dropped.

A window that is already visible is only focused. Showing it again made the app's own "Connecting" screen cover the server page, and the live check caught that.

## Proof

Run with `pnpm test:rust-click-live` through the gate script. It starts a virtual screen, a private message bus, a stand-in alert service, a real server over HTTPS and the real app window. It checks four things:

1. A click with no window open starts the app and consumes the request.
2. After signing in through the window, a click on a second alert changes the window's page, read back from the screen colour of the fixture page, with no second window.
3. A second launch exits with code 0 and leaves one window.
4. A stop request naming another process leaves the server running. One naming the server stops it.

Unit tests cover the path rule, the window lock, the request hand-off and the stop file.

## Not proven

- Clicks on macOS and Windows. Those builds show the alert with no click action.
- The stop file on Windows itself. It was exercised on Linux only.
- A real desktop's alert service. The proof uses a stand-in that follows the same message interface.
- The fixture page stands in for the full web app, so the pages behind each link were not rendered.
