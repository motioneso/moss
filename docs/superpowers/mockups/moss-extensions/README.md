# Customizations settings pane mockup

Open `index.html` to see every state. `screen.html?state=` loads one state on its own:
`list`, `history`, `history-code`, `empty`, `admin`. Add `&mode=dark` for the dark theme.

## Files

- `screen.html` - the Settings screen with the new pane, built from the real app markup
- `app.css` - frozen copy of the app's own CSS; do not edit
- `mockup.css` - layout for the new pieces only, tokens only
- `fonts/` - Archivo, copied from the app

## New pieces the build needs

- Pane head with one action on the right (`Turn all off`)
- Customization row: name, fallbacks line, status badge, changed date, Reset and History
- History list: versions with date, chat link and `Turn on`
- Code block behind a `Show code` toggle
- Admin pane "Customizations" after Instance modules, holding one switch for everyone

Each belongs in `@moss/ui` or the settings UI kit before the pane uses it.
