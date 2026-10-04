# Theme editor: Park Press and a nav bar color (#3000)

Static mockups for sign-off before any build. Nothing here ships.

## Open them

Open the files straight from disk in a browser. The bar across the top switches light and dark
mode, the built-in theme and the nav color, and links between the pages.

| File | Shows |
| --- | --- |
| `desktop.html` | The full Appearance pane at 1440 wide, inside the real app frame |
| `phone.html` | Three 390 wide screens: top of the pane, the theme editor, the menu open |
| `nav-colors.html` | The nav at full size on seven colors, with the contrast each one reaches |

`app.css` and `fonts/` are a frozen copy of the shipped tokens, `@moss/ui` styles, settings
styles and Archivo. `mockup.css` holds only the mockup's own layout. The folder is in
`.prettierignore` so the frozen copy stays byte-for-byte.

## What changes

| Today's editor | Mockup |
| --- | --- |
| No nav color control | New "Nav bar" section: six swatches, a custom color, a live nav strip, a contrast readout and "Reset to theme default" |
| Each color slot boxed in its own card | Hairline-ruled rows, name and purpose on the left, picker and value on the right |
| Technical slot names (surface-2, ink-3, line-strong) | Plain names with a one-line purpose: Page, Card, Soft card, Track, Text, Soft text and so on |
| Line colors with transparency show as white swatches | Line slots show a ruled sample at the real weight |
| Preview is a generic "Daily plan" card | Preview is a small Today screen: nav, Today band with its gold rule, numbered section head, rows, a card, buttons |
| "On track" badge and accent note unreadable in dark mode | Dropped from the preview; the soft accent text gets fixed in the build |
| Accent ramp listed with internal names | Removed; the preview shows the ramp in use |
| Warnings like "Accent on paper 1.79:1" | "Can people read it?" list: each pairing in words, "Reads well, 6.2 to 1" or "Faint, 2.1 to 1. Aim for 3 to 1" |
| Generic theme thumbnails | Thumbnails draw a small Moss screen in the theme's colors, nav included |

## How the nav color stays readable

- Text and icons pick the house dark ink or bone, whichever reads better on the chosen color.
- A middle tone defeats both, so text falls back to full black or white. One of the two always
  clears 4.5 to 1.
- Quieter links dim toward the ground only as far as 4.5 to 1 allows.
- The selected item keeps the accent pill when the accent stands out from the nav (3 to 1).
  Otherwise it becomes a tinted wash of the text color.
- The Moss mark uses the accent when it reads at 4.5 to 1, otherwise the text color.
- On a phone the top bar and the menu drawer take the same color.

## Questions for Ben

1. Should the nav color be its own setting that works with every theme (as drawn), or part of a
   custom theme only?
2. Should the phone's top bar take the nav color too (as drawn), or only the menu drawer?
3. One nav color serves both light and dark mode (as drawn). Is that right, or should each mode
   keep its own?
