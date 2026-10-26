# Outlook work mail as context for Moss

Date: 2026-10-26. Status: draft from a conversation with Ben, awaiting his review.

## Intent

Ben's work mail lives in Microsoft 365. The tenant requires admin approval for any app that signs
in, and IT approval is not available yet. Moss still needs to know what is happening in that
mailbox so it can plan his day and keep his notes current.

The existing Outlook calendar collector already keeps a signed-in Chrome window on the server.
This feature reads mail through the same window, the way a person would. No app registration, no
tokens, no mailbox sync.

## Decisions (Ben, 2026-10-26)

| Question                 | Ruling                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| Which messages           | The newest messages since the previous scrape.                                   |
| How much of each message | The full text.                                                                   |
| What Moss does with it   | Reads it, and updates vault notes when it finds something important.             |
| Stored mail              | None. Moss does not keep a copy of the mailbox.                                  |
| Why not Graph or IMAP    | Tenant approval is required for Graph and for Thunderbird. Password IMAP is off. |

## Prior evidence

- Spike `spikes/o365-firefox-preview-prototype` (2026-10-21, version 0.4.3) opened a new message
  from a watched inbox and captured its full body locally. Live result: body captured, one row
  opened, 38 scans.
- Gaps from the spike. Sender showed as "Not found". Only one message per run. No restart
  recovery. No Moss ingestion.
- PR #3568 (production) runs the calendar collector. It needs exactly one Calendar page open in
  its Chrome window, and breaks when that page is anything else.

## Shape

1. A scheduled job runs after each calendar scrape, using the same Chrome window and the same
   health state.
2. It opens the Mail view, reads the inbox list, and picks rows newer than the last scrape marker.
3. It opens each new message, captures subject, sender, date, thread hint and full text, and
   returns to the Calendar view so the calendar collector keeps its single page.
4. Each message goes to an AI step through the capability router, with the sender's People record
   and related notes as context. The step returns either "nothing important" or a proposed note
   update.
5. Important findings are written to the vault through `VaultContext`. The message text is then
   dropped.
6. The job records a scrape marker and a small dedupe list (hash of message id and time). Nothing
   else about the mail is stored.

## Vault updates (my call, Ben to confirm)

- Moss appends a dated, sourced entry to the relevant existing note, or to a single "Work mail
  notes" note when no better note exists.
- Moss never edits or deletes text the user wrote.
- Each entry names the sender and subject and the date, so Ben can check it.
- Messages that ask nothing and say nothing new produce no entry.

## Privacy and rules

- Owner only. The mail feature is its own grant, separate from the calendar grant.
- Message text never enters job payloads, logs, health state, or app-wide storage. Job payloads
  carry actor id and job kind only.
- Provider-agnostic AI. The step asks for a capability. No model name appears.
- Vault writes go through `VaultContext` only.
- Moss reads only. It never sends, deletes, moves, flags or marks mail read.
- Opening a message in Outlook can mark it read. The job must keep it unread, or Ben must accept
  the change. See open questions.

## Failure behavior

- Sign-in needed or Outlook page changed. Same states and messages as the calendar collector.
- Mail view not found. Report "source changed". Do not touch the calendar page.
- A message fails to open or parse. Skip it, keep going, report a partial scrape.
- The AI step fails. Do not advance the scrape marker past that message.

## Screens

Settings shows one new row under the Outlook connection, "Work mail", with an on/off switch, the
time of the last scrape, and the count of messages read. It follows the calendar row's layout and
states. Mockups still need Ben's agreement before building.

## Open questions

1. Does opening a message mark it read in Ben's Outlook, and does he mind. Check live before
   building.
2. How many messages can one scrape handle. Proposed cap 25 per run, oldest dropped with a
   "skipped" count.
3. How often to scrape mail. Proposed every 30 minutes, same as calendar.
4. Do shared or delegated mailboxes matter. Proposed no, the primary mailbox only.

## Not in scope

Sending or drafting mail. Attachments. Search of older mail. Other mail accounts. A real Graph
connector, which replaces this when IT approves the app.
