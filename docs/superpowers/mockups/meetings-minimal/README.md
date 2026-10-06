# Meetings: the minimal meeting screen (#2981)

Static mockups for sign-off before any build. Nothing here ships. The build brief is
`docs/superpowers/specs/2026-10-06-meetings-minimal-design.md`; the review that drove it is
`critique.md` in this folder.

## Open them

Open `index.html` straight from disk in a browser. The bar across the top jumps between screens
and switches light and dark mode. Every name, meeting and line of transcript is invented.

| Screen | Shows |
| --- | --- |
| 1. Meetings list | One heading, a search box, one New meeting button, meetings grouped by week with a one-line gist |
| 2. One-time setup | Shown once after install, or on the first New meeting if skipped: link the Mac, allow microphone and computer audio, pick defaults, agree once to tell people when recording |
| 3. New meeting, ready | The meeting page open and not recording: title, the source in one line with a Change link, one Start button, empty transcript, notes ready to type |
| 4. Recording | A small timer with pause and stop, the live transcript beside the notes, and the normal docked Moss chat answering about the meeting with timestamp links |
| 5. After the meeting | Transcript beside Notes and Summary tabs, Resume, and the overflow menu open (search, rewrite summary, save to vault, copy, delete) |
| 6. Settings, Meetings | Everything that used to sit on each meeting: Mac link, what to listen to, microphone, the recording notice, summary on stop, summary style |
| 7. Phone | Ready and recording at 390 wide: Transcript and Notes tabs, Start or the timer docked at the bottom, chat from the top bar |

`tokens.css` and `fonts/` are a frozen copy of the shipped tokens and Archivo. `mockup.css` holds
only the mockup's own layout and uses token variables throughout. The folder is in
`.prettierignore` so the frozen copy stays byte-for-byte.

## What changes

| Today | Mockup |
| --- | --- |
| A large hero banner tops every Meetings view | A plain page heading on the list; the meeting page opens on the meeting title |
| Each meeting starts with "Set up your meeting" and "Check the sources" | One-time setup after install; New meeting opens a ready page and Start records |
| Capture mode chosen per meeting, with a "use as my default" switch | Capture mode, microphone and app live in Settings, Meetings; the page shows one line with a Change link |
| A consent checkbox before every recording | Agreed once in setup, shown and reviewable in Settings |
| Generate summary, template picker, versions and compare on the page | Summary writes itself on stop; rewrite and versions sit in the overflow menu |
| Device disconnect and retry buttons on the meeting | Unlink lives in Settings; problems show as one inline message with one fix |
| Content column about 786px beside an empty gutter | Transcript and notes split the full width, with chat open or closed |
