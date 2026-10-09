# Finance R1 mockups

Mockups for every R1 screen in
[the finance redesign spec](../2026-10-08-finance-redesign-design.md), at desktop (1440) and phone
(390) width. Open `index.html`.

All names, banks, merchants and amounts are made up.

## Pages

| Page                         | Shows                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| `01-budget`                  | This month's budget by group, with what needs you first           |
| `02-transactions`            | Transactions by day; predicted categories wait for a look         |
| `03-accounts`                | Banks, sync status, reconnect, net worth by month                 |
| `04-start`                   | Getting started with no bank connected                            |
| `04-start-no-keys`           | Getting started before an admin adds the bank keys                |
| `05-first-budget`            | The draft from three months of history, typed in place or in chat |
| `05-first-budget-phone-chat` | The same draft on phone with the chat drawer open                 |
| `06-settings`                | Finance settings, Plaid keys, and this week's activity with undo  |

## Files

- `build.tsx` renders every page from the real `@moss/ui` components with `renderToStaticMarkup`.
- `frame.css` holds the app frame and page layout only.
- `moss-ui.css` is a frozen copy of the shipped tokens and `@moss/ui` styles, so the pages keep
  rendering as designed when the live CSS moves on.
- `moss-ui.phone.css` is generated from it by the build. It turns the narrow-screen rules on
  unconditionally, so phone pages render as a phone even in a wide browser window.
- `p6.css` previews the shared `@moss/ui` fixes of platform addition P6 (contrast, radio card
  layout, 44px phone targets). The build makes `p6.phone.css` from it the same way.
- `fonts/` holds the Archivo files the tokens point at.

The generated HTML, both `moss-ui` stylesheets and `p6.phone.css` are excluded from Prettier.

## Rebuild

From the repository root:

```bash
TSX_TSCONFIG_PATH=$PWD/docs/superpowers/specs/finance-redesign/render-tsconfig.json \
  node --import tsx docs/superpowers/specs/finance-redesign/build.tsx
```

It prints `Built 15 screens.` and exits 0. The pages pick up `moss-ui.css` as frozen; refreshing
that file is a deliberate step, not part of the rebuild.
