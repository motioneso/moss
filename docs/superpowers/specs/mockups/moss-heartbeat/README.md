# Moss heartbeat — mockups

Static design review for the heartbeat spec,
[Moss heartbeat](../../2026-10-25-moss-heartbeat.md), section "Agreed screens". Ben approved
all four sets as drawn on 2026-10-28, for task
[#3752](https://github.com/motioneso/moss/issues/3752).

Open `index.html` from a server rooted at the checkout, for example
`python3 -m http.server <port> --bind 0.0.0.0` from the repository root. The pages load the
repository's real Park Press tokens, shared primitive CSS, Settings and chat layout CSS and the
self-hosted Archivo font. The bottom bar belongs to the review frame. It holds a state picker per
screen, a Phone link (the same page inside a 390 px frame), a light/dark toggle and a
Forest/Canyon toggle. A state can also be opened directly, for example
`alerts.html?state=conflict` or `main.html?scene=stop&rating=up`.

| Screen               | Spec set | States covered                                                                                                                                                                                                                                                                            |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `alerts.html`        | 1        | On and hourly, edited and not saved, saving, saved, changed elsewhere, save failed, saved off, earlier proactive-off, unreadable saved choice, no AI model, source unavailable, loading, load failed                                                                                      |
| `checkins.html`      | 2        | Quiet success, sent a message, never checked, budget hold, source unavailable, repeated failure, turned off, loading, load failed. Muted topics and scheduled jobs: listed, empty, loading, load failed, removing, remove failed, confirm stop, stopping, stop failed                     |
| `main.html`          | 3        | Timecard question and reply, sports and calendar note (end time known and unknown), several items in one message, which topic to stop, topic stopped with undo, reply in progress with a draft and a new check-in, loading, load failed. Rating: not rated, up, down, saving, save failed |
| `notifications.html` | 4        | One item delivered, several items, held for quiet hours, released after quiet hours, one item expired, cancelled, loading, empty, load failed. A phone lock screen shows the push for each case                                                                                           |

The screens represent the shipped primitives' rendered markup (Switch, Segmented, Badge,
Indicator, Button, set-row and pane cards, chat message, RowIndex-style notification rows,
EmptyState). A real build must use the `@moss/ui` components. Local JavaScript only switches
states, toggles segmented choices, rating buttons and Remove/Stop buttons. There are no API calls.
Names, times, teams and appointments are fictional review fixtures.

## Choices Ben approved as drawn

1. **Settings placement.** Controls live in the Alerts & quiet hours pane as a new "Moss
   check-ins" card beside the existing email alerts and quiet hours, as the spec proposes. Status,
   muted topics and scheduled jobs sit in three columns below a one-line summary with a Change
   button. Alternative: put all of it in one tall column.
2. **No message-cap control.** Ruling 2 removed the cap, so frequency is the only numeric choice
   (every 30 minutes or every hour, hourly selected). The spec's "frequency/cap" wording is
   treated as frequency only.
3. **Save button.** Check-in settings use an explicit Save and Discard because the spec requires
   versioned saves, draft and conflict states. The existing email switch in the same pane saves on
   toggle. Alternative: save on every change and show the conflict note inline.
4. **Rating control.** Thumbs up and down sit under every check-in message, always visible, as the
   quality signal from ruling 5. The shipped chat shows its feedback menu only on hover. Always
   visible is recommended because a phone cannot hover. Nothing asks why a thumbs-down was given.
5. **Several items.** One message shows each item as its own card side by side, so the width is
   used and the items stay distinct. Alternative: a plain bulleted list.
6. **Stopping a topic.** Moss confirms in chat with a Muted pill and an Undo link. When the target
   is unclear, Moss asks with three choice chips. No approval card is introduced.
7. **Notifications.** The existing Notifications page keeps its row layout. A held row shows a
   "Push waits until 7:00 AM" badge. After quiet hours one summary push replaces the held ones, and
   the rows stay as they were. An expired item rebuilds the push from what remains. A cancelled
   push leaves only the saved Main message. The spec says "bell"; the app has a Notifications page
   and an unread count in the sidebar, so those are what is shown.
8. **Scheduled jobs list.** Each job has a Stop button that asks for confirmation inline. The list
   is read-only otherwise, matching ruling 7 (jobs are created in chat, later phase).
9. **Legacy proactive-off.** Shown as an informational note with a Turn on button rather than a
   silent off switch, so the reason for the saved-off state is visible.
10. **Phone.** The sidebar is hidden below 920 px, as in the Meetings mockups. Settings sections
    become a scrolling row of links.

Verification: pages checked at desktop and 390 px width in light and dark, with no failed asset
loads or page errors. These mockups do not start product implementation.
