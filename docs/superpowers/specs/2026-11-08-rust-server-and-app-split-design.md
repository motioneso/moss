# Rust Moss: one install, a server and a connecting app

- **Status:** Approved direction (Ben's directive, 2026-11-08). Recommendations below were taken by
  the building agent while Ben was away; each is listed in section 14 for review.
- **Task:** JS-90, Card 198. Part of #4027.
- **Amends:** `2026-11-06-rust-port-plan.md` (2.1, 3.2, Phases 1, 4, 7, 8) and
  `2026-11-06-rust-port-data-and-install-rules.md` (reach settings). Module packages
  (`2026-11-07-rust-module-packages-and-registry-design.md`) are unchanged.

## 1. Summary

Moss installs like Herdr. One install puts two programs on the machine:

| Program | What it is                                                                             |
| ------- | -------------------------------------------------------------------------------------- |
| Server  | The whole of Moss: database, sign-in, modules, jobs, chat, agents, files, AI routing   |
| App     | A window that connects to a server, plus the list of servers this computer knows about |

The app opens and attaches to the server on the same computer without asking. A computer can run
more than one server, each its own instance. The app can connect to a server on another computer
instead, chosen in the app. A MacBook that only ever uses the Linux box needs no separate server
step. The user picks "Another computer" on first run, and no local database is ever created.

This replaces the plan's "thin client as a fallback only" row. Connecting to another computer is a
normal, first-class way to use Moss.

## 2. Two programs

| Topic             | Server                                                     | App                                                   |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Binary            | `moss-shell serve` today, renamed `moss-server` in Phase 7 | `moss-app`                                            |
| Runs              | In the background; keeps running when the app closes       | Only while its window is open (tray later)            |
| Owns              | Data, accounts, modules, jobs, agents, certificates        | Server list, certificate pins, per-server web profile |
| Network           | HTTPS listener per the instance's reach setting            | Outbound HTTPS only; listens on nothing               |
| Database          | Bundled Postgres per instance                              | None                                                  |
| Without the other | Serves phones and browsers as today                        | Connects to another computer                          |

- The server's old `desktop` mode, which opened a window inside the server process, is removed.
  The window moves to `moss-app`.
- A screenless Linux box runs only the server (package, service or Docker image). Nothing changes
  for it.
- Phones keep using the browser. A later phone app is another connecting app with the same flow.

## 3. Finding a local server

### 3.1 Instance folders

```text
<data>/servers/<instance>/network.json    instance configuration (existing format)
<data>/servers/<instance>/running.json    written by the server while it listens
<data>/app/servers.json                   the app's server list and certificate pins
<data>/app/profiles/<server-id>/          the app's web profile for one server
```

- `<data>` is `$XDG_DATA_HOME/moss` (default `~/.local/share/moss`) on Linux,
  `~/Library/Application Support/Moss` on macOS, `%LOCALAPPDATA%\Moss` on Windows.
- `--data <folder>` overrides it, for tests and portable installs.
- The first instance is `default`. Each instance has its own port, database, certificate and
  credentials.
- Every file is owner-only, using the existing private read and write rules (mode 0600, regular
  file, size cap).
- The data folder, `servers/` and each instance folder must belong to this user with no group or
  world write (0700 or 0755). The app refuses a folder made with a 0002 umask (0775). The setup
  that creates them (Phases 1 and 7) must set the mode.

### 3.2 The running file

The server writes `running.json` after it binds its listener and removes it on a clean stop.

```json
{
  "instance": "default",
  "origin": "https://127.0.0.1:5201",
  "fingerprint": "AB: 12: …",
  "pid": 41237,
  "version": "0.1.0",
  "api": { "current": 1, "oldest": 1 }
}
```

The app trusts a running file only when all of these hold:

- owner-only regular file inside the instance folder;
- the origin is `https` on a loopback address;
- the process id is alive;
- the certificate the server presents matches the file's fingerprint.

The last check catches a stale file whose port was taken by something else. Because the file is
owner-only, the app trusts the local server's certificate without asking the user to compare codes.

- No network scan, broadcast or mDNS. Other computers are added by address only.

### 3.3 Starting it

- On open, the app looks for the last-used server. If that is a local instance with no valid
  running file, the app starts it: `moss-shell serve --instance <folder> --web <install>/web`, in
  its own process group so it survives the app closing.
- One app run starts an instance at most once, and a start lock in the instance folder keeps two
  apps from starting it together. An app that quits mid-start leaves no record, so a relaunch may
  start a second server, which then fails to bind.
- The app waits up to 20 seconds for a valid running file and a good hello (section 8), then shows
  the server.
- The server keeps running after the window closes. Phase 7 adds start-at-login, a tray item and
  a Stop button.
- Creating a second local instance is a Phase 7 screen. Until then a second instance is a second
  folder made by hand.

## 4. First run

The app's server list is empty on first run. It shows screen C1 (section 12):

- **This computer** creates the `default` instance, starts it, and opens the server's own owner
  setup page. The database is created only now.
- **Another computer** goes to C2 and never creates a local database or listener.

The installer always installs both programs. It does not ask which one the user wants, because
the choice belongs to the app and can change later.

## 5. Adding and switching servers

### 5.1 Adding another computer

1. The user types the address shown on the other computer's Sharing screen, for example
   `https://192.168.1.20:5201` or a tailnet name.
2. The app connects and reads the server's certificate without trusting it yet.
3. Screen C3 shows the certificate code in the same format as the server's Sharing screen. The
   user compares it with that screen and confirms.
4. The app saves the server with that code pinned, calls hello, and opens it.

The app refuses an `http` address and anything that is not an origin (no path, query or user
name).

### 5.2 Switching

- Screen C4 lists every saved server: local instances and other computers, with their state.
- The app opens the last-used server on launch. Choosing another one switches the window to it.
- Inside a server's pages, the account menu shows "Switch server" only when the page is open in the
  app. The link is `moss-app://servers`, which the app intercepts. A browser never sees it.
- Removing a server deletes its pin and its web profile, which signs the app out of it.

## 6. Sign-in, trusted origins and certificates

### 6.1 Sign-in

- The app never sees a password or a session. Sign-in is the server's own page, shown in the
  window, exactly as a browser shows it.
- The session cookie lives in that server's web profile. Each saved server gets its own profile,
  because cookies are scoped by host and not by port. Two local instances on `127.0.0.1` would
  otherwise share one cookie jar.
- Signing out works as it does in a browser.

### 6.2 Trusted origins

- The app adds no exception to the server's Host and Origin checks. Its requests look like a
  browser's.
- Local: the app uses the loopback origin from the running file, which is always in the trusted
  list.
- Another computer: the address the user types must be one the server lists on its Sharing
  screen. A wrong one fails with "host refused", and the app says to use an address from that
  screen.
- Sharing off: the other computer refuses the app, and the app says to turn sharing on there.

### 6.3 Certificates

| Kind                                | v1 (this design)                             | Later                                               |
| ----------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| Local instance                      | Trusted through the running file             | Same                                                |
| Self-signed LAN certificate         | User compares the code once; the app pins it | Same                                                |
| Tailnet or other public certificate | Pinned like any other                        | Accepted through the operating system's trust store |

- A pinned certificate that changes stops the connection and shows C6. The user compares the new
  code with the Sharing screen before continuing. There is no "continue anyway" without that step.
- A 30-day local certificate or a tailnet certificate renews with a new code. v1 asks again after
  each renewal. The later row removes that for public certificates; it needs a certificate
  verification library the project does not list yet (`rustls-platform-verifier`), which is raised
  here and not added.
- Native checks (hello) use the pin directly. The window's web engine must accept the same pinned
  certificate:
  - Linux (WebKitGTK): allow exactly that certificate for that host on the server's web context
    before loading. A different self-signed certificate on the same host still fails. WebKit also
    accepts any certificate a public authority signed, so on every committed page load the app
    reads the page's certificate and closes the page when it is not the pinned one. By then the
    request, with its cookie, has already gone. The check runs only when a page loads. Requests a
    loaded page makes later (fetch, WebSocket) on new connections are not re-checked, but every
    open and retry runs the native hello against the pin first. These gaps exist only for names
    a public authority will sign, and WebKitGTK offers no earlier hook.
  - macOS (WKWebView): answer the server-trust challenge by comparing against the pin.
  - Windows (WebView2): answer the server-certificate-error event by comparing against the pin.
- The window refuses to navigate to any other origin and opens no new windows in v1. Links to
  other sites open in the system browser in a later slice.

## 7. What runs where

| Work                                               | Runs on                                |
| -------------------------------------------------- | -------------------------------------- |
| Modules and their packages                         | Server                                 |
| Registry downloads and updates                     | Server                                 |
| Jobs and schedules                                 | Server                                 |
| Chat and agents (with that machine's CLI sign-ins) | Server                                 |
| Vault, files and uploads                           | Server                                 |
| AI routing and provider keys                       | Server                                 |
| Screens (WebAssembly UI)                           | Served by the server, drawn by the app |
| Server list, pins, local start                     | App                                    |
| Tray, notifications, mic permission                | App (later slices)                     |

- Connected to another computer, agents run on that computer and use its sign-ins. The MacBook's
  own folders are not visible to Moss. Uploads go through the screens as in a browser.
- Module packages are unchanged by this split. They already run on the Moss host (module spec
  section 6).

## 8. How the app talks to the server

- The app uses the same HTTPS API as a phone or a browser. The screens come from the server, so
  the app holds no copy of the UI.
- The app's only native call in v1 is `GET /api/hello`, which is public and answers:

```json
{ "product": "moss", "version": "0.1.0", "api": { "current": 1, "oldest": 1 } }
```

- Hello still passes the Host check and the sharing switch. It shows a version number to anyone
  who can already reach the server, which is acceptable.
- The API number counts only what the app itself calls (hello now; notifications and tray data
  later). Screen changes need no new number, because the server ships its own screens.

## 9. Updates and versions

- A local install updates both programs together, from one package, and restarts its local
  instances.
- A remote pair works when the app's supported range overlaps the server's `oldest..current`.
  - Server too old: C7 says "Update Moss on that computer".
  - App too old: C7 says "Update this app".
- The server raises `oldest` only when it stops answering an older app. That should be rare,
  because the app's native surface is small.

## 10. When the server cannot be reached

| Cause                           | Screen | What the user can do                       |
| ------------------------------- | ------ | ------------------------------------------ |
| Local server not running        | C5     | Start it (done automatically once on open) |
| Connection refused or timed out | C5     | Try again (also retried automatically)     |
| Host refused                    | C5     | Use an address from the Sharing screen     |
| Sharing off on that computer    | C5     | Turn sharing on there                      |
| Not a Moss server               | C5     | Check the address                          |
| Certificate changed             | C6     | Compare the new code, or cancel            |
| Versions do not overlap         | C7     | Update one side                            |

- Automatic retries back off from 2 to 60 seconds and stop when the user switches server.
- Every screen offers "Switch server".
- There is no offline mode and no writes are queued. Moss data lives on the server.
- If the server stops while a page is open, the window swaps to C5 instead of a web-engine error.

## 11. How the phases change

| Phase            | Change                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Platform floor | A failed kill gate no longer re-cuts the plan. That OS installs both programs and uses another computer                                               |
| 4 UI shell       | The desktop shell becomes `moss-app`. The server loses its `desktop` mode                                                                             |
| 4b, 5, 6 Modules | Unchanged. Modules, jobs and registry run on the server                                                                                               |
| 7 Installers     | One package with both programs; per-instance service or login item; updater updates both; instance and Stop screens; OS trust for public certificates |
| 8 Cutover        | The checklist adds: a second computer connects to the moved server through the app                                                                    |

## 12. Screens

All connect screens are the app's own pages, served from inside the app (`moss-app://`), using the
Park Press tokens and `jds-*` classes from the shared stylesheet. Copy stays short. Widths follow
the auth screens.

### C1 First run

```text
┌──────────────────────────────────────────────┐
│ MOSS                                         │
│ Where does your Moss live?                   │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ This computer                          → │ │
│ │ Keep your Moss here.                     │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ Another computer                       → │ │
│ │ Connect to a Moss you already run.       │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

### C2 Add another computer

```text
┌──────────────────────────────────────────────┐
│ ← Servers                                    │
│ Connect to another computer                  │
│                                              │
│ Address                                      │
│ [ https://192.168.1.20:5201              ]   │
│ Use an address from Sharing on that computer.│
│                                              │
│                              [ Continue ]    │
└──────────────────────────────────────────────┘
```

### C3 Check the certificate code

```text
┌──────────────────────────────────────────────┐
│ ← Back                                       │
│ Does this match?                             │
│ Open Sharing on that computer and compare.   │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ 3F:A1:09:C4:7E:22:B8:51:0D:96:E3:4A:…    │ │
│ │ …:6B:F0:12:8C:D7:45:A9:3E:71:C2:5F:08    │ │
│ └──────────────────────────────────────────┘ │
│ 192.168.1.20:5201                            │
│                                              │
│              [ Cancel ]  [ It matches ]      │
└──────────────────────────────────────────────┘
```

### C4 Servers

```text
┌──────────────────────────────────────────────┐
│ Servers                                      │
│                                              │
│ ● This computer            Running   [Open]  │
│   default                                    │
│ ○ Linux box                Reachable [Open]  │
│   192.168.1.20:5201                 [Remove] │
│                                              │
│ [ Add another computer ]                     │
└──────────────────────────────────────────────┘
```

### C5 Can't reach

```text
┌──────────────────────────────────────────────┐
│ Can't reach Linux box                        │
│ Sharing is off on that computer.             │
│                                              │
│ Trying again in 8 seconds.                   │
│                                              │
│ [ Try again ]  [ Switch server ]             │
└──────────────────────────────────────────────┘
```

The middle line carries the cause from section 10. For a local server the first button is
"Start it".

### C6 Certificate changed

```text
┌──────────────────────────────────────────────┐
│ Linux box has a new certificate              │
│ Compare it with Sharing on that computer.    │
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ 9C:44:…                                  │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│              [ Cancel ]  [ It matches ]      │
└──────────────────────────────────────────────┘
```

### C7 Versions do not match

```text
┌──────────────────────────────────────────────┐
│ Update Moss on that computer                 │
│ This app needs a newer Moss on Linux box.    │
│                                              │
│ [ Switch server ]                            │
└──────────────────────────────────────────────┘
```

## 13. First slice

### 13.1 Scope

- Server: `GET /api/hello`; `serve --instance <folder>` reads its configuration from the folder
  and writes and removes `running.json`; the `desktop` mode is removed.
- App: new `moss-app` crate in `rust-spike/shell/connect`, Linux only:
  - server list and pins in `<data>/app/servers.json`;
  - local discovery and automatic start;
  - certificate probe, pin check, hello and version check;
  - screens C1, C2, C3, C4 and C5, with C6 and C7 as variants of the same page;
  - one web profile per server and the pinned certificate allowed for that host;
  - `moss-app://servers` intercepted from server pages; other origins refused.
- App map: the connect screens and their remediations, checked against the app's source.

### 13.2 Not in the first slice

- Operating-system trust for public certificates. It needs a platform verifier library, which
  has not been approved for install.
- Native runtime qualification of macOS and Windows desktop integration and full background
  notification delivery after disconnecting or quitting. Slice 4 adds native API backends and
  checks for new reminders and replies while a server page is connected, described below.
- Creating a local server on Windows. The database supervisor is unix only, so the app says
  setting up is not available there yet; a hand-prepared instance folder still works.
- A real installer. The app expects `moss-db`, `postgres/` and `schema/` next to it (Phase 7
  ships them); without them creating a server says the copy came without its database.

Built in slice 2: pinned-certificate handling in the macOS and Windows web views (section 6.3);
creating local servers in the app (a "New server here" screen, and "This computer" creates the
default one on first use) through `provision.rs`, which reuses `moss-db` and the network crate's
certificate maker; Stop for a running local server (also stops its database); and the "Switch
server" item in the server's own account menu, shown only inside the app.

Slice 3 adds Linux desktop integration through the existing GIO dependency, with no new crates:
Servers → Desktop settings controls session autostart and opt-in notifications for connections and
stops, and offers a test notification and Quit app. With a StatusNotifier host, closing hides the
window, clicking its tray icon restores it, and the tray context action opens Desktop settings.
Without that host, closing quits the app. If the host disappears, the window is restored so it
cannot be stranded. Local servers keep running when the app quits. This is desktop-session
startup, not a system service or a complete installer.

Setup holds its selected listening port until network.json is written and serializes unfinished
setup cleanup across apps. Stop asks for confirmation, waits for the instance's start lock before
shutting down, shows progress, and reports failure. A late Stop result cannot replace a newer
screen. Windows local setup and Stop remain unavailable; macOS and Windows runtime desktop integration
and certificate qualification remain outstanding.

Slice 4 adds native API backends without new third-party crates: Windows notification-area icon,
current-user Run key and notification balloons; macOS AppKit status menu, per-data-folder
LaunchAgent and native notifications. The backends pass independent Rust checks for their real
targets. Full app cross-builds still require MinGW GCC and an Apple compiler/SDK, and native
runtime delivery is unqualified. On every system, opt-in generic banners cover new unread
notifications and chat replies while the connected server page is in the background. Polling uses
that web profile's session, baselines existing items quietly, and checks every five seconds.
It does not mark notifications read or deliver after the app quits. The unsigned Linux staging
step packages already-built programs, web assets, a Phase 1 Postgres bundle and the supervisor's
canonical schema folders; signing, native installers and Windows database supervision remain open.

Slice 6 adds a Windows suspended/windowless child-process and Job Object boundary with native
qualification tests, as groundwork for the canonical database supervisor. It is not yet wired
into that supervisor; Windows creation/Stop remain unavailable. The full remaining parity list is
in [the slice 6 checkpoint report](2026-11-09-rust-server-app-slice6-report.md).

### 13.3 Proof

- Unit tests: running-file validation (wrong mode, dead process, non-loopback origin, stale
  certificate), version overlap, address parsing, pin match and mismatch against a real local TLS
  listener.
- Live: on a virtual display, the app starts a real local server (throwaway database through the
  gate), opens it, signs in, and reaches Today. A second saved server pointed at this machine's
  non-loopback address goes through C2 and C3, and with sharing off shows C5.

## 14. Decisions taken while Ben was away

| #   | Question                             | Decision                                                              |
| --- | ------------------------------------ | --------------------------------------------------------------------- |
| 1   | One binary or two                    | Two programs, one install                                             |
| 2   | How the app finds a local server     | Owner-only running file per instance folder; no network discovery     |
| 3   | Does the server stop with the window | No; it keeps running like Herdr's server                              |
| 4   | First run                            | Ask "This computer" or "Another computer"; database only on the first |
| 5   | How a remote certificate is trusted  | Compare the code with the Sharing screen once, then pin               |
| 6   | Separate sign-in per server          | Yes, one web profile per saved server                                 |
| 7   | Any origin exception for the app     | None                                                                  |
| 8   | Where agents run when remote         | On the server's computer, with its sign-ins                           |
| 9   | Version rule                         | Overlapping API ranges; screens are not versioned                     |
| 10  | Offline                              | No offline mode and no queued writes                                  |

## 15. Not covered

- A phone app.
- Moving an instance between computers (Phase 8 covers moving Ben's install once).
- Several people sharing one app on one OS account. Each saved server keeps one signed-in account.
