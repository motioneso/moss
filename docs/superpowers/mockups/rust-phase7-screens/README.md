# Install, backup and update screens: draft

JS-423, Phase 7. Open `index.html` for all seven screens. These are static drafts for Ben's look
check, not working product screens. Screen-index links, state disclosures, switches, fields and
the theme picker work locally. Buttons never change Moss. Progress, success and failure appear
side by side for review. Values are illustrative.

Run a static server from `~/Jarv1s` (or this task's checkout) on a reserved port:

```bash
devports claim js423-mockups
```

Use the returned port in place of PORT:

```bash
python3 -m http.server PORT --bind 127.0.0.1
```

Expected: the server stays running. Open
`/docs/superpowers/mockups/rust-phase7-screens/index.html` on that server. Stop the server and
run `devports release PORT` when finished. No build, dependencies or database needed. Tokens and
shared primitive styles load from the repo; Archivo fonts are local.

## Starting look and implementation mapping

The desktop app screens start from the existing first-run, servers and stop screens in
`rust-spike/shell/connect/assets/connect.js` (lines 41, 161-179, 257-290). Settings screens
follow the phase 6 Settings layout: ruled rows, compact controls, no explanatory lines.
`mockups.css` owns draft layout only; colour, type and controls come from the shared CSS.

| Draft                  | Where                    | Phone            | Shared pieces for implementation                   |
| ---------------------- | ------------------------ | ---------------- | -------------------------------------------------- |
| M1 First run           | Desktop app              | No               | Card (interactive), Button, Badge, EmptyState      |
| M2 Recovery key        | Desktop app, first run   | No               | Field, Button                                      |
| M3 Servers and tray    | Desktop app, OS tray     | No               | RowIndex, Indicator, Button, Menu, Dialog          |
| M4 Sharing             | Settings / Sharing       | Yes              | RowIndex, Switch, Badge, Dialog, Button            |
| M5 Backups and restore | Settings / Backups       | Yes (admin only) | RowIndex, Badge, Select, Dialog, Field, EmptyState |
| M5 New computer        | Desktop app, first run   | No               | Field, Button                                      |
| M6 Updates             | Desktop app and Settings | Version row only | Dialog, RowIndex, Switch, Button                   |
| M7 Docker import       | Desktop app, first run   | No               | Field, Button, RowIndex                            |

The tray menu is drawn with the shared menu style for review. On each OS the real tray menu is
the system's own.
