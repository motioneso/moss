# Remote access mockups

Screens for `docs/superpowers/specs/2026-10-27-remote-access-names-design.md`, drawn with the real
Moss Settings markup and styles.

## Opening

Serve this folder with any static server and open `index.html`. Each frame then sizes to its
screen. Opened straight from disk, frames keep a fixed height and scroll.

`screen.html?m=m4&s=nohttps&mode=dark` shows one screen at the window's width.
`index.html#m4=nohttps` opens the review page with that state selected.

## Files

| File          | What it is                                                                         |
| ------------- | ---------------------------------------------------------------------------------- |
| `index.html`  | Review page: every screen at 1440 and 390, state buttons, light/dark, notes        |
| `screen.html` | Renders one screen from `?m=&s=&mode=`                                             |
| `screens.js`  | The screens, built from the real component markup                                 |
| `shell.js`    | Sidebar, top bar, Settings header and nav, and icons, captured from the live app   |
| `app.css`     | Frozen copy of the live web CSS at `9b0e7487b`. Not edited by hand                 |
| `remote.css`  | Layout for these screens and the new pieces below. Tokens only                     |
| `fonts/`      | Archivo, OFL licence                                                               |

## New pieces the build needs

Each goes into `@moss/ui` before Remote access uses it.

- Step list (done, current, to do): `.ra-steps` in `remote.css`
- Input with a fixed suffix: `.ra-suffix`
- QR code: `.ra-qr`
- Full-width detail layout and guided-flow back link, local to the connection screen today
  (`intg-detail`, `gflow`)

## Regenerating `app.css`

Concatenate `apps/web/src/styles/index.css` with its imports, the Settings pane stylesheets and
`apps/web/src/notifications/notifications.css`, then rewrite `/fonts/archivo/` to `fonts/`.
