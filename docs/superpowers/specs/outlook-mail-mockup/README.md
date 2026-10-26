# Work mail settings row mockup

Mockups for the "Work mail" row in Settings > Connections, from
[the Outlook mail spec](../2026-10-26-outlook-mail-context-design.md). Awaiting owner approval
before any build.

Open `index.html` locally. No network or build step is needed.

## Screens

| File                    | State                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `01-off.html`           | Off                                                                    |
| `02-turning-on.html`    | Turning on with the add-on: download, steps, pairing code, second path |
| `03-server-window.html` | Turning on with the server window                                      |
| `04-connected.html`     | Connected: last read, count, switch, revoke, read-marking line         |
| `05-problems.html`      | Add-on not seen, sign-in needed (both routes), Outlook page changed    |

`screens/` holds each state at 1280px and 390px. No screen overflows at 390px.

## Design

- Work mail is a Settings section like its neighbours, Accounts and Notes folder, which the
  mockup renders below it for comparison. It has no tinted box.
- The section head is the shared `Group`: display title, one-line description, and the on/off
  `Switch` in the action slot where "Add connection" sits on Apps & services.
- State shows in one status row in the Notes folder pattern: icon tile, status line, detail
  lines, and small secondary or quiet buttons on the right.
- Problem states put a shared `Indicator` dot in the status line, as account rows do.
- Setup steps are ordinary settings rows. The pairing code reuses the Connections count style.
- The shipped Outlook calendar row still uses a practical `Note`. It is not shown here, and it
  would look different from this section unless it is restyled the same way.
- The "Mockup state" labels on `05-problems.html` are review annotations, not product copy.

## Primitives

`Group`, `Row` and `PaneHead` from `@moss/settings-ui`; `Switch`, `Indicator`, `Button` and
`ButtonLink` (secondary and quiet, size sm) and `Eyebrow` from `@moss/ui`. Status rows, the
neighbours and the Settings frame use the shipped `vault`, `provpick`, `conn`, `set-row` and
`set2` classes. `frame.css` is layout only.

## Build

`moss-ui.css` is the app's own stylesheet cascade plus the Settings sheets, bundled by `build.tsx`.
The HTML and stylesheet are generated, so `.prettierignore` skips them.

    TSX_TSCONFIG_PATH=docs/superpowers/specs/outlook-mail-mockup/render-tsconfig.json node --import tsx docs/superpowers/specs/outlook-mail-mockup/build.tsx
