# Meetings — home and meeting page mockups

Static design review of three home layouts, three meeting layouts and sensitive
meeting states. These explore the directions in the visual research and the
approved [minimal meeting screen](../../2026-10-06-meetings-minimal-design.md).
No product behavior, authentication, API, implementation spec or app-map changes
are included.

Open [index.html](index.html) from a server rooted at the checkout. From
`~/Jarv1s/.claude/worktrees/meetings-redesign-mockups`, use the assigned preview
port:

```bash
python3 -m http.server 5193 --bind 0.0.0.0
```

The mockups load the actual Park Press tokens, shared primitive CSS, docked chat
layout, paper texture and self-hosted Archivo. The existing recording mockups
supply the common review shell stylesheet. The bottom navigation and theme
controls belong to the review frame.

| Screen                                                  | What it shows                                                                                                             | Shared primitives represented                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Table](home-table.html) — recommended                  | Full-width title/date/length/attendees/type table, one Coming up strip, transcript search, type filter, locked row        | Button, ButtonLink, IconButton, input, Select, Eyebrow       |
| [Cards](home-cards.html)                                | Coming up strip and cards grouped by day; locked card has no excerpt                                                      | Card, Button, Select, Eyebrow, hint                          |
| [Split](home-split.html)                                | Narrow recording list with the open meeting beside it                                                                     | ButtonLink, Badge, Tabs, RowButton, textarea                 |
| [Side by side](meeting-side-by-side.html) — recommended | Transcript beside editable summary and personal notes, draggable divider, docked Moss chat; tabs at narrow content widths | Button, IconButton, Badge, RowButton, Tabs, textarea, Thread |
| [Single note](meeting-single-note.html)                 | One scrolling note, transcript revealed with a button                                                                     | Button, RowButton, textarea                                  |
| [Tabs](meeting-tabs.html)                               | Summary and Transcript tabs, people and related-event panel                                                               | Tabs, Badge, Avatar, ButtonLink                              |
| [Password](sensitive-lock.html)                         | App-password entry before any meeting content is mounted                                                                  | Field, FormLabel, input, Button, ButtonLink                  |
| [Wrong password](sensitive-error.html)                  | Incorrect-password error with retry and cancel                                                                            | Field error, FormLabel, input, Button                        |
| [Unlocked](sensitive-unlocked.html)                     | Fictional sensitive content and an always-visible Lock action                                                             | Badge, ButtonLink, RowButton, Tabs                           |
| [Regenerate warning](regenerate-warning.html)           | Explicit replacement warning after hand edits; Keep edits receives initial focus                                          | Dialog, Button                                               |

These HTML files represent rendered primitive markup rather than mounting React.
A future implementation must use the corresponding `@moss/ui` components and
their lifecycle contracts. Local JavaScript filters fictional fixtures, seeks the
illustrated audio bar, resizes the divider, changes tabs, opens chat and dialogs,
and demonstrates summary edits. It makes no API requests or persistent writes.
Playback is a visual fixture: there is no audio file or real recording.

Review interactions:

- Search **contrast** to find a recording by transcript text absent from its title.
  Search combines with the recording-type selector. Locked rows have no transcript
  or summary in their markup or search data.
- Click any transcript or summary line to move the audio bar to its timestamp.
  The divider also accepts Left/Right arrows and Home/End. At narrow content widths,
  Transcript and Notes become tabs with arrow-key navigation.
- Edit a summary, save it, then choose Regenerate. Keep edits cancels; Replace
  summary discards the edited summary and leaves personal notes intact.
- Mark as sensitive opens a confirmation. The locked row leads to the password
  screen. Use the fictional review password **preview** for the unlocked fixture;
  any other nonempty input opens the wrong-password fixture. Never enter a real
  password. The unlocked fixture can also be opened directly from the review index:
  this is navigation between static screens, not authentication or a security boundary.
- Lock returns to the empty password screen. Chat is unavailable on locked screens;
  their markup contains no sensitive transcript, summary or chat context. Chat on
  the unlocked screen starts empty. Phone chat is an overlay with Escape, focus
  containment and return to its opener.

Names, content, dates, attendees and events are fictional. The module title and
settings cog appear once in the app header; the home body adds neither. Existing
Add recording and Calendar destinations link to the earlier static review bundle.
New meeting and playback controls only announce a preview action.

Verification: Firefox checks passed at 1280 × 1800, 1440 × 960, 390 × 844 and
320 × 760 in Forest and Canyon, light and dark. Search/filter combinations,
transcript and summary seeking, divider dragging and keyboard resizing, responsive
tabs, edit/regenerate warnings, password navigation, relocking and docked/mobile
chat were exercised. Escape preserves edits after earlier saves or replacements;
phone chat contains focus and restores its opener. The audio bar is visible on
entry. Formatting, scoped ESLint, design-token checks and the shared/local class
audits passed. All eleven screens loaded with no page errors, failed assets or API requests.

These mockups do not start product implementation.
