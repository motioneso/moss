# Outlook work mail as context for Moss

Date: 2026-10-26. Status: draft, awaiting review.

## Intent

Many people keep their work mail in Microsoft 365, and many employers require admin approval for
any app that signs in. Those users cannot connect Moss to their mail through a normal connector,
yet Moss still needs to know what is happening in the mailbox so it can plan their day and keep
their notes current.

The Outlook calendar collector already keeps a signed-in browser window on the server for each
connected user. This feature reads mail through the same window, the way a person would. No app
registration, no tokens, no mailbox sync, no admin approval.

## Decisions

| Question                 | Ruling                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| Which messages           | The newest messages since the previous scrape.                                   |
| How much of each message | The full text.                                                                   |
| What Moss does with it   | Reads it, and updates vault notes when it finds something important.             |
| Stored mail              | None. Moss does not keep a copy of the mailbox.                                  |
| Why not Graph or IMAP    | Graph and desktop mail apps need tenant approval. Password IMAP is off.          |

## Prior evidence

- Spike `spikes/o365-firefox-preview-prototype` (2026-10-21, version 0.4.3) opened a new message
  from a watched inbox and captured its full body locally. Live result: body captured, one row
  opened, 38 scans.
- Gaps from the spike. The sender showed as "Not found". Only one message per run. No restart
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

## Two ways to read mail

Both routes feed the same processing, preferences, vault rules and last-read marker. They differ
only in where the reading happens.

| Route                     | Where it reads                                | Best for                                  |
| ------------------------- | --------------------------------------------- | ----------------------------------------- |
| Add-on (first)            | The user's own browser, signed in to Outlook  | Users who may install add-ons             |
| Server window (second)    | A signed-in browser window on the Moss server | Users who cannot install add-ons          |

The Shape section below describes the server window route. The add-on route differs as follows.

### Add-on route

- The add-on grows out of `spikes/o365-firefox-preview-prototype`. The prototype is a throwaway
  that loads only as a temporary add-on and is blocked from any network request. The product
  add-on adds a connection to the user's own Moss and nothing else.
- Moss offers the add-on for download from Settings, next to the "Work mail" row, with plain
  install steps. Moss hosts a signed package so no store account is needed for Firefox.
- Pairing. Settings shows a one-time pairing code. The user enters it in the add-on, which then
  holds a per-user token that Moss can revoke from Settings. The add-on may call only the paired
  Moss address.
- While the user has Outlook open, the add-on finds messages newer than the last-read marker,
  opens each, and sends the message text to Moss over HTTPS. Moss replies with the new marker.
- Message text is handled in the request that receives it and is dropped afterwards. It never
  goes into a job payload. If processing cannot finish in the request, Moss stores nothing and
  asks the add-on to resend (see open questions).
- Mail only flows while the user's browser is open on Outlook. The settings row shows the time
  of the last read so a gap is visible.
- Chrome and Edge packaging needs a store listing or an enterprise install, and is a later step.
  Firefox ships first because the prototype already runs there.

## Mail preferences (per user, kept in Moss memory)

Each user tells Moss how to handle their mail in plain words, in chat or in settings. Moss saves
each instruction as a preference fact in its memory, so it shows up in the memory screen, can be
edited or forgotten there, and is read by the AI step on every scrape.

- Examples. "Ignore newsletters." "Only note things from my manager and my direct reports."
  "Keep a running note per client." "Never write anything about HR mail."
- Preferences cover what counts as important, which senders to include or skip, where findings go
  in the vault, how long entries stay, and how much of a message Moss may quote.
- Defaults apply until the user says otherwise. Defaults are the values below, and the user can
  change each one.

| Setting                | Default                                                      |
| ---------------------- | ------------------------------------------------------------ |
| Messages per scrape    | Newest since the last scrape, capped at 25                   |
| Scrape interval        | 30 minutes                                                   |
| Read depth             | Full text, processed and dropped                             |
| Vault destination      | The relevant existing note, else one "Work mail notes" note  |
| Write style            | Append dated, sourced entries. Never edit the user's text    |
| Entry for plain mail   | None when a message asks nothing and says nothing new        |

Limits no preference can change. Moss stays read-only on the mailbox, keeps no mail copy, and
never writes to a note the user marked private.

## More than one user

The calendar collector today binds one Chrome profile to exactly one Moss owner through operator
settings. Mail inherits that rule and does not weaken it. For other people to use this:

- Each user gets their own signed-in browser profile and their own mail grant. One user's
  profile never reads another user's mailbox.
- Setup is done in the app by the user, not by editing operator files. This depends on the
  per-user Outlook setup work in issue 3570 and must not ship ahead of it.
- Preferences, vault entries, scrape markers and health state are per user.
- The reader is a per-provider adapter behind one shared job. Outlook on the web is the first
  adapter. Gmail on the web or others can follow without changing the job, the preferences or the
  vault rules. Providers with a real approved connector use that instead.
- Pitch for others. This route needs no admin approval, which helps anyone whose employer blocks
  third-party apps. It is not a replacement for a proper connector when one is allowed.

## Privacy and rules

- Owner only. The mail feature is its own grant, separate from the calendar grant.
- Message text never enters job payloads, logs, health state, or app-wide storage. Job payloads
  carry actor id and job kind only.
- Provider-agnostic AI. The step asks for a capability. No model name appears.
- Vault writes go through `VaultContext` only.
- Moss reads only. It never sends, deletes, moves, flags or marks mail unread.
- Opening a message in Outlook marks it read (confirmed live, 2026-10-26). Users change no Outlook
  setting. Moss accepts that messages it reads become read, and tells the user so in
  settings. Moss never marks anything unread again, because that would be a mailbox write.
- Moss does not rely on read or unread state to find new mail. It tracks the last message it read
  (sender, subject, received time and a hash of them) and reads only messages newer than that
  marker. The dedupe list covers messages that arrive out of order.

## Failure behavior

- Sign-in needed or Outlook page changed. Same states and messages as the calendar collector.
- Mail view not found. Report "source changed". Do not touch the calendar page.
- A message fails to open or parse. Skip it, keep going, report a partial scrape.
- The AI step fails. Do not advance the scrape marker past that message.

## Screens

Settings shows one new row under the Outlook connection, "Work mail", with an on/off switch, the
time of the last scrape, and the count of messages read. It follows the calendar row's layout and
states. Mockups need approval before building.

## Open questions

1. How Moss orders the inbox when the list is sorted by something other than received time.
   Proposed, Moss sets the sort to newest first in its own window only.
2. Where users set mail preferences. Proposed chat first, with the saved facts visible in the
   memory screen, and no separate settings form for them.
3. Do shared or delegated mailboxes matter. Proposed no, the primary mailbox only.
4. Whether per-user browser profiles are practical on a shared server. Depends on issue 3570.
5. Where the add-on route processes message text, given that job payloads cannot carry it.
   Proposed, process inside the receiving request with a time limit, and have the add-on retry.
6. Whether employers that block add-ons also block this one. Cannot be known in advance, so the
   server window route stays as the fallback.

## Not in scope

Sending or drafting mail. Attachments. Search of older mail. Other mail accounts. A real Graph
connector, which replaces this when IT approves the app.
