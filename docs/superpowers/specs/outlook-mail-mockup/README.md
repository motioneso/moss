# Outlook work mail mockup

Mockups for adding work mail to an Outlook account in Settings > Connections, from
[the Outlook mail spec](../2026-10-26-outlook-mail-context-design.md). There is no separate
"Work mail" section. Mail is part of the add-account flow. Awaiting owner approval before any
build.

Open `index.html` locally. No network or build step is needed.

## Screens

| File                      | State                                                            |
| ------------------------- | ---------------------------------------------------------------- |
| `01-add-account.html`     | Account picker with Outlook beside Google and Email (IMAP)       |
| `02-sign-in.html`         | Connect Outlook: normal Microsoft sign-in tried first            |
| `03-sign-in-blocked.html` | Sign-in blocked: browser add-on steps, pairing code, server link |
| `04-connected.html`       | Account row: email access switch, last read time                 |
| `05-problems.html`        | Add-on not seen, Outlook sign-in needed, Outlook page changed    |

`screens/` holds each state at 1280px and 390px. No screen overflows at 390px.

## Design

- Outlook is one more option in the existing account picker and uses the Google connect page
  layout (`gflow`).
- The blocked state uses a shared `Indicator` line, then three one-line onboarding steps. The
  pairing code reuses the Connections count style. The server window route is one plain link.
- The connected row is the shipped account row. "Email access" is a feature switch whose only
  description is the last read time. The status line reads "Browser add-on" plus a health dot.
- Problem states change only the health dot and offer "Open Outlook" where the user can act.
- No green boxes. The shipped Outlook calendar row still uses a practical `Note`, so it would
  look different from these rows unless it is restyled the same way.
- The "Mockup state" labels on `05-problems.html` are review annotations, not product copy.

## Primitives

`Group` and `PaneHead` from `@moss/settings-ui`; `Switch`, `Indicator`, `Button` and
`ButtonLink` (secondary, quiet and link, size sm) and `Eyebrow` from `@moss/ui`. The picker,
connect page, steps, account row and Settings frame use the shipped `provpick`, `gflow`,
`onb-guide`, `onb-cred`, `acct`, `conn` and `set2` classes. `frame.css` is layout only,
including a phone rule that moves account row buttons under the row.

## Build

`moss-ui.css` is the app's own stylesheet cascade plus the Settings sheets, bundled by `build.tsx`.
The HTML and stylesheet are generated, so `.prettierignore` skips them.

    TSX_TSCONFIG_PATH=docs/superpowers/specs/outlook-mail-mockup/render-tsconfig.json node --import tsx docs/superpowers/specs/outlook-mail-mockup/build.tsx
