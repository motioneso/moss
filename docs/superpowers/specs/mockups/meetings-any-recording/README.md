# Meetings for any recording — mockups

Static design review for #3777. The source spec is
[Meetings for any recording](../../2026-10-26-meetings-any-recording-design.md).

Open `index.html` from a server rooted at the checkout. For example, from
`~/Jarv1s/.claude/worktrees/meetings-mockups`, use the assigned preview port:

```bash
python3 -m http.server 5180 --bind 0.0.0.0
```

The mockups load the repository's actual Park Press tokens, shared primitive CSS,
chat layout and paper texture. Self-hosted Archivo resolves through relative URLs,
so the preview needs no font path alias. The bottom navigation belongs to the
review frame.

| Screen            | Shared primitives represented                                 |
| ----------------- | ------------------------------------------------------------- |
| Recording type    | Button (`chip`), Menu with checked items, Badge, Tabs         |
| What Moss took    | Card, Button (`link`), Badge, Dialog, Field, FormLabel        |
| Type conversation | Thread, Chip, Button, IconButton; existing docked chat layout |
| Manual entry      | Field, FormLabel, Tabs, Button, input, select, textarea       |
| Type filter       | Field, FormLabel, Select, input, Button                       |
| Calendar link     | EventChip, PeekPanel, PeekCloseButton, ButtonLink, Segmented  |

These HTML files represent the primitives' rendered markup rather than mounting
React. Local JavaScript opens the menu, switches tabs, edits sample changes,
undoes/restores them, and demonstrates input states. Submission and chat are
fixtures; there are no API requests or persistent writes. A future implementation
must use the corresponding `@moss/ui` components and their lifecycle contracts.

Names, note paths, content and timestamps are fictional review fixtures. The note
paths illustrate an existing user folder layout; they prescribe no filing method.
The settings cog and New meeting controls mark existing destinations, outside
these designs. Transcript/notes and chat retain the current wide layout.
Phone chat overlays the page.

Ben approved all six review screens on 2026-10-26: recording type, What Moss took,
type configuration chat, manual entry, type filtering and the Calendar link.

The Calendar action opens `linked-meeting.html`, a supporting
fixture of the corresponding work meeting. The second Calendar event demonstrates
an event without a linked recording. The Meetings filter combines type and text
search; its Field notes option illustrates a user-defined type.

Verification: Firefox checks passed for menu keyboard controls, editing and
undo/restore, transcript/audio input states, combined search and type filtering,
Calendar navigation to the matching meeting, and the absence of that action on
an unlinked event. The screens were checked at desktop and phone widths and in
Forest light/dark and Canyon themes. There were no page errors or failed assets;
formatting and the shared-class audit passed.

These mockups do not start product implementation.
