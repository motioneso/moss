# Rust port, Phase 4 part 1: UI shell, Today and the chat drawer

Task JS-40, part of #4027. Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 4 and
section 3.7. Code: `rust-spike/shell/`.

## Summary

- The app frame, navigation, Today and the chat drawer now run in Rust (Leptos, compiled to wasm).
- They use the current app's CSS files unchanged, copied in by a build script. No style was edited.
- Desktop and phone layouts both work: docked chat at wide widths, floating chat below 1280px,
  drawer chat and slide-in navigation on phones, collapsed rail navigation, expanded chat.
- One program, `moss-shell`, serves the app to browsers and also opens it as a desktop window.
  The window uses wry and tao (the system webview).
- Every screen reads sample data through a small interface (`ShellData`) that Phase 2/3 fill in.
  The screens say so: "Sample data" in the top bar, "Sample replies only" in chat.
- The invented-class audit finds no invented class.
- Side by side with the current app, Today and the chat drawer match closely at desktop and phone
  width. Ben's look check is still to do; it is the Phase 4 kill gate.

## What was built

| Part     | Where       | What it does                                                                                                 |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Contract | `contract/` | JSON shapes the screens read, the `ShellData` trait, the sample data behind a `stub` feature                 |
| UI       | `ui/`       | Frame and navigation, Today, chat drawer, as Leptos components with the current app's markup and class names |
| Program  | `app/`      | axum server for the page and four `/api/*` routes; desktop mode opens a tao window with a wry webview        |
| Assets   | `assets/`   | Copies the current CSS in the web app's load order, plus fonts, textures and the theme boot script           |

### Screens

- **Frame:** sidebar with brand, grouped module links, active state, rail mode stored under the
  same key the current app uses, account menu trigger with unread count, top bar with title, date
  and chat button with unread badge. Phone: menu button, slide-in navigation with scrim, close
  button and Escape to close. While open, the phone navigation keeps Tab inside itself and gives
  focus back to the menu button when it closes.
- **Today:** hero (greeting, headline, summary, weather note, briefing note), section links, quick
  actions, day timeline with planned, proposed and calendar rows, closing line, quiet line.
- **Chat drawer:** header with status, expand and shrink (docked, desktop only), close; the thread
  with the newest message kept in view; waiting animation; composer with Enter to send, Shift+Enter
  for a new line, and a send button that stays off while empty or waiting. The thread survives
  closing and reopening the drawer. A failed send shows "Your message didn't send. Try again."
  On phones the drawer keeps Tab inside itself. Closing it gives focus back to the chat button.
  Escape closes only the layer that has focus.
- **Other routes:** every other module link opens a "not ported yet" empty state, so navigation
  works end to end without inventing screens.

### Left out on purpose

| Item                                               | Why                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| News and sports desks on Today                     | Module widgets; they port with their modules in Phase 5                                                        |
| Account menu, conversation list, more-options menu | Inert or switched off with a title saying when they arrive; they need settings and chat history from Phase 2/3 |
| Attachments, voice                                 | Switched off; they arrive with the chat runner port                                                            |
| Opening a task from the timeline                   | Task rows render as plain rows; the task screen ports separately                                               |

## Desktop wrapper: wry and tao

wry draws the page in the system webview (WebKitGTK on Linux, WebView2 on Windows, WKWebView on
macOS). tao opens the window. Reasons over Tauri:

- Moss serves its own page over HTTP, so Tauri's message bridge and asset bundling would go unused.
- Tauri is built on these two libraries, so moving to Tauri later stays a small step.
- No command-line tooling to install. Both crates download into the workspace like any other.
- The Phase 0b report recommended the same pair.

Desktop mode starts the same server on a random port on 127.0.0.1 and points the window at it. So
the desktop app and the browser app are the same build talking to the same routes.

## Reaching Moss from other devices

Ben's rule: Moss must work from a phone, a laptop or another computer on the LAN or tailnet.

| Need                           | This part                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listen beyond this machine     | `moss-shell serve --host 0.0.0.0` listens on every interface. It prints a warning while there is no sign-in                                                                                                                      |
| Screens work from any device   | Every request is a relative `/api/...` path, so the page works from whatever address the browser used. Phone layout is built and checked                                                                                         |
| Several clients at once        | The server holds no per-window state and is safe across threads. The sample chat is one conversation shared by every browser, capped at 200 messages (oldest dropped, with a warning). The real data layer keeps one per account |
| Refuse writes from other sites | The only write route takes JSON. A cross-site form post (plain text) gets 415, and no cross-origin headers are sent                                                                                                              |
| Sign-in and sessions           | Not in this part. The trait is per signed-in account by contract, but no sign-in exists yet                                                                                                                                      |
| Trusted origins and https      | Not in this part. No check of the Host header yet, so a page on another site could reach a loopback server by DNS rebinding. No https listener                                                                                   |

Desktop mode always binds 127.0.0.1 and refuses `--host`. Anyone else signed in to the same
computer could still reach that port while sign-in is missing, so sign-in must land before this
ships.

The server answers 404 for any path whose last part contains a dot, so missing files fail
cleanly. A future screen address with a dot in its last part would need an exception.

## Evidence

Screenshots, page captures and the class lists are in the task's scratch folder, never in the repo.
The proof artifact on the task shows the side-by-side pairs.

### Builds and tests

| Check                                          | Result                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `build.sh` (wasm UI, bindgen, assets, program) | Builds clean, no warnings                          |
| Contract unit tests                            | 3 passed                                           |
| Web build size                                 | wasm 402 KB raw, 151 KB gzipped; CSS 94 KB gzipped |
| Program size                                   | 2.0 MB, one file                                   |

### Browser run (Playwright, served mode)

Run at 1440x900, 1024x800 and 390x844 against `moss-shell serve`:

| Check                                                       | Desktop     | Tablet        | Phone       |
| ----------------------------------------------------------- | ----------- | ------------- | ----------- |
| Today renders                                               | yes         | yes           | yes         |
| Chat opens, sends, gets the sample reply                    | yes, docked | yes, floating | yes, drawer |
| Chat closes                                                 | yes         | yes           | yes         |
| Expand and shrink chat                                      | yes         | n/a           | n/a         |
| Rail navigation                                             | yes         | yes           | n/a         |
| Phone navigation opens, Escape closes, navigating closes it | n/a         | n/a           | yes         |
| Module link changes the address and shows the empty state   | yes         | yes           | yes         |
| Console errors                                              | none        | none          | none        |

A second phone-width run checked keyboard focus. Opening the navigation moves focus into it, Tab and
Shift+Tab stay inside, Escape closes it and focus returns to the menu button. The phone chat does
the same with the chat button. The weather settings link changes the page without a reload, and
Back returns to Today. Unknown `/api/` paths and missing files answer 404; app routes answer with
the app page.

The same routes answered with 200 through the machine's LAN and tailnet addresses, not just
127.0.0.1. That call came from the same machine, so it proves the listener, not a second device.

### Desktop window

`moss-shell desktop` opened a 1360x860 window on a virtual display. The window showed Today drawn
by WebKitGTK from the program's own loopback server.

### Side by side with the current app

The current app was captured from the test copy of Moss with its test account. The pairs differ
only where the data differs (sample day against the test account's day). Markup and classes were
aligned to the current app's rendered page, including the hero and day-grid mode flags the CSS
depends on.

One thing shows up with the sample account name: "Sam Rivera" is cut to "Sam ..." in the sidebar
account button. The current app's CSS does the same with any name that long, so this is the
current design, not a port defect.

### Invented-class audit

- Skill audit on the Rust source (every `jds-*` name against the design system's stylesheets):
  no output, so no invented `jds-*` class.
- Audit of the rendered pages: 164 classes rendered across all states, each checked against every
  selector in the carried CSS. 25 have no rule. All 25 are hooks the current app renders too:
  21 icon classes (`lucide`, `lucide-*`) and `chatd-thread`, `tl-meta-len`, `tl-slot--event`,
  `well__eyebrow`. None is invented.

## Not proven

- **Ben's look check.** This is the Phase 4 kill gate, and only Ben can pass it.
- **A real second device.** No phone or other computer opened the served app. The phone layout was
  checked in a phone-sized browser window.
- **Desktop on Windows and macOS.** Only Linux (WebKitGTK) was run. The code path for other
  systems compiles only on those systems.
- **Desktop on Ben's screen.** The window ran on a virtual display, not a real desktop session, so
  window decorations and display scaling are unchecked.
- **Real data.** Everything is sample data. Nothing here touches the database or the chat runner.
- **Dark and custom themes.** The theme boot script is carried over, but only the default theme was
  captured.
- **Screen readers.** Focus order was checked with the keyboard only, not with a screen reader.
- **Startup time.** Not measured in this part.
- **Timeline times.** The sample timeline uses fixed times, so the "now" marker does not move with
  the clock. The real data layer supplies live times.
- **Stylesheet list.** The build script copies a fixed list of the current app's CSS files in load
  order. A stylesheet added to the current app later is missed until someone adds it to the list.

## How to proceed

1. Ben looks at the side-by-side pairs on the proof artifact and passes or fails the look check.
2. Phase 2/3 implement `ShellData` against the database and the chat runner, then pass it to
   `router()` in `app/src/main.rs` in place of the stub. The sample-data labels then switch off by
   themselves (`sample_data: false`).
3. Sign-in, sessions, a Host and origin check, and https land with the core platform port, before
   this listens beyond loopback for real.
4. Embed the web build into the program (Phase 7 packaging), so one file carries everything.
5. Phase 4 part 2 ports the remaining screens onto this frame. Each needs its own side-by-side
   check and the same rendered-class audit.
