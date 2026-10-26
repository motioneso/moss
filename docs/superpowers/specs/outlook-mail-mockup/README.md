# Work mail settings row mockup

Mockups for the "Work mail" row in Settings > Connections, from
[the Outlook mail spec](../2026-10-26-outlook-mail-context-design.md). Awaiting owner approval
before any build.

Open `index.html` locally. No network or build step is needed.

## Screens

| File                    | State                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| `01-off.html`           | Off                                                                       |
| `02-turning-on.html`    | Turning on with the add-on: three steps, pairing code, server window link |
| `03-server-window.html` | Turning on with the server window                                         |
| `04-connected.html`     | Connected: last read time, switch, revoke                                 |
| `05-problems.html`      | Add-on not seen, sign-in needed (both routes), Outlook page changed       |

`screens/` holds each state at 1280px and 390px. No screen overflows at 390px.

## Design

- Work mail is a Settings section like its neighbours, Accounts and Notes folder, which the
  mockup renders below it for comparison. It has no tinted box.
- Each state shows only the title, the on/off `Switch`, one status line and the buttons that
  act. No description or detail lines.
- The status line uses the Notes folder row pattern: icon tile, status, small secondary or quiet
  buttons on the right.
- Problem states put a shared `Indicator` dot in the status line, as account rows do.
- Setup steps are one-line settings rows. The pairing code reuses the Connections count style.
  The server window route is one plain link.
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
