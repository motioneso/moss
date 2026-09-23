# Trail Marker screen history

Status: **Draft for Ben's review, 2026-09-23** (#2638). Not approved. The decisions in §2 are Ben's; every
other choice is a proposal. The mockups in §9 are for discussion and are not yet agreed, so no build
starts until they are.

Builds on `2026-09-20-trail-marker-mac-companion.md` (the linked Mac) and sits beside
`2026-09-20-trail-marker-focus-judgment.md` (focus). It is a separate feature with its own consent.
It **deliberately reverses** several promises in those two specs; §11 lists each one and how it is
amended.

## 1. What this is

When the person turns it on, Trail Marker reads the text on their screen through the day (the
message they read, the page they had open, the doc in the meeting) and keeps it as their private,
searchable **screen history** in Moss. Later they can ask Moss "what was that site I saw in the
meeting this morning?" and Moss answers from that history, citing the app, the page and the time.

Whatever the person views, Trail Marker reads, unless the app is on their Never watch list. The
product question: is a text-only memory of your day, captured without any effort from you, useful
enough to be worth what it costs in privacy and battery?

## 2. Decisions already made (Ben, 2026-09-23)

- **Stored in Moss, text only.** The Mac reads the screen itself with Apple's on-device text
  recognition (no AI call and no network involved), strips secrets, and sends only text to the
  person's Moss account. No screenshots are kept anywhere, on the Mac or on the server.
- **What is kept per moment:** the words on screen, the app, the window title, the web address when
  there is one, and the time.
- **Retention:** the full text is kept for 30 days. After that each day is summarized into a note,
  and the raw text for that day is deleted. The note goes into the person's attached notes folder
  when they have one, and otherwise into Moss's private notes store.
- **Blocking wins.** Everything on the Never watch list (the person's own list, the built-in
  password managers and Keychain, and private-browsing windows) is never read.

## 3. Non-goals

- Pictures of the screen, video, audio, keystrokes or clipboard.
- Productivity scores, time-tracking reports or dashboards about the person. This is recall, not
  surveillance of yourself.
- Anyone other than the person reading their history. Admins included: the history is owner-only
  under row-level security, like the rest of Moss.
- Feeding the history into answers the person did not ask about. §7 covers this.
- Sharing, a timeline UI, or visual replay. These are possible later slices, each needing its own
  spec.

## 4. Consent and control

- **Off by default. It is a separate opt-in from Focus.** Turning it on shows a one-time sheet (§9b)
  that says plainly what is read, what is sent, where it is kept and for how long. Turning Focus on
  never turns screen history on, and the reverse is also true.
- It needs Screen Recording (already requested for focus vision). It works with or without Focus.
- **Always visible.** While screen history is recording, the menu-bar icon shows a small dot, and
  the menu's status line says "Recording screen history".
- **The one Pause** in the menu (Ben, 2026-09-23) stops screen history as well; nothing is read
  while paused. A screen lock or sleep also stops it.
- The person can delete from Moss (§9c): the last hour, today, any day, or everything. Deletion
  removes the raw text, its search index and, where asked, that day's summary note.
- Logging Trail Marker out or revoking the Mac stops capture, and the Mac discards anything it has
  not yet sent.

## 5. Capture on the Mac

- **When it reads:** on an app switch, a window-title change, and otherwise at most every 10
  seconds while the frontmost window's pixels have changed. A cheap check on a tiny downscaled frame
  decides "changed". An unchanged screen costs nothing but that check.
- **What it reads:** only the frontmost window of an allowed app, never the whole display. This is
  the same window selection focus capture uses, `ScreenCaptureKitCapture`, reused behind the
  `WindowCapturing` protocol.
- **Text recognition:** Apple Vision `VNRecognizeTextRequest`, on-device. The frame lives in memory
  for the length of one recognition call and is never written to disk.
- **Web addresses:** read through Accessibility from the focused browser's web area (Safari, Chrome,
  Arc, Firefox where exposed). Query strings are dropped before anything else happens.
- **Dedupe:** the Mac keeps the previous capture's lines for each window and sends only a _segment_
  when the text changed materially. A segment is the new lines, plus the window's title and address,
  plus a start and end time. Scrolling a long page adds lines instead of resending the page.
- **Never read:** Never-watch apps, private windows, Accessibility secure text fields (masked
  password inputs are blanked before recognition runs), and any window while the screen is being
  shared or recorded by another app (open question, §12).
- **Secrets are stripped on the Mac before anything leaves it.** This extends `TextRedactor` with
  the server's `redactSecrets` patterns (bearer tokens, `sk-`/`ghp_`/`AKIA` keys, secret-looking
  query and environment fields), card numbers that pass a Luhn check, and one-time codes next to
  "code"/"verification". The server runs `redactSecrets` again on arrival.
- **Budget:** at most one recognition every 10 seconds, and none while nothing changes. If the Mac
  reports low power or thermal pressure, it backs off to one every 60 seconds. The target is under
  3% average CPU on an M1 Air across a working day. The live proof measures it (§10).

## 6. Sending and storing

- **Local buffer.** Segments are sent in batches about once a minute. When Moss can't be reached,
  they wait in a small on-disk buffer. The buffer is encrypted with a key kept in the Keychain,
  capped at 24 hours or 20 MB, and the oldest entries are dropped first. It is wiped on log out,
  revoke, or when screen history is turned off. This is the only thing the Mac ever stores, and it
  exists only so an offline hour isn't lost.
- **Companion route.** A new companion-only platform route, `POST /api/companion/screen-history`.
  It follows the focus routes' pattern: `requireCompanion`, then the owner is taken from the
  credential and never from the body. The schema lives in `packages/shared/src/companion-api.ts`
  with hard caps (for example 200 segments per batch and 8 KB of text per segment). It is
  IP-rate-limited like the focus routes. Nothing in the route logs a body field. A companion
  credential still reaches nothing else.
- **Module.** A new server module, `screen-history`, owns the data:
  - `app.screen_history_segments`, owner-only with the RLS pattern ENABLE and FORCE plus per-verb
    policies on `app.current_actor_user_id()`, runtime-role grants only, and no `BYPASSRLS`
    anywhere. Columns: device, start and end time, app name, bundle id, window title, address, text,
    text hash, and a generated `tsvector`. Postgres compresses the text out-of-line (TOAST). The
    expected size is 1 to 5 MB a day for a heavy day.
  - Embeddings go into `app.memory_chunks` with a new `source_kind = 'screen'`. That needs a
    memory-owned migration, which widens the CHECK constraint, and memory's public API; this module
    does not write memory's table directly. The embedder is the existing local one.
  - The module declares `dataLifecycle` deletion and export sections, so account deletion and the
    user export include screen history. A cascade test proves it.
- **Jobs carry IDs only.** Ingest enqueues `screen-history.index` with the actor and segment IDs.
  The worker reads the text under the actor's data context. No text, title or address ever goes in a
  job payload or a log line.

## 7. Asking Moss

- A new assistant tool, `screenHistory.search`, takes a question plus an optional time range
  ("this morning", "during my 10:00 meeting"). It combines full-text and vector search over the
  person's own segments and returns short snippets with the app, title, address and time. Chat
  cites them.
- **Pulled, never pushed.** Screen history is used only when this tool is called, meaning when the
  question is about what the person saw. It is not added to passive per-turn recall, the `<memory>`
  seed or briefings. Your screen shouldn't leak into an unrelated answer or a prompt you didn't
  expect. (Whether a later slice may let briefings use it is §12.)
- **Meeting-aware ranges.** "In the meeting this morning" resolves against the person's calendar
  through the calendar module's public API, by finding the event, then searching its time window.
- The model is whatever the person's chat is configured to use, through the provider-agnostic
  router. No provider is named.

## 8. After 30 days: the daily summary note

- A nightly job, a per-user cron that runs in the worker with only the actor and date in its
  payload, takes each day that has just passed 30 days. It asks the router's `summarization`
  capability for a short note that covers what the person worked on, the sites and documents they
  spent time in, and the meetings and what was on screen in them. The raw segments and their
  embeddings for that day are deleted only after the note is written successfully.
- **Where the note goes:**
  - With an attached notes folder (`notes-source-path`), it is written through `VaultContext`
    (`withVaultContextAt`) as `Screen history/<YYYY-MM-DD>.md`. It carries the same ownership
    marker the daily chat archive uses, so it never overwrites the person's own file. Then
    `notes.sync` re-indexes it. Unlike `writeDailyChatArchive`, this uses `VaultContext` and not raw
    `fs`.
  - Without an attached folder, the note goes into the private per-user store (`withVaultContext`)
    and is indexed as a note, so recall still finds it.
- The summary is redacted again before it is written. If summarization fails (no model set up, or
  an error), the raw day is kept and retried nightly for up to 7 days. After that it is deleted
  anyway, and the failure is shown in Settings. The person is never left with a silently growing
  store.

## 9. Screens (for discussion, not yet agreed)

Native screens follow the Trail Marker design guide (§11 settings window). Moss web screens use
`@moss/ui` and `jds-*` primitives only.

**9a. Trail Marker Settings, new "Screen history" tab**

```
┌ Screen history ───────────────────────────────────────────────┐
│ [ ] Remember what's on my screen                               │
│     Trail Marker reads the text in the window you're looking   │
│     at and keeps it in your Moss for 30 days, so you can ask   │
│     about it later. No pictures are kept.                      │
│                                                                │
│ Status   ● Recording · last sent 2 min ago                     │
│ Never watch   Uses the same list as Focus  [Edit in Focus…]    │
│                                                                │
│ [Open screen history in Moss…]                                 │
└────────────────────────────────────────────────────────────────┘
```

**9b. One-time consent sheet (shown when the box is ticked)**

```
  Remember what's on your screen?

  • Reads the words in the window in front, about every 10 seconds
    while it changes. Never pictures, sound or typing.
  • Passwords, card numbers and keys are removed on this Mac first.
  • Kept in your Moss for 30 days, then turned into a daily note.
  • Apps on your Never watch list and private windows are skipped.
  • Only you can see it. Delete any of it from Moss at any time.

                                  [Not now]   [Turn on]
```

**9c. Moss web, Settings → Screen history**

```
Screen history                                            On · 1 Mac
─────────────────────────────────────────────────────────────────────
Kept for 30 days, then summarized into your notes folder
("Screen history/…"). Used only when you ask about something you saw.

Storage   38 MB · 27 days
Delete    [Last hour]  [Today]  [Choose a day…]  [Everything…]

Summaries  Last written Sep 22 · [Open folder]
```

**9d. Chat answer**

```
You: what was that site I saw in the meeting this morning?

Moss: During "Design sync" (10:00–10:30) you had
      figma.com/file/… "Onboarding v3" open, and briefly
      tailwindcss.com/docs/container-queries.
      ▸ From your screen history · Chrome · 10:12, 10:21
```

## 10. How we know it works (live-path gate)

On Ben's Mac against the dev instance:

1. Turn it on and read a known web page and a Messages thread. Within about 2 minutes the segments
   are in Moss, and the address has no query string.
2. Open an excluded app, a private window and a password field. Nothing from any of them is stored.
   This is checked in the database, not only in the UI.
3. Show a fake API key and a test card number on screen. Only the redacted forms are stored.
4. Ask the chat question from §1 about a real meeting. It answers with the right site and time.
5. "Delete today" leaves no rows or embeddings for today.
6. Force the 30-day job for a backdated test day. The note appears in the notes folder, and the raw
   rows are gone.
7. A working day's CPU and battery cost is measured and recorded on the PR.

Tests that assert a privacy property must be seen failing with the protection removed, per
`CLAUDE.md`.

## 11. Promises this reverses, and the amendments

| Where                                        | Says today                                                                           | Becomes                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus spec :44-46                            | No continuous screenshot upload or screen recording                                  | Still true: no pictures are ever uploaded or kept. Screen history uploads **text** only, and only with its own consent.                                  |
| Focus spec :48                               | No history dashboards or reports about the person                                    | Still true: this is private recall, not reports. Scope stays as in §3.                                                                                   |
| Focus spec :207-209                          | Window titles, selected text, image descriptions not stored                          | True **for focus judgment**. Screen history stores titles and on-screen text, under its own opt-in.                                                      |
| Focus spec :129-130, :226                    | Window text is never in a job payload; logs content-free                             | Unchanged, and it applies to screen history too (§6).                                                                                                    |
| Companion spec :14, :76, :214, :243          | Nothing read is stored on the server; no activity history; no queue for later upload | Amended: when screen history is on, text history is stored, and a capped, encrypted, 24-hour offline buffer exists on the Mac (§6). Off, all still true. |
| Migration `0240_focus_judgments.sql` comment | What the person was looking at is never stored                                       | Stays true for `focus_judgments`. Screen history is a separate table with separate consent.                                                              |

Each spec gets a dated amendment line pointing here in the PR that approves this spec.

## 12. Open questions for Ben

1. **Screen sharing:** pause screen history while another app is sharing or recording the screen,
   for example in a Zoom share? Proposed: no. When you're presenting, what you show is exactly the
   "in the meeting" content you'd want to find later.
2. **Emails and names on screen:** today's `TextRedactor` strips email addresses. For recall they're
   often the useful part ("who sent that?"). Proposed: keep email addresses in screen history, but
   still strip them from focus-judgment text.
3. **Briefings:** may a later slice let the morning briefing use yesterday's history ("you left off
   in …")? Proposed: not in this spec. Screen history stays ask-only.
4. **Name:** "Screen history" in both apps? Alternatives: "Day memory", "What I saw".
5. **Messages and other people's words:** reading your Messages means storing what other people
   wrote to you. Proposed: allowed, because it's your screen and your private store, and the consent
   sheet says so. Any app can be excluded.

## 13. Slices (for the plan, once approved)

1. The Mac captures, recognizes text, dedupes and redacts, with the settings tab and consent sheet,
   and sends to a stub route that discards. This proves the CPU budget and redaction first.
2. The server module: route, table, RLS, index job, `dataLifecycle`, the Moss settings screen and
   deletion.
3. The chat tool with calendar-aware time ranges.
4. The 30-day summary job and the notes-folder writer.

Each slice keeps the app map truthful (`packages/shared/src/app-map-core.ts` and the module
manifest) in the same PR.

## Related gap found while writing this

`app.focus_judgments` is promised 30-day retention (focus spec :213), but no job purges it, it has no
`DELETE` grant (migration 0240:34), and it is not in the account-deletion or export lists. It relies
on FK cascade alone. Tracked as #2637; it is not part of this spec.
