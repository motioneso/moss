# Unread Moss messages on the chat button

Status: approved by Ben in chat on 2026-10-14; implementation underway.
Task: #3520. Repository: `~/Jarv1s`.

## Request and intended behavior

Moss can deliver a message or reminder while the chat drawer is closed. The existing chat button
does not indicate that anything arrived. Add an unread count to that button on desktop and phone.

The count includes completed, saved Moss messages in the owner's Main and side chats, including
reminders and background results. User messages, thinking, tool progress, streaming partial text,
and status records do not count. A message contributes once, regardless of retries or reconnects.

## Proposed presentation

Keep the existing chat icon, location, focus behavior, and assistant name. Use the shared badge
primitive with the existing accent tone, positioned at the chat button's upper trailing edge.
Use design-system tokens and the minimum 11px text size, without animation.

```text
Closed, nothing unread     Closed, two unread      Closed, over 99 unread
     [ chat ]                 [ chat (2) ]              [ chat (99+) ]

Open drawer: no badge on the chat button.
Conversation picker: Main (2), Trip planning (1), Other conversation.
```

The badge is decorative to assistive technology; a separate accessible description on the button
announces the exact count, such as "2 unread messages". Keep the existing accessible button name
so keyboard and automation entry points remain stable. A visual count is never the only cue.

Opening chat marks the conversation's messages read only after they have successfully loaded
into a visible, active drawer. New messages in that visible conversation are read as they arrive.
A hidden browser tab, loading failure, meeting drawer, or another selected conversation does not
mark those messages read. Opening chat with unread messages in another conversation preserves
their count; the conversation picker indicates where they are. Closing chat restores the total
badge if another conversation remains unread. This does not require scrolling through every row.

## Persistence and delivery

Unread state belongs to the signed-in owner and persists across reloads. Reading a conversation
in one tab or device updates the other clients after refresh/synchronization. Existing history
starts read at rollout; do not turn the entire chat archive into notifications.

Read acknowledgement covers only the messages actually loaded. A message that arrives during a
history request must not be cleared by that request's acknowledgement. Retried or older
acknowledgements cannot move read state backwards or hide a newer message. Catch-up derives from
saved messages, so an interrupted event connection cannot permanently lose an unread message.

Count messages independently of which transcript is selected or which module is open. The
transcript stream remains scoped to the selected conversation. Do not deliver another thread's
body into the selected thread to drive the badge. Private chats and module-owned transcripts
remain outside this Main/side-chat unread count; the indicator must not expose another owner's
conversation metadata.

This is an in-app indicator. Quiet hours and notification/device preferences retain their
existing behavior; a saved reminder can be unread in Moss even when outward alerts are held.

## Implementation seams verified in the current checkout

- `apps/web/src/shell/app-shell.tsx`: owns drawer visibility and the chat button; keeps
  `useChatStream` mounted while chat is closed.
- `apps/web/src/chat/use-chat-stream.ts`: maintains the selected transcript and filters
  background arrivals by selected thread. Its records cannot be the unread source for all chats.
- `packages/chat/src/reminders/live-arrival.ts`: publishes committed reminder arrivals with
  message and thread identity, then re-reads stored messages under owner access.
- `packages/shared/src/app-map-core.ts`: describe the badge and when messages become read in
  the same implementation PR. Do not advertise the feature in this docs-only proposal.

Implementation should keep durable unread/read handling in chat, expose a small shared contract
for counts and read acknowledgement, and reuse existing synchronization mechanisms where they
fit. Add a new migration if needed; do not edit applied migrations. Exact storage and endpoint
shapes belong in the implementation plan after design approval.

## Acceptance and verification

1. Close the drawer, deliver a real reminder, and observe a count of one. Open the receiving
   conversation, observe the stored message, close chat, and observe no badge.
2. Start a normal reply, close chat before completion, and observe one unread message when the
   reply completes. Partial chunks, tool records, duplicate events, and reconnects add no extras.
3. Deliver to Main while a side chat is selected and to a side chat while Main is selected.
   Verify the total while closed, per-conversation picker counts, and clearing only the chat read.
4. Reload and interrupt/reconnect the stream with unread messages present. Verify durable counts
   and recovery from saved messages. Reading in another client eventually clears the same count.
5. Exercise arrival during history loading, failed loading, older acknowledgement retries,
   background-tab delivery, first-run history baseline, and signed-in owner changes.
6. Verify foreign-owner/private/module data stays outside the count, and existing quiet-hours
   and push behavior is preserved. Follow the repo's security-claim verification requirements.
7. Verify accessible descriptions, zero/one/many/99+ states, desktop and phone layout, light/dark
   and a park theme, design-token checks, UI-class checks, scoped tests, lint, and typecheck.

Run DB checks only through the `verify-gate` skill. Record real UI/worker evidence on the product
PR before merge readiness. Approval authorizes implementation, not deployment.
