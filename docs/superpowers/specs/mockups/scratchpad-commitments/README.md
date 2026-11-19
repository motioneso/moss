# Scratchpad 3 and Commitments 9 mockups

Static review boards for two Rust port parts with no TypeScript screen (JS-352). Pages load the
shipped Park Press stylesheets from `apps/web` and `packages/ui`, so serve from the repo root.

| Board                | Frames                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `scratchpad-3.html`  | `pad-open`, `pad-with-chat`, `pad-appended`, `pad-settings`, `pad-phone`, `pad-phone-conflict`                                              |
| `commitments-9.html` | `commit-today` (option A), `commit-peek` (option B), `commit-phone`, `commit-phone-chat`, `commit-phone-empty`                              |

## Serve

```
python3 -m http.server <port from devports> --directory ~/Jarv1s
```

Then open `/docs/superpowers/specs/mockups/scratchpad-commitments/scratchpad-3.html`.

## Notes

- All names and data are fictional.
- Scratchpad departs from the 2026-09-04 spec in two places: the pad sits beside the chat drawer
  when both are open, and settings open from a cog in the pad header instead of a three-dot menu.
