# Theme editor: Park Press and a nav bar color (#3000)

Static mockups for sign-off before any build. Nothing here ships.

## Open them

Open the files straight from disk in a browser. The bar across the top switches light and dark
mode, which theme is applied (Harbor is the custom theme being edited) and Harbor's nav color.

| File | Shows |
| --- | --- |
| `desktop.html` | The full Appearance pane at 1440 wide, inside the real app frame, with the Today band clicked in the preview |
| `phone.html` | Three 390 wide screens: top of the pane, the nav color box open, the menu open |
| `nav-colors.html` | Harbor's nav at full size on seven colors, with the contrast each one reaches |

`app.css` and `fonts/` are a frozen copy of the shipped tokens, `@moss/ui` styles, settings
styles and Archivo. `mockup.css` holds only the mockup's own layout. The folder is in
`.prettierignore` so the frozen copy stays byte-for-byte.

## What changes

| Today's editor | Mockup |
| --- | --- |
| No nav color control | A "Nav bar" group inside the custom theme editor: a color box and hex field like Accent and Highlight, a live nav strip, a contrast readout and "Reset to Harbor default" |
| Color boxes show a gap between the border and the color | Every color box is solid: the color fills the whole box |
| The rule color is called Gold | It is called Highlight on screen and in the saved theme |
| Pasting a palette, then clicking a color fills the slot you last touched | Pasting fills nothing. The paste box shows the colors it found, and every color box opens a picker with a "From your palette" row on top and "Any color" below |
| The preview is only a picture | Clicking a part of the preview (page, text, Today band, buttons, highlight rule, card, nav) opens the picker for the color that paints it. Hover outlines the part and the line above the preview names its color |
| Each color slot boxed in its own card | Hairline-ruled rows, name and purpose on the left, picker and value on the right |
| Technical slot names (surface-2, ink-3, line-strong) | Plain names with a one-line purpose: Page, Card, Soft card, Track, Text, Soft text and so on |
| Line colors with transparency show as white swatches | Line slots show a ruled sample at the real weight |
| Preview is a generic "Daily plan" card | Preview is a small Today screen: nav, Today band with its highlight rule, numbered section head, rows, a card, buttons |
| "On track" badge and accent note unreadable in dark mode | Dropped from the preview; the soft accent text gets fixed in the build |
| Accent ramp listed with internal names | Removed; the preview shows the ramp in use |
| Warnings like "Accent on paper 1.79:1" | "Can people read it?" list: each pairing in words, "Reads well, 6.2 to 1" or "Faint, 2.1 to 1. Aim for 3 to 1" |
| Generic theme thumbnails | Thumbnails draw a small Moss screen in the theme's colors, nav included |

## Where the nav color lives

- The nav color belongs to a custom theme and saves with it. Built-in themes keep their own nav.
- A custom theme saves one set of colors, and the app always runs custom themes in light mode.
  So each custom theme has one nav color, not one per mode.
- The app's nav, the phone top bar and the phone menu take the color while that theme is applied.
- With a built-in theme applied, the color mode switch works as today. With a custom theme
  applied, it explains that custom themes keep their saved colors.

## How the nav color stays readable

- Text and icons pick the house dark ink or bone, whichever reads better on the chosen color.
- A middle tone defeats both, so text falls back to full black or white. One of the two always
  clears 4.5 to 1.
- Quieter links dim toward the ground only as far as 4.5 to 1 allows.
- The selected item keeps the accent pill when the accent stands out from the nav (3 to 1).
  Otherwise it becomes a tinted wash of the text color.
- The Moss mark uses the accent when it reads at 4.5 to 1, otherwise the text color.
- On a phone the top bar and the menu drawer take the same color.

## Ben's answers

1. The nav color is a setting inside custom themes only.
2. The phone's top bar and the menu both take the nav color.
3. Custom themes have no separate light and dark colors (checked in the app shell), so there is
   one nav color per custom theme.
