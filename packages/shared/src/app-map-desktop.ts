// The Rust desktop app's connect screen, its errors and their remediations.

import type {
  CoreAppErrorDeclaration,
  CoreAppRemediationDeclaration,
  CoreAppSurfaceDeclaration
} from "./app-map-core.js";

export const DESKTOP_APP_SCREENS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "rust-desktop-connect",
    runtime: "rust",
    label: "Rust Moss desktop app - choose and connect to a server",
    description:
      "The Moss desktop app opens the server it used last. On first run it asks This computer or Another computer. This computer sets up its first local server on the spot (a short Setting up screen while the private database and secure address are made) and starts it in the background if it is not running; the server keeps running after the window closes. Another computer takes an HTTPS address from that computer's Sharing screen, shows its certificate code, and saves the server only after It matches is pressed. A saved server whose certificate later changes shows the new code to compare again. Each saved server has its own sign-in. The Servers list (also at moss-app://servers) shows each server as Running, Not running, Reachable or Can't reach, with Open, Stop (asks for confirmation before disconnecting people and stopping a local server and its database), Remove (other computers) and New server here, which asks for a name and makes another local server. Inside any server, the account menu at the bottom of the side bar has Switch server, which returns to this list. When a server cannot be reached the app names the reason and tries again with growing waits. The app reaches other computers only when their sharing is on. Creating and stopping local servers is not available on Windows yet; its database supervisor still needs a Windows port.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  }
];

export const DESKTOP_APP_SETTINGS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "rust-desktop-settings",
    runtime: "rust",
    label: "Rust Moss desktop settings",
    description:
      "From Servers, open Desktop settings. Start Moss at login registers this app and its selected data folder with the desktop session: XDG autostart on Linux, a per-user LaunchAgent on macOS, or the current user Run key on Windows; turn it off there to remove it. On Linux, staged runtime installs start through moss-run at login; an install missing that launcher reports a settings error instead of registering a direct launch. Desktop notifications are off by default and can be allowed for server connections and stops, with Send test notification to check the desktop service. While connected, new unread notifications and new chat replies are checked every five seconds and produce generic banners when the server page is in the background. Windows banners require its notification-area icon. Existing items on the first visit to an account are quiet; banners contain no reminder or chat text. Pending banner receipts persist separately for each account: per saved-server profile on Linux and Windows, and per server address in the shared WebKit store on macOS. Failed native delivery is retried while connected with increasing waits up to one minute; native success (or turning banners off) acknowledges the batch without marking bell items read. On Linux and Windows success means the desktop API accepted it; macOS only confirms submission to its legacy notification center and cannot detect denied OS permission, so a banner may be lost there. A slow Linux desktop service can block the window for up to a second per kind on each attempt. Returning to an account catches new items and pending delivery from the previous visit. Receipt writes that fail leave the batch pending, so a duplicate banner is possible. Corrupt or unavailable receipt storage pauses alerts. Closing or quitting the app still provides no background delivery, and notification clicks do not switch saved servers. When a StatusNotifier tray host is available, closing the window hides it and the tray icon reopens it; the tray's context action opens Desktop settings. Quit app exits while servers keep running. Without a tray host closing quits the app. Windows uses a notification-area icon (right-click opens Desktop settings) and system notification balloons; macOS uses a menu-bar M with Open Moss and Desktop settings and native notifications, whose delivery requires an installed app bundle and OS permission. These native backends are independently target-checked; native runtime qualification remains outstanding. If a setting cannot be saved or notifications are unavailable, this screen reports it and allows retry.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  }
];

export const DESKTOP_APP_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "app_server_stop_failed",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-app-switch-server",
    description:
      "Stop could not finish stopping a local server or its database. Open Servers to check its state and retry."
  },
  {
    code: "app_desktop_integration_failed",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-app-desktop-settings",
    description:
      "Desktop settings could not be saved, login autostart could not be changed, or the desktop notification service is unavailable."
  },
  {
    code: "app_server_not_set_up",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-app-local-setup",
    description: "The desktop app found no prepared Moss instance on this computer."
  },
  {
    code: "app_server_did_not_start",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-app-switch-server",
    description:
      "The desktop app started the local Moss server but it did not answer within twenty seconds."
  },
  {
    code: "app_server_unreachable",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-app-switch-server",
    description: "The desktop app could not reach the saved server at its address."
  },
  {
    code: "app_not_a_moss_server",
    runtime: "rust",
    class: "validation",
    remediationRef: "rust-app-switch-server",
    description: "The address the desktop app tried answered, but not as a Moss server."
  },
  {
    code: "app_certificate_changed",
    runtime: "rust",
    class: "permission",
    remediationRef: "rust-app-compare-certificate",
    description:
      "A saved server presented a different certificate from the one the desktop app pinned."
  },
  {
    code: "app_server_too_old",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-app-switch-server",
    description: "The saved server is older than any version the desktop app can talk to."
  },
  {
    code: "app_too_old",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-app-switch-server",
    description: "The desktop app is older than any version the saved server can talk to."
  }
];

export const DESKTOP_APP_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "rust-app-desktop-settings",
    runtime: "rust",
    description:
      "Open Servers, Desktop settings. Retry the named action after checking folder permissions or the desktop notification service. If no tray host is available, closing the window quits the app; local servers keep running.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  },
  {
    id: "rust-app-switch-server",
    runtime: "rust",
    description:
      "Press Try again, or Start it for this computer. To use another server, press Switch server and pick or add one. Update Moss on whichever side is older when versions do not match.",
    path: "moss-app://servers",
    scope: "user"
  },
  {
    id: "rust-app-compare-certificate",
    runtime: "rust",
    description:
      "Open Sharing on the other computer and compare its certificate code with the one the app shows. Press It matches only when every pair is the same; otherwise press Cancel.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  },
  {
    id: "rust-app-local-setup",
    runtime: "rust",
    description:
      "The desktop app could not set up a server on this computer, and the screen says why: the copy of Moss came without its database, the OpenSSL program is missing, the database did not start (its log is in the server's folder), or this system is not supported yet. Fix what it names and try again, or press Switch server and add another computer that runs Moss. Unsigned Linux staging can include the app and server linked libraries, OpenSSL and public CA files. App-started local servers, database lifecycle commands and certificate generation select the moss-run runtime launcher when the install has a runtime folder; a missing launcher fails instead of falling back to a direct program. The launcher can also start the app, and Linux start at login uses it. The optional desktop stage adds WebKit helpers, its injected bundle, a GIO TLS backend, schemas, MIME data, fonts and a Mesa software renderer. Its runtime/rootfs payload must be deployed at the build platform's fixed absolute helper paths in a target root; the launcher reports missing payload files but does not check the version of existing system helpers. Other desktop resources are selected from the stage. This requires the build platform's ELF interpreter ABI, a POSIX shell and desktop session; it is not a relocatable desktop bundle or general installer. Hardware rendering, media, full desktop login and This computer UI creation remain unqualified. To remove a staged install, first turn off Start Moss at login, quit the app and stop its servers, then run python3 uninstall.py from the install folder. Uninstall requires Python and the ordinary install owner, refuses changed files or live install executables, and keeps instance data and other unlisted files. It removes only staged files, not copies of the target-root payload deployed outside the install folder.",
    path: "moss-app://servers",
    scope: "system"
  }
];
