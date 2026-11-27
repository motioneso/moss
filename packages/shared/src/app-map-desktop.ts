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
      "The Moss desktop app opens the server it used last. On first run it asks This computer or Another computer. This computer sets up its first local server on the spot (a short Setting up screen while the private database and secure address are made) and starts it in the background if it is not running; the server keeps running after the window closes. Another computer takes an HTTPS address from that computer's Sharing screen. Public-authority certificates accepted by the operating system connect without a certificate comparison or pin; each connection checks OS trust. Self-signed certificates show a code and are saved only after It matches is pressed. Existing pins stay pinned: a saved pinned server whose certificate later changes shows the new code to compare again. Each saved server has its own sign-in. The Servers list (also at moss-app://servers) shows each server as Running, Stopped, Reachable or Can't reach, with Open, Start for a stopped local server, Stop (asks for confirmation before disconnecting people and stopping a local server and its database), Remove (other computers) and New server here, which asks for a name and makes another local server. Inside any server, the account menu at the bottom of the side bar has Switch server, which returns to this list. When a server cannot be reached the app names the reason and tries again with growing waits. The app reaches other computers only when their sharing is on. Each local server has its own sign-in service, independent of the app login entry: a systemd user unit on Linux, LaunchAgent on macOS or separate per-instance login item on Windows. Stop disables that service and keeps it down across app restarts and sign-ins until Start. On macOS Stop also removes its login file and is safe to repeat. On Linux a server gets at most three starts before automatic restarts are blocked; reconnecting does not clear that limit. After fixing the reported problem, Start clears the failure so it can try again. A cold start keeps waiting beyond twenty seconds while the service is still starting, with a five-minute readiness ceiling for a hung startup. Each explicit Start refreshes the restart budget. Program versions live side by side apart from data; the launcher selects the current version.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  },
  {
    id: "rust-desktop-recovery-key",
    runtime: "rust",
    label: "Rust Moss desktop app - recovery key",
    description:
      "At first run on this computer, after the server is set up, the desktop app shows the 24 recovery words once on this screen. Backups open only with these words. The owner copies, prints or saves the words, then types three asked words to check the copy before continuing. A locked key store shows Your key store is locked with Unlock and retry. A missing or broken key store on a desktop session shows No key store found with Try again and no key-file choice. The words never appear in Settings or on another computer.",
    path: "moss-app://recovery-key",
    scope: "user"
  }
];

export const DESKTOP_APP_SETTINGS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "rust-desktop-settings",
    runtime: "rust",
    label: "Rust Moss desktop settings",
    description:
      "From Servers, open Desktop settings. Start Moss at login registers this app and its selected data folder with the desktop session: XDG autostart on Linux, a per-user LaunchAgent on macOS, or the current user Run key on Windows; turn it off there to remove it. Versioned installs start through the current-version launcher at login. On Linux, older flat staged runtime installs start through moss-run; an install missing that launcher reports a settings error instead of registering a direct launch. Desktop notifications are off by default and can be allowed for server connections and stops, with Send test notification to check the desktop service. While connected, new unread notifications and new chat replies are checked every five seconds and produce generic banners when the server page is in the background. Windows banners require its notification-area icon. Existing items on the first visit to an account are quiet; banners contain no reminder or chat text. Pending banner receipts persist separately for each account: per saved-server profile on Linux and Windows, and per server address in the shared WebKit store on macOS. Accepted notification IDs also persist on the server for that account and profile's client ID; other profiles remain independent and chat acceptance remains local. Failed native delivery is retried while connected with increasing waits up to one minute; native success (or turning banners off) acknowledges the batch without marking bell items read. On Linux and Windows success means the desktop API accepted it; macOS only confirms submission to its legacy notification center and cannot detect denied OS permission, so a banner may be lost there. A slow Linux desktop service can block the window for up to a second per kind on each attempt. Returning to an account catches new items and pending delivery from the previous visit. Receipt writes that fail leave the batch pending, so a duplicate banner is possible. Corrupt or unavailable receipt storage pauses alerts. An explicitly configured Rust server module host runs approved module schedules without a connected desktop; its notification posts enter this same recipient feed only when their invocation transaction commits. This requires a pre-existing approved module catalog and host configuration. Module mute preferences are respected, but quiet-hours deferral, reminder metadata, links and deduplication remain unported; real reminder producers must remain disabled. Reminder authoring and installed native reminder delivery are not yet qualified. Closing or quitting the app still provides no background delivery, and notification clicks do not switch saved servers. When a StatusNotifier tray host is available, closing the window hides it and the tray icon reopens it; the tray menu shows the last local server's Running or Stopped status, Open Moss, Stop server (with confirmation), Desktop settings and Quit app. Quit app exits while servers keep running. Without a tray host closing quits the app. Windows uses a notification-area icon (right-click opens the tray menu) and system notification balloons; macOS uses a menu-bar M with the same server controls and native notifications, whose delivery requires an installed app bundle and OS permission. These native backends are independently target-checked; native runtime qualification remains outstanding. If a setting cannot be saved or notifications are unavailable, this screen reports it and allows retry.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  }
];

export const DESKTOP_APP_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "app_firewall_refused",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-network-sharing",
    description:
      "The firewall did not allow Moss, so sharing stays off or paused. An unknown firewall helper outcome keeps its cleanup record and asks the owner to retry. If Sharing says Paused, press Resume and allow the live firewall check. A refused or failed check preserves the paused state and rule record. Otherwise turn sharing on again and choose Allow, or add Moss in the computer's firewall settings. If a firewall rule with Moss's name was made by someone else, Moss leaves it alone and refuses: rename or remove that rule, then try again. An old Moss rule from before ownership markers is never removed by Moss: remove it by hand, then try again. On Linux, Moss needs ufw or firewalld installed and turned on. If firewalld has not loaded the installer-owned service, sharing stays off: reinstall Moss or restart the firewall. Moss never reloads firewalld at runtime."
  },
  {
    code: "app_server_stop_failed",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-app-switch-server",
    description:
      "Stop names the failed step and gives a matching remedy: restore a missing server folder, check folder read/write permissions or file locking, check or disable the sign-in service or Windows task, sign back in if the macOS login session is unavailable, or wait and inspect the server and database logs if shutdown is still busy. The macOS login-file cleanup asks for LaunchAgents write permission. Retry Stop after the named remedy."
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
      "The local Moss process exited before becoming reachable, or no starting process was found after twenty seconds. A live starting process or active background service keeps the app waiting beyond that initial window, up to a five-minute readiness ceiling."
  },
  {
    code: "app_server_service_failed",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-app-server-service",
    description:
      "Moss could not register or start this instance's background sign-in service, read its state, or it reached Linux's restart limit or the five-minute readiness ceiling. Check server.log and database.log in the server folder and fix the startup problem, then press Start. Stop failures preserve the failed step and remedy under app_server_stop_failed."
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
    code: "app_keystore_locked",
    runtime: "rust",
    class: "permission",
    remediationRef: "rust-app-keystore-retry",
    description:
      "The operating system key store is locked, so Moss refuses to start. Unlock your key store, then try again."
  },
  {
    code: "app_keystore_unavailable",
    runtime: "rust",
    class: "prerequisite",
    remediationRef: "rust-app-keystore-retry",
    description:
      "No key store was found, or it did not answer. Check your key store, then try again. On a desktop session setup stops here and offers no key file."
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
    id: "rust-app-keystore-retry",
    runtime: "rust",
    description:
      "Unlock your key store when it is locked, then press Unlock and retry. When no key store is found, check your key store and press Try again. A desktop session never offers a key file instead.",
    path: "moss-app://recovery-key",
    scope: "user"
  },
  {
    id: "rust-app-server-service",
    runtime: "rust",
    description:
      "Check your sign-in services and the server.log and database.log files in this server's folder, fix the startup problem, then press Start on Servers. Linux stops retrying after three starts until Start clears the failure; reconnecting keeps it failed. Stop shows a specific remedy for the failed shutdown step. A stopped server stays stopped until Start.",
    path: "moss-app://servers",
    scope: "user"
  },
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
      "The desktop app could not set up a server on this computer, and the screen says why: the copy of Moss came without its database, the OpenSSL program is missing, the database did not start (its log is in the server's folder), or this system is not supported yet. Fix what it names and try again, or press Switch server and add another computer that runs Moss. Unsigned Linux staging can include the app and server linked libraries, OpenSSL and public CA files. App-started local servers, database lifecycle commands and certificate generation select the moss-run runtime launcher when the install has a runtime folder; a missing launcher fails instead of falling back to a direct program. The launcher can also start the app, and Linux start at login uses it. The optional desktop stage adds WebKit helpers, its injected bundle, a GIO TLS backend, schemas, MIME data, fonts and a Mesa software renderer. Its runtime/rootfs payload must be deployed at the build platform's fixed absolute helper paths in a target root; the launcher reports missing payload files but does not check the version of existing system helpers. Other desktop resources are selected from the stage. This requires the build platform's ELF interpreter ABI, a POSIX shell and desktop session; it is not a relocatable desktop bundle or general installer. A manually inspected run in a clean ordinary-user software-rendered test desktop exercised the native keyboard flow through This computer with a fresh database, owner creation, sign-out and sign-in, then loaded Today from that local HTTPS server. Today still uses labelled sample data. Hardware rendering, media, full desktop login and general installation remain unqualified. To remove a staged install, first turn off Start Moss at login, quit the app and stop its servers, then run python3 uninstall.py from the install folder. Uninstall requires Python and the ordinary install owner, refuses changed files or live install executables, and keeps instance data and other unlisted files. It removes only staged files, not copies of the target-root payload deployed outside the install folder.",
    path: "moss-app://servers",
    scope: "system"
  }
];
