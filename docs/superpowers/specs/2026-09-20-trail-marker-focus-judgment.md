# Trail Marker focus judgment against the calendar

Status: **Approved by Ben, 2026-09-20**, with the fixes from an independent review folded in.
The screens in §9 are minimal and follow the approved board. Builds on
`2026-09-20-trail-marker-mac-companion.md` (the linked Mac) and replaces the direct Mac-to-model
call assumed in `docs/superpowers/plans/2026-09-19-jev-focus-mac-pilot.md`. **Amended 2026-09-22**
(§6, §9): watching can be the entire desktop instead of only chosen apps; full amendment in
`2026-09-21-trail-marker-rung3-vision.md` §7. **Amended 2026-09-22** (§7, §7a, §9, §10, §11): a
nudge is a banner that stays on top until the person is back on task, replacing the macOS
notification, and a distraction gauge on the Mac decides when it appears. **Amended 2026-09-23:** the "Not
stored" list (§ data) still holds for focus judgment. **Backtrack**, a separate feature with its own
consent, does store on-screen text and titles; see `2026-09-23-trail-marker-screen-history.md` §11.
The menu's pause becomes **Pause All**, with a separate Focus switch row (that spec §4).

## 1. What this is

When a calendar block starts ("Study AI", 9:00 to 11:00), Trail Marker watches what the Mac is doing
in a narrow, private way, and Moss decides whether that fits the block. If it clearly doesn't, and
only then, Moss may nudge. Which model does the judging is the user's choice, made in Moss the same
way every other model choice is made. Jev and Qwen are examples of models a user might pick; nothing
in the app or the contract names either.

The point is to test one product question: does knowing what the person meant to be doing, from
their own calendar, let a model tell drift from a legitimate detour well enough to be worth a
nudge?

## 2. Decisions already made

- **The goal is the current calendar block.** No separate goal to maintain. No block, no judging.
- **The judgment model is chosen in Moss.** The Mac sends a small bounded text summary to Moss.
  Moss's AI router picks the user's configured model. No provider name or key for the judgment
  step exists on the Mac.
- **Two models, split on purpose, and the image stays on the companion.** The Mac captures the
  window and sends it to an **image model the user configures on the Mac** (any compatible API:
  a local runtime or a hosted service, with its own key kept in the Keychain). That model returns a
  short text description; the image is discarded. Only the text goes to Moss, where a separate
  judgment model decides. Testing with Qwen describing and Jev judging worked, and neither name
  appears in the contract. Doing the image step on the Mac avoids uploading images to Moss and
  keeps the round trip short.
- **Only Moss-created calendar blocks trigger, to start.**
- **Nudges are on from the start**, still conservative, with an easy way to check the whole chain
  is working (§7).
- **Spec and mockups first** (CLAUDE.md process gates).

## 3. Non-goals

- Continuous screenshot upload, screen recording, or keeping images. A capture is taken only at a
  judgment moment, held in memory for one description call, and never written to disk or stored
  (see §6, rung 3, and §8). Images never go to Moss.
- Judging when there is no calendar block.
- Productivity scores, history dashboards, or reports about the person.
- Any other computer, Windows, Linux, or a cross-platform framework.
- Nudges that interrupt without a clear, sustained mismatch: the gauge in §7a needs real time
  spent distracted, unless the person chose "right away".

## 4. How it works

1. **Block starts.** Moss knows the person's current block (§5). It tells the Mac, on its next
   contact, that a block is active: its title and end time only.
2. **Mac observes, locally.** Rung 1 by default: the frontmost app name and window title, when
   they change (§6). Everything is filtered and shortened on the Mac before anything leaves.
3. **Mac sends a bounded summary** to Moss on a slow cadence (every few minutes, or when the
   frontmost app settles), never raw activity streams.
4. **Describe on the Mac, judge in Moss.** If rung 3 is on, the Mac sends the capture to the
   image model the user configured, gets back a short text description, and discards the image.
   The summary sent to Moss is text only. Moss's configured judgment model receives the block and
   that text and returns a typed answer: `focused`, `necessary_detour`, `distracted` or `insufficient_evidence`,
   with a short reason.
5. **The Mac decides whether to nudge**, from its distraction gauge (§7a, amended 2026-09-22).
   Default is to say nothing until real distracted time has built up.
6. **Pause and stop are always one click on the Mac** and stop all observation immediately.
   There is one pause: the menu's **Pause / Resume**, which pauses the whole connection to Moss
   without logging out. There is no separate Focus pause (Ben, 2026-09-23).

## 5. Calendar seam

Moss has no "what is happening now" read today. Only `GET /api/calendar/events` exists, which
returns every visible event for the caller to filter. Add one **public read** to the calendar
module: the block(s) covering a given instant for a user, returning title, start, end and whether
Moss created it. Focus reads it through that public API; it must not import calendar internals or
query its tables (module isolation).

Which blocks count: **only blocks Moss created** (`isMossBlock`) to start. Other calendar events
never trigger observation. Widening this later (tagged events, whole calendars) is a separate
decision.

## 6. What the Mac observes

Cheapest rung that answers the question, escalating only with the person's explicit choice. Rung 3 is in the first build because the describe-then-judge pipeline is the thing being tested:

| Rung | What                                                                         | macOS permission | Default        |
| ---- | ---------------------------------------------------------------------------- | ---------------- | -------------- |
| 1    | Frontmost app name and window title, at change events                        | Accessibility    | **On**         |
| 2    | Selected text or page title from an allowlisted app or browser               | Accessibility    | Off            |
| 3    | One foreground-window capture, described by the vision model, then discarded | Screen Recording | Off, on opt-in |

Every rung: an allowlist of apps the person opts in, **or the entire desktop if they choose that
instead** (amended 2026-09-22, Ben: distraction rarely stays inside one app, so watching everything
is a real choice, not only a lazier version of picking apps — see the rung 3 spec §7 for the full
amendment), a denylist that always wins either way (password managers, banking, private windows),
no clipboard, no keystrokes, hard length caps. Text from web pages and window titles is
**untrusted input**: it is quoted as data in the prompt and told never to act as instructions. That
makes an injected instruction unlikely to work; it does not make it impossible (see §13).

**What protects a capture, honestly.** Rungs 1 and 2 are text, so the Mac can strip anything that
looks like a secret or a long token before sending. A screenshot cannot be redacted that way: the
pixels would have to be read first. For rung 3 the protection is the denylist (still always
checked first, whether the person picked specific apps or the entire desktop) plus the allowlist
when one is in effect, and the person's consent. Anything visible in the captured window, including
text typed into a form, is sent to the image model. The consent sentence must say this in plain
words, including which of the two scopes is actually active.

**The person's own exclusions** (amended 2026-09-23, Ben, #2633). The person can add their own apps
to a "Never watch" list in Settings → Focus, a finance app for example. An excluded app is treated
exactly like the fixed denylist: it is checked first and wins over both chosen apps and entire-desktop
watching, and nothing about it leaves the Mac — no capture, no window title, not even the app's name.
Moss cannot judge while it is in front and simply waits for the next switch. Settings' Test vision
obeys the same rule, so it never takes a picture of an excluded or denylisted app. Excluding a chosen
app removes it from the chosen apps.

The fixed denylist above says "banking", but the built-in list covers only password managers and the
system keychain: no banking or finance app is on it. The person's own list is how those are covered.

## 7. Judging and nudging

- Typed answer from the model, validated against a schema; anything else counts as
  `insufficient_evidence`.
- A nudge comes from the distraction gauge on the Mac (§7a): time spent in front of windows
  judged `distracted` fills it, and only a stretch of focused time empties it. Nothing is nudged
  in quiet hours.
- `insufficient_evidence` never nudges.
- The person can mark a judgment wrong; those corrections are the trial's main measure.
- **Judging happens inside the Mac's own request.** The Mac sends a summary and waits (timeout
  about 20 seconds) for the judgment. It is not queued as a background job, because window text
  cannot be stored or carried in a job payload. If the model is slow or fails, the Mac gets
  `insufficient_evidence` and nothing is nudged.
- **The Mac holds the nudge rule (amended 2026-09-22).** The gauge measures time in front of a
  window, which only the Mac knows; the server sees judgments at irregular moments. The server
  judges, stores the label, and tells the Mac whether it is quiet hours (in the context it already
  fetches every minute). The earlier server-side rule (two in a row, a per-person 45-minute cap)
  and its `nudge` flag are removed. Each Mac keeps its own gauge; a person on two Macs at once can
  see a banner on each, which is acceptable on a one-person instance.
- **The Mac shows the nudge itself** as the on-top banner in §7a. The Moss
  notifications module reaches the web and browser push but the Mac's credential cannot read it,
  so it is not the delivery route. Quiet hours are read from the person's Moss settings and a
  nudge in quiet hours is **dropped, not deferred** (a deferred nudge would arrive after the
  moment it was about).
- **Nudges are on from the first build.** The gating above is what keeps them rare; it is not a
  reason to hold them back.

### Checking that it works

The person must be able to see the chain working without waiting for a real drift:

- **Last judgment**, opened from the menu once a judgment has run (there is no manual Judge now;
  Ben removed it, 2026-09-23, since the Mac judges on its own while a block is on): when it ran, the calendar block, what was seen (the text
  description, not the image), which two models answered, the label and the reason, and Wrong /
  Right buttons. Kept in memory on the Mac for the session only.
- **Send a test nudge** in settings shows the banner for a few seconds, so the delivery path can
  be checked independently of any judgment.
- A clear state line in the menu: Watching (block name, ends 11:00), No block right now, or
  Can't reach Moss. While Trail Marker is paused the menu's status already reads Paused, and no
  Focus line is shown under it.

## 7a. The nudge banner (amended 2026-09-22)

Tried live on 2026-09-22 as a Debug-only experiment, then chosen by Ben for the real product.

- **What it is:** a small banner at the top centre of the screen the person is using, above every
  window including full-screen apps, and on every Space. It never takes keyboard focus or makes
  Trail Marker the app in front, so it does not change what is observed and does not interrupt
  typing.
- **What it says:** "Back to: <block title>" and the judge's one-line reason, with one button,
  **Wrong**.
- **It replaces the macOS notification** for nudges. There is one signal, not two.
- **It hides when one of these happens:**
  - a `focused` or `necessary_detour` judgment;
  - the person presses **Wrong**, which also records Wrong for that judgment (the same correction
    as Wrong in Last judgment);
  - the person pauses Trail Marker, or turns Focus off;
  - the block ends, or there is no current block.
    An `insufficient_evidence` judgment leaves it as it is. There is only ever one banner.
- **The distraction gauge** (Ben, 2026-09-22) decides when the banner appears:
  - It **fills** with time spent in front of windows judged `distracted`, from that judgment
    until the window changes or the next judgment. When it is full, the banner appears.
  - It **does not empty** when the person gets back to work. It empties only after **5 minutes
    in a row** of `focused` or `necessary_detour` time.
  - So after a banner is cleared by getting back to work, the gauge is still full: going back to
    something distracting within those 5 minutes brings the banner back **at once**. After 5
    focused minutes the gauge is empty and has to fill again.
  - The same rule applies before it is ever full: a short distraction, some focus, then more
    distraction keeps adding up unless 5 focused minutes came between.
  - `insufficient_evidence` time neither fills it nor counts toward the 5 focused minutes.
  - **Wrong** on a `distracted` judgment takes that judgment's time back out of the gauge.
  - Pause freezes the gauge. A new block starts with an empty gauge.
- **Sensitivity, chosen by the person** in the Focus pane: "Nudge me after [right away / 1 min /
  2 min / 5 min] distracted", default 2 min. "Right away" means the first `distracted` judgment
  fills it. The 5-minute emptying time is fixed.
- **No spacing cap.** The old 45-minute cap existed to stop repeated notifications; a single
  banner that hides when the person is back on task, and a gauge that only empties after real
  focus, make it unnecessary.
- **Accessibility:** readable by VoiceOver when it appears, and follows Reduce Transparency
  (system material) and Increase Contrast.
- **Known trade-off:** anything on top of every window also shows in a screen share or a
  recording. The banner shows only the block title and the judge's reason, never what was seen,
  and Pause clears it at once.

## 8. Data boundary

- The Mac sends: block title (echoed back), app name, shortened window title or selected text,
  timestamps, and the device's own credential. Moss derives the person from the credential, never
  from the payload.
- Moss stores: the judgment label, a short reason (capped at about 140 characters), the block
  reference, and the person's correction. **Not stored:** window titles, selected text, image
  descriptions, or screenshots. They exist in Moss's memory for the duration of one model call. (If the bound judgment model is served through a command-line tool, that tool also keeps the conversation in its own files on the server host; this is disclosed once in the model setup info, and allowed.)
- **The reason is the one piece of free text that is kept**, so it is treated as private data: the
  judgment prompt tells the model to give a category-level reason ("reading an unrelated news
  site") and not to quote or paraphrase what is on screen, the text is capped, and it is only
  ever shown to the owner. It can still be imperfect, which is why the cap and the 30-day
  retention exist. The image description is redacted for secrets on the Mac before it is sent
  and is held only for the one call.
- **Images never reach Moss.** A rung-3 capture goes only to the image model the person
  configured on the Mac. If that endpoint is on the same Mac, the image does not leave it. If it is
  a hosted service, the image is sent there directly by the companion, so the consent screen must
  show the endpoint and say plainly that the image will be sent to it. The image is held in memory
  for that one call and is never written to disk, logged, or retried from storage.
- **The image-model key lives only in the Mac Keychain.** It is never sent to Moss, never logged,
  never put in a prompt, an export, or a crash report (same rule and test as the companion
  credential). What's being watched (specific apps or the entire desktop) and the denylist decide
  whether a capture happens at all; they are the protection for pixels, as §6 explains.
- The prompt is built from the summary only. Connector and AI credentials, tokens and session data
  are never included. Logs are content-free. Job payloads carry IDs only.
- Every claim above needs a test watched failing with the protection removed before it is written
  in a PR (CLAUDE.md, Claims About Security Properties).

## 9. Screens

Deliberately almost no new screens. Everything uses the styling of the approved board in
`docs/specs/Trail Marker/trail-marker-design-guide/` (the menu-bar card, the settings sidebar).

**Mac:**

1. **Menu card:** shows the current goal, meaning the active Moss calendar block and when it
   ends (or "No block right now"), on click, with the block name also available on hover of the
   menu-bar icon. **Pause / Resume** and **Judge now** sit in the same card. The last judgment
   (what was seen, the label, the reason, Wrong / Right) opens from **Judge now**'s result rather
   than a separate window. _Amended (Ben, 2026-09-23):_ Judge now is gone and there is no
   separate Focus pause anywhere; the card's Pause / Resume is the connection's pause, the only
   one, and stops all communication with Moss. Last Judgment… is its own row.
2. **Focus settings (one new pane in the existing Settings sidebar):** the image model API
   (endpoint, model name, key, a Test button, and one plain sentence stating where the image will
   be sent). That sentence is the consent: no separate consent screen. Also what to watch — specific
   apps, chosen one at a time, or the entire desktop instead (§6 amendment) — the gauge's
   sensitivity (§7a), and a **Send a test nudge** button.
3. **The nudge banner (§7a):** the one designed window this adds. Layout below; system material
   background, 12-point corner radius (design guide §5), system font, headline for the goal and
   callout secondary for the reason, a native secondary **Wrong** button, 16-point padding, about
   520 points wide.

   ```
   ╭──────────────────────────────────────────────────────────────╮
   │  Back to: Draft the chapter 3 outline             [ Wrong ]  │
   │  A video feed isn't part of outlining the chapter.           │
   ╰──────────────────────────────────────────────────────────────╯
   ```

**Moss web:** no new screen. The judgment model is the Sorting model in Settings → AI (an admin
setting; see D1). There is no review screen: the person checks
and corrects judgments from Last judgment on the Mac, and Moss records the correction.

Not new screens, but still needed and drawn in the existing style: the empty, loading and error
states of the above (no block, image model unreachable, Moss unreachable). Nudges are the banner
in item 3, not macOS notifications (amended 2026-09-22). Copy avoids surveillance language; it
says what is seen, not "monitoring".

## 10. Decisions

Resolved:

- **Which blocks trigger:** Moss-created blocks only, to start.
- **Two-stage models:** vision describes, a separate model judges, configured independently.
- **Nudges from the start:** yes, with Judge now, Last judgment and a test nudge to verify it.
- **The image model is set on the Mac and called by the companion; Moss stays text-only.** No
  router image input is needed.
- **Existing linked Macs are not re-approved; new setups show the approval info** (D8).
- **Focus is not a module; server-side it is only Trail Marker info, and its model is the Sorting model in Settings** (D9, D1).
- **Slice order:** text-only end to end first, then screenshots (§12).
- **Nudges are an on-top banner driven by a distraction gauge on the Mac** (Ben, 2026-09-22,
  after trying the banner live): replaces the macOS notification; hidden by getting back on task,
  Wrong, Pause or the block ending; the gauge fills with distracted time (sensitivity right away /
  1 / 2 / 5 minutes) and empties only after 5 focused minutes in a row, so a relapse within those
  5 minutes brings the banner straight back (§7a). The server-side two-in-a-row rule and
  45-minute cap are removed.

Open, for Ben:

- **D1 Model binding (amended 2026-09-22).** The judge is the admin's **Sorting model**
  (`2026-09-22-sorting-model.md`), not a row of its own (Ben, 2026-09-22). With no sorting model
  chosen, nothing is judged. A System One model such as Jev may be chosen there; it then judges
  Trail Marker focus only, and sorting jobs keep using the main model until the Jev slice of the
  sorting spec. It is an **admin** setting, not per person. Fine on a one-person instance; stated
  so nobody expects per-person choice.
- **D8 Existing linked Macs (decided).** No re-approval. A Mac linked before this ships keeps
  working and is not asked to approve again; only **new setups** show the added capabilities on the
  browser approval page. Two things are still true and stated so nobody is surprised: the device
  credential of an already-linked Mac can now read that person's current block and submit
  observations, and nothing is observed until the person turns it on in the Mac's own Focus pane and
  grants the macOS permission, so the Mac itself is where consent for existing setups happens.
  This is acceptable on a one-person instance; a shared instance would need the re-approval.
- **D9 Where the code lives (decided, corrected 2026-09-20).** **Not a module.** Focus is platform
  code, like the companion pairing: not in the module registry, not downloadable, no manifest, no
  permissions, no Settings → Modules entry, no sidebar entry. An earlier draft called it a module
  with no sidebar entry; that was wrong. Internally: an internal code library for the judgment
  logic, a platform database migration for the judgments table (owner-only), wiring in the
  registry's composition code, and the calendar module gains the small "current block" public
  read. What a person sees on the server is only the Trail Marker information in Settings (download
  link, how to connect) and the Sorting model in Settings → AI, which judges focus (D1). The
  image model stays in the Mac's own Focus pane.
  **Never defaulted:** the row starts empty, no model is pre-selected or inherited from any other
  setting, and nothing is processed until an admin defines the Trail Marker reasoning model.

## 11. Amendments this requires to the companion spec

`2026-09-20-trail-marker-mac-companion.md` currently says the opposite in several places. This
work must amend them in the same pull request that builds the first slice:

- §1: no observation, classification or model calls in this release.
- §5: no model, key, interval or goal settings.
- §6: the required copy "Trail Marker is not observing your activity."
- §11: no window titles or activity are collected.
- §13: model routing, screen observation and nudges are listed as non-goals.
- §5: the Mac now stores an image-model endpoint and key (Keychain only); the earlier "no key
  settings" line must say the Mac holds exactly this one.

- §9.7, §9.8 and §12 (credential scope): the companion credential also reads the person's current
  Moss block, submits observations and receives judgments and quiet hours. Still refused on every other
  route; the existing boundary test stays.
- §6 (permissions): no longer needed. The macOS notification permission was required for nudges
  until the banner replaced them (amended 2026-09-22); the Mac does not ask for it.
- The browser approval page must list the new capabilities for any Mac approving them.

The permission copy, menu and settings inventory change with them. The in-app statement of what is
observed must always be true for the build the person is running.

## 12. Slices and kill criteria

Build one thin working line first, with text only, so the product question is tested before any
screenshot is involved:

1. **Text-only judgment, end to end.** Calendar "current Moss block" read; one companion
   endpoint that takes a rung-1 summary (app name and a capped window title), judges inside the
   request with a real bound model, applies the nudge rules, and returns label, reason and the
   nudge flag. On the Mac: the goal shown in the menu card, Pause, Judge now, Last judgment
   (Wrong / Right), and a local macOS notification when told to nudge. Amend the companion spec
   and the in-app "not observing" copy in the same pull request; the browser re-approval from D8.
2. **Rung 3.** The Focus settings pane with the image model (endpoint, model, key, Test), the
   one-sentence consent, the capture, description on the Mac, and the fall-back to titles when the
   image model is slow.
3. **Hardening and the second Mac.** Per-person cap across Macs, retention job, test nudge,
   anything the trial shows is missing.

Stop the trial if, after a week of use, the person marks more than about a third of
`distracted` calls wrong or the nudges are being switched off, or if any observation is found leaving the Mac outside the documented
boundary.

## 13. Security and privacy checks the build must pass

Companion credential still opens nothing outside `/api/companion/*`; observation cannot be posted
for another person; window titles never appear in logs, job payloads or stored rows; pause stops
network requests immediately (extends the existing Disconnect test); prompt-injection text inside a
window title cannot change the schema of the answer, and one sample of injected text does not
produce a nudge at the default sensitivity. (Text that stays in front for the fill time can;
a person who chose "right away" accepts that one judgment can. Either way the worst case is one
banner, which never stacks, and it shows only the block title and a reason, never what was
seen.) A stolen credential cannot post for another person;
a search of the logs finds no window title, description or reason text.
