> Historical critique of the earlier interface, preserved as design history only. The [current spec](../../specs/2026-10-06-meetings-minimal-design.md) and its local approved screens supersede every proposed setup control below, including the old capture-mode and device-approval steps.

# Meetings screens: critique (#2981)

- Date: 2026-10-05
- Branch: `feat/2981-native-meeting-capture` at `28a5a6beb` (capture controls from PR 3056)
- Method: Impeccable critique, two independent passes merged here
  - A: design review, heuristic scoring, control inventory, personas
  - B: automated detector, invented-class audit, browser overlay, layout measurements
- Viewports: 1440x900 and 390x844, dark theme
- Screens: meetings list and history, a new meeting, a meeting while recording, a meeting after it ends

## Direction

Ben, 2026-10-05:

> "Make sure we have impeccable critique it, and critique it hard (especially all of the settings
> and buttons, those should not be required for every meeting nor should it be so much up top.
> Look at meetily and other apps to see how minimal it should be (pretty much just transcript and
> a spot for notes, and the chat can dock like it does normally and the user can chat with Moss
> about the transcript."

Correction, same day: New meeting opens the meeting page; one Start click records with the
one-time defaults and asks nothing.

## What was on screen, and what was judged from code

- Real data only. No response was intercepted or faked.
- One meeting was created through the real form, notes typed and saved, then deleted through the
  page's own delete button.
- Judged from code, not seen:
  - Capture controls. The shared dev API runs `main`, which lacks the capture routes; the panel
    rendered only its error state.
  - Transcript content. No path adds a transcript without capture.
  - Summary and suggested tasks. Dev has no model that can write summaries (CLI models are not
    supported for summaries).
- Above-the-fold calls for those controls are estimated from render order and spacing.

## Design health score

| # | Heuristic | Score | Key issue |
| --- | --- | --- | --- |
| 1 | Visibility of system status | 2 | Much status, some wrong: a missing capture route reads "Sign in again" (capture-panel.tsx:170); history shows "Capture: Unavailable" for every meeting, hardcoded (meeting-history.tsx:259) |
| 2 | Match with the real world | 1 | Internal words: "draft", "retained", "provisional", "Output scope", "Source labels only", template "v1", "Trail Marker" unexplained |
| 3 | User control and freedom | 2 | Pause, resume, stop and a clear delete exist; notes need manual save; title fixed after create; page opens on Summary |
| 4 | Consistency and standards | 2 | Four "01" heads on one page; tabs repeat their label as a heading; a bespoke Ask Moss beside the app's chat button |
| 5 | Error prevention | 3 | Strong guards (unload warning, notes kept across navigation, idempotent retries); "Start meeting" permanently disabled with no visible reason |
| 6 | Recognition over recall | 2 | Capture mode picked on two screens; template picked every generation; save notes before generating |
| 7 | Flexibility and efficiency | 1 | Title required; no shortcuts; history needs row then Open review; no autosave or auto-summary |
| 8 | Aesthetic and minimalist design | 0 | At 1440x900 the meeting page shows no transcript and no notes above the fold |
| 9 | Error recovery | 2 | Many specific retries; some diagnoses wrong or technical |
| 10 | Help and documentation | 2 | Hints everywhere; the Mac app is never explained or linked |
| | Total | 17/40 | Poor |

## Design specificity

The screens are built from Moss parts and look like Moss: field masthead, numbered heads,
Archivo. The composition is generic. It stacks a settings form on a status dashboard on a tabbed
admin panel. A meeting's defining object is the transcript growing while you listen, and it sits
in the second tab. The space goes to showing the system is careful (consent switches, source
labels, revision pickers, receipts) instead of to the meeting.

## Priority issues

### P0

1. **The meeting page hides the meeting.** No transcript or note shows on arrival at 1440x900.
   Above the tabs sit the capture block (capture-panel.tsx:161-358), a status row, a chat hint,
   and the page opens on Summary (meeting-record.tsx:114). The header band alone takes the top
   409px, 45% of the fold. On a phone the tabs start at y=612 of 844.
   Fix: transcript and notes side by side at full width; a compact record pill in the title row.
2. **Every meeting starts with a setup form, and Start never works.** Title, three mode cards and
   a default switch come first (meeting-setup.tsx:108-182). The meeting page then asks again:
   mode, microphone, app, consent switch, and device approval for this meeting only
   (capture-sources.tsx:17-103, capture-panel.tsx:194-231). "Start meeting" is hard-disabled
   (meeting-setup.tsx:212); "Create draft" sits below the fold at y=986 (y=1356 on a phone).
   Fix: one-time setup, New meeting opens a ready page, Start uses the defaults.

### P1

3. **Chat is split in two.** The normal drawer on a meeting page shows generic prompts and does
   not know the meeting (seen live). A separate Ask Moss button gives chat the meeting
   (meeting-record.tsx:239-246, meeting-history-rail.tsx:93-101) and stays disabled until a
   transcript exists (meeting-record.tsx:121), so notes alone cannot be discussed.
   Fix: the normal drawer picks up the open meeting (transcript so far plus notes) by itself.
4. **The end of a meeting is a chore list.** Pick a template every time, press Generate, refresh,
   flip "Create in my Tasks after owner review" before each Accept unlocks
   (meeting-action-review.tsx:131-176), then save to vault as its own step.
   Fix: summary on stop with the default style; Add to Tasks per row is the review.
5. **Notes leave the screen when recording starts.** The tab switches to Transcript
   (meeting-record.tsx:115-117) at the moment the user wants to type.
6. **Copy misleads or speaks in internals.** A missing route reads as access denied; constant
   "Unavailable" values in history and the rail (meeting-history-rail.tsx:47, 135-137); "draft"
   for a finished meeting.

### P2

7. **Capture-mode radios render as large white discs.** The native radio measures 347x40. The
   global rule `input, select, textarea { width: 100% ... }` (apps/web/src/styles.css:134) beats
   the shared radio-card style. Every screen using radio cards is likely affected; fix in the
   shared style.
8. **Active tab reads as disabled.** In dark theme the selected tab is dimmer than the others.
9. **About ten live regions.** The capture panel polls every second and the transcript every two;
   likely screen-reader chatter during a meeting (risk, not observed).
10. **History is an audit view.** Constant columns, a five-way state filter, and a side rail of
    8 to 10 facts per meeting; opening a meeting takes two clicks.

### P3

11. The "capture unavailable" note runs about 189 characters per line; cap its width.
12. Section grids use the largest gap between one-line hints, so sentences float 50 to 60px apart.
13. Dead module CSS: `.meetings-modes` and `.meetings-workspace` (styles.css:23, 33).
14. Delete sits one tab stop from Ask Moss in the status row.

## Persona red flags

- **Power user.** No shortcut for start, pause or stop. Cannot create a meeting without a title.
  Re-picks the summary template every time.
- **Accessibility.** Selected tab looks disabled. Key facts sit in small muted hints. Radio state
  cannot be read from the white discs. Delete is next to a common action.
- **Phone.** Create sits a screen and a half down. The first note or transcript line is below the
  fold. History's banner pushes the first row to y=802. The phone's real job is reading notes and
  asking Moss, and it gets the least space.

## What works, keep it

- Unload warning while recording; unsaved notes kept across navigation; idempotent retries; the
  notes conflict view; a delete dialog that says what stays.
- Summary claims and suggested tasks carry transcript evidence; nothing enters Tasks without the
  owner.
- Shared primitives and layout-only module CSS. Detector clean on `packages/meetings/src/web`,
  verified against a seeded bad file. Invented-class audit clean (9 shared, 28 module classes).

## Control inventory

Verdicts: **Keep** on the meeting page; **Setup** asked once after install; **Settings** changed
later in Settings, Meetings; **On demand** shown only when it applies; **Remove**.

### List and history

| Control | Verdict | New home |
| --- | --- | --- |
| Masthead "Meeting companion" / "Your meetings" banner | Remove | Plain "Meetings" heading |
| View meeting history / New meeting draft toggle | Remove | List is the landing; one "New meeting" |
| Search meetings | Keep | Top of the list |
| State filter (five options) and its word-limit hint | Remove | Search covers it |
| Columns Capture (constant), Processing, Vault | Remove | Length and a one-line gist |
| Row selects into a side rail; rail facts; Open review | Remove | Row opens the meeting |
| Ask Moss in the rail | Remove | Normal chat drawer |
| "Pick up the conversation" section | Remove | None |

### Starting a meeting

| Control | Verdict | New home |
| --- | --- | --- |
| "01 Set up your meeting" form | Remove | New meeting opens the ready page |
| Meeting title (required) | On demand | "Untitled meeting", renamed inline or from the summary |
| Three capture-mode cards | Setup, Settings | Listen to; default microphone and computer audio |
| "Use this capture mode as my default" switch | Remove | The setting is the default |
| Computer-audio warning | Setup | Said once beside that choice |
| "02 Check the sources" and the Mac app instructions | Setup | Your Mac |
| Create draft, Start meeting (disabled) | Remove | New meeting, then Start in the page |

### During a meeting

| Control | Verdict | New home |
| --- | --- | --- |
| Status dot, elapsed time | Keep | Record pill |
| Record / Resume, Pause, Stop and review | Keep | Record pill: Start, pause, stop |
| Device name, capture scope labels | Settings | Your Mac; one source line before Start |
| Prepare this meeting, Approve this device (per meeting) | Setup | One-time Mac link; decision for Ben and a security review |
| Repeated mode cards, Microphone and Selected app pickers | Settings | Listen to, Microphone, Meeting app |
| Permission hints, transcription unavailable | Setup | Setup checks; one inline message if it breaks |
| Gap warnings and list | On demand | Inline gap markers in the transcript |
| Retry capture command, Refresh capture status | On demand | One message, one fix |
| Disconnect device, Stop and disconnect device | Settings | Unlink |
| "Source labels only" badge, status badge and sentence | Remove | The pill says it |
| View transcript link | Remove | Transcript always visible |
| Ask Moss and its hints | Remove | Normal chat drawer |
| Delete draft | On demand | Menu, "Delete meeting" |
| Tabs Summary / Transcript / My notes | Remove | Two panes; Notes and Summary tabs after stop |
| Refresh transcript, revision pickers, "Read only" | Remove / On demand | Live updates; earlier revisions in the menu |
| Notes area | Keep | Always visible, autosave |
| Save notes, long unsaved-changes sentence | Remove | "Saved" |
| Notes conflict view | On demand | Keep as is |
| Citation panel above the tabs | On demand | Scroll to and highlight the cited line |

### After a meeting

| Control | Verdict | New home |
| --- | --- | --- |
| Summary template select | Settings | Summary style; Rewrite summary in the menu |
| Generate summary, Refresh summaries | Remove | Summary on stop |
| Model availability hints | Setup | Setup check; one line if it breaks |
| "Save your edits first" note | Remove | Autosave |
| Saved version select, Compare with latest | On demand | Menu, Earlier versions |
| Edit this version | On demand | Edit in the Summary tab |
| Summary content, decisions, open questions | Keep | Summary tab beside Notes |
| Suggested task rows | Keep | One row each with Add to Tasks |
| "Create in my Tasks after owner review" switch | Remove | Add is the review |
| Possible-duplicate switch | On demand | One inline line |
| "03 Save to vault" section | On demand | Menu, Save to vault |
| Delete dialog | On demand | Keep; say "meeting", not "draft" |

## Out of scope, seen along the way

- The dev account's saved theme sets a dark page but keeps light-mode hint colours, so hints fail
  contrast at 2.5:1. A theme editor issue, not Meetings code.
- Sidebar group labels render at 9px, app-wide.
- The floating bottom-right button overlaps the history rail and the chat send area, app-wide.
