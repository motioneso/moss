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

- The row repeats the shipped calendar row: a practical `Note`, bold title, one `role="status"`
  line, detail lines, then a wrapping button row.
- The title line adds a `Switch` on the right and, in problem states only, a `Badge`.
- Problem messages copy the calendar row's wording for the same states.
- Setup puts the steps and the pairing code side by side on desktop and stacks them on phones.
- The "Mockup state" labels on `05-problems.html` are review annotations, not product copy.

## Primitives

`Note` (practical), `Switch`, `Badge` (amber, red), `Button` (primary, secondary, link),
`ButtonLink`, `Eyebrow`, `Divider`, and `PaneHead` from `@moss/settings-ui`. The Settings frame
uses the shipped `set2` and `conn` classes. `frame.css` is layout only and uses tokens.

## Build

`moss-ui.css` is the app's own stylesheet cascade plus the Settings sheets, bundled by `build.tsx`.
The HTML and stylesheet are generated, so `.prettierignore` skips them.

    TSX_TSCONFIG_PATH=docs/superpowers/specs/outlook-mail-mockup/render-tsconfig.json node --import tsx docs/superpowers/specs/outlook-mail-mockup/build.tsx
