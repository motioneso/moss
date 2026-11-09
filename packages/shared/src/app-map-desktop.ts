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
      "The Moss desktop app opens the server it used last. On first run it asks This computer or Another computer. This computer starts the local Moss server in the background if it is not running; the server keeps running after the window closes. Another computer takes an HTTPS address from that computer's Sharing screen, shows its certificate code, and saves the server only after It matches is pressed. A saved server whose certificate later changes shows the new code to compare again. Each saved server has its own sign-in. The Servers list (also at moss-app://servers) shows each server as Running, Not running, Reachable or Can't reach, with Open and Remove. When a server cannot be reached the app names the reason and tries again with growing waits. The app reaches other computers only when their sharing is on.",
    path: "moss-app://localhost/index.html",
    scope: "user"
  }
];

export const DESKTOP_APP_ERRORS: readonly CoreAppErrorDeclaration[] = [
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
      "This version of the desktop app cannot set up Moss on this computer yet. Press Switch server and add another computer that runs Moss.",
    path: "moss-app://servers",
    scope: "system"
  }
];
