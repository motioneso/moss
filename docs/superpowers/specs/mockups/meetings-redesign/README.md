# Meetings — home and meeting page mockups

Static design review of the selected full-width table and side-by-side meeting
page. Round two adds sourced prior context, editable attendees and speaker
mapping. These follow the approved [minimal meeting screen](../../2026-10-06-meetings-minimal-design.md).
No product behavior, authentication, API, implementation spec or app-map changes
are included.

Open [index.html](index.html) from a server rooted at the checkout. From
`~/Jarv1s/.claude/worktrees/meetings-redesign-mockups`, use the assigned preview
port:

```bash
python3 -m http.server 5193 --bind 0.0.0.0
```

The mockups load actual Park Press tokens, shared primitive CSS, docked chat,
paper texture and self-hosted Archivo. The earlier recording mockups supply the
common review shell stylesheet. Bottom navigation and theme controls belong to
the review frame.

| Screen                                        | What it shows                                                                                                             | Shared primitives represented                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Table](home-table.html)                      | Coming up strip, transcript search and type filter; locked rows expose no content                                         | Button, ButtonLink, IconButton, input, Select, Eyebrow       |
| [Mapped](meeting-side-by-side.html)           | Compact sourced context and attendee chips above transcript/notes; draggable divider, narrow-width tabs, docked Moss chat | Button, IconButton, Badge, RowButton, Tabs, textarea, Thread |
| [Unmapped](meeting-unmapped.html)             | Speaker 1 and Speaker 2, live assignment selectors, a past-meeting suggestion with Accept and Dismiss                     | Select, Button, ButtonLink                                   |
| [Edit attendee](attendee-editing.html)        | Attendee dialog open with Person, Name, Remove, Cancel and Save                                                           | Dialog, input, Select, Button                                |
| [Password](sensitive-lock.html)               | App-password entry with no sensitive context mounted                                                                      | Field, FormLabel, input, Button, ButtonLink                  |
| [Wrong password](sensitive-error.html)        | Incorrect-password state with retry and cancel                                                                            | Field error, FormLabel, input, Button                        |
| [Unlocked](sensitive-unlocked.html)           | Private prior context and sources, editable attendees, transcript/notes and Lock                                          | Badge, ButtonLink, RowButton, Tabs, Dialog                   |
| [Regenerate warning](regenerate-warning.html) | Replacement warning after hand edits; Keep edits starts focused                                                           | Dialog, Button                                               |

Review interactions:

- Search **contrast** to match transcript text absent from a recording's title.
  Search combines with the type selector. The sensitive row has no names, source
  text, transcript or summary in its markup or search data.
- Open each source beneath **Where this left off** or **Open actions** to read
  its fictional past meeting or note. Normal meeting sources contain only normal
  fixtures. Private source text and templates exist only on the unlocked screen.
- Click an attendee chip to rename it or choose another person; save updates all
  mapped lines immediately. Remove returns that attendee's voices to unassigned.
  Add attendee creates another choice in the voice selectors. Changes are local
  to the page and reset on reload.
- Expand **Voices** to assign each voice. On Unmapped, accept the Morgan suggestion
  to update both Speaker 1 lines, or dismiss it and choose an attendee manually.
  Speaker 2 can be assigned independently. Each transcript line shows its name.
- Use the pencil beside a transcript line to correct that line alone. Choose
  **Split into two speakers**, pick where the second speaker starts, and assign
  that segment. The first part keeps its original voice. An unassigned segment
  gets a new Speaker number and voice selector. Both parts retain the original
  timestamp; the fixture does not infer an audio boundary.
- Click any transcript or summary line to seek the illustrated audio bar. Resize
  the divider by dragging or with Left/Right and Home/End. At narrow content widths,
  Transcript and Notes become tabs with arrow-key navigation.
- Edit the summary, save, then Regenerate. Keep edits cancels; Replace summary
  discards summary edits and leaves personal notes intact.
- Mark as sensitive opens a confirmation. Use the fictional review password
  **preview** to navigate from Password to Unlocked; any other nonempty value
  opens Wrong password. Never enter a real password. Unlocked is directly linked
  for review: these static screens are not authentication or a security boundary.
- Lock returns to the empty password screen. Locked screens mount no transcript,
  summary, prior context or chat. Unlocked chat starts empty. Chat docks on desktop
  and opens as a modal drawer on phones, with Escape and focus return.

HTML represents rendered primitive markup rather than mounting React. A future
implementation must use the corresponding `@moss/ui` components and lifecycle
contracts. Local JavaScript demonstrates fixtures without API calls, persistent
writes or real playback. Names, content, dates, attendees and events are fictional.
The module title and settings cog appear once in the app header. Existing Add
recording and Calendar links lead to the earlier static review bundle.

Verification: Firefox exercised all nine screens at 1280 × 800 and 390 × 844
in Forest light and dark. The selected home/meeting layouts, unmapped state and
unlocked screen also passed Canyon light/dark at 1440 × 900 and 320 × 760.
All nine screens received an additional 320px scroll-containment check. Both
mapped and unmapped first transcript/summary lines fit above the laptop fold.
Source openings, attendee add/rename/change/remove, full-voice assignment,
suggestion accept/dismiss, line reassignment/splitting, search/filter, seeking,
divider drag/keys, summary warnings, password/relock and docked/modal chat were
exercised. Native dialog text follows the light/dark foreground. No page errors,
failed assets or API requests were observed. Prettier, scoped ESLint, design-token
and shared/local class audits passed.

These mockups do not start product implementation.
