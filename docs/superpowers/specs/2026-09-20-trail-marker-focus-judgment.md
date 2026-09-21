# Trail Marker focus judgment against the calendar

Status: **Draft, front-end mockups not yet agreed.** Do not build from this until the screens in
§9 are agreed with Ben and this status line is changed. Builds on
`2026-09-20-trail-marker-mac-companion.md` (the linked Mac) and replaces the direct Mac-to-model
call assumed in `docs/superpowers/plans/2026-09-19-jev-focus-mac-pilot.md`.

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
- **Models are chosen in Moss, not in the app.** The Mac sends a small bounded observation to
  Moss. Moss's AI router picks the user's configured model. No provider name or key exists on the
  Mac.
- **Two models, split on purpose.** A vision model turns a window capture into a short text
  description; a separate judgment model reads that description plus the calendar block. Testing
  with Qwen (describes the image) feeding Jev (judges) worked, so the two steps are configured
  independently: any vision model can describe, any text model can judge.
- **Only Moss-created calendar blocks trigger, to start.**
- **Nudges are on from the start**, still conservative, with an easy way to check the whole chain
  is working (§7).
- **Spec and mockups first** (CLAUDE.md process gates).

## 3. Non-goals

- Continuous screenshot upload, screen recording, or keeping images. A capture is taken only at a
  judgment moment, held in memory for one description call, and never written to disk or stored
  (see §6, rung 3, and §8).
- Judging when there is no calendar block.
- Productivity scores, history dashboards, or reports about the person.
- Any other computer, Windows, Linux, or a cross-platform framework.
- Nudges that interrupt without a clear, repeated mismatch.

## 4. How it works

1. **Block starts.** Moss knows the person's current block (§5). It tells the Mac, on its next
   contact, that a block is active: its title and end time only.
2. **Mac observes, locally.** Rung 1 by default: the frontmost app name and window title, when
   they change (§6). Everything is filtered and shortened on the Mac before anything leaves.
3. **Mac sends a bounded summary** to Moss on a slow cadence (every few minutes, or when the
   frontmost app settles), never raw activity streams.
4. **Moss describes, then judges.** If a capture was sent, the configured vision model turns it
   into a short text description and the image is discarded. The configured judgment model then
   receives the block and the text summary and returns a typed answer: `focused`, `necessary_detour`, `distracted` or `insufficient_evidence`,
   with a short reason.
5. **Moss decides whether to nudge.** Conservative rules (§7). Default is to say nothing.
6. **Pause and stop are always one click on the Mac** and stop all observation immediately.

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

Cheapest rung that answers the question, escalating only with the person's explicit choice. Rung 3 is in the first build because the Qwen-to-Jev pipeline is the thing being tested:

| Rung | What                                                                         | macOS permission | Default        |
| ---- | ---------------------------------------------------------------------------- | ---------------- | -------------- |
| 1    | Frontmost app name and window title, at change events                        | Accessibility    | **On**         |
| 2    | Selected text or page title from an allowlisted app or browser               | Accessibility    | Off            |
| 3    | One foreground-window capture, described by the vision model, then discarded | Screen Recording | Off, on opt-in |

Every rung: allowlist of apps the person opts in, a denylist that always wins (password managers,
banking, private windows), redaction of anything that looks like a secret or a long token, hard
length caps, no clipboard, no keystrokes, no page bodies beyond the cap. Text from web pages is
**untrusted input**: it is quoted as data in the prompt and can never instruct the model.

## 7. Judging and nudging

- Typed answer from the model, validated against a schema; anything else counts as
  `insufficient_evidence`.
- A nudge needs at least two consecutive `distracted` judgments, none of `necessary_detour`
  between them, outside quiet hours, and a per-block cap (default one nudge per 45 minutes).
- `insufficient_evidence` never nudges.
- The person can mark a judgment wrong; those corrections are the trial's main measure.
- Delivery uses the existing notifications module so preferences and quiet hours apply.
- **Nudges are on from the first build.** The gating above is what keeps them rare; it is not a
  reason to hold them back.

### Checking that it works

The person must be able to see the chain working without waiting for a real drift:

- **Judge now** in the Mac menu runs one observation and judgment immediately and shows the result.
- **Last judgment** view on the Mac: when it ran, the calendar block, what was seen (the text
  description, not the image), which two models answered, the label and the reason, and Wrong /
  Right buttons. Kept in memory on the Mac for the session only.
- **Send a test nudge** in settings, so the delivery path and quiet-hours behaviour can be checked
  independently of any judgment.
- A clear state line in the menu: Watching (block name, ends 11:00), Paused, No block right now,
  or Can't reach Moss.

## 8. Data boundary

- The Mac sends: block title (echoed back), app name, shortened window title or selected text,
  timestamps, and the device's own credential. Moss derives the person from the credential, never
  from the payload.
- Moss stores: the judgment, a one-line reason, the block reference, and the person's correction.
  **Not stored:** window titles, selected text, or screenshots. They exist in memory for the
  duration of one model call.
- **A rung-3 capture is sent to Moss** so the user's configured vision model can describe it. That
  is a real change from "images never leave the Mac", and it is why rung 3 needs its own explicit
  consent screen. The image is held in memory for that one call, is never written to disk, never
  logged, and never put in a job payload. If the configured vision model is a third-party
  service, the image goes there too; the consent screen must say so, naming the model the person
  chose.
- The prompt is built from the summary only. Connector and AI credentials, tokens and session data
  are never included. Logs are content-free. Job payloads carry IDs only.
- Every claim above needs a test watched failing with the protection removed before it is written
  in a PR (CLAUDE.md, Claims About Security Properties).

## 9. Screens to agree before building

To be drawn and agreed with Ben, one at a time:

**Mac (native, design guide is the authority):**

1. Menu: the active block and its end time, Pause / Resume, **Judge now**, and Last judgment.
2. First-time consent for observation, per rung, in plain words, with the exact macOS permission
   named and a way to decline that still leaves the app working.
3. Settings, new **Focus** pane: allowlist, denylist, rung, pause schedule.
4. The nudge itself (what it says, how to mark it wrong, how to dismiss for the block).
5. The visible indicator that observation is on. Never hidden.

**Moss web:**

6. Settings → Trail Marker (Moss web): two separate model pickers, **Describe the screen** (vision
   capable) and **Judge focus** (text), plus the rung and nudge settings. The Mac's Focus pane
   shows which two models are in use, read-only, with a link back to this screen.
7. Settings → Trail Marker, focus section: nudge cap, quiet hours link, send a test nudge.
8. Focus review: today's judgments with wrong / right, no scores.

Every screen needs its empty, loading and error state drawn. Copy avoids surveillance language;
it says what is seen, not "monitoring".

## 10. Decisions

Resolved:

- **Which blocks trigger:** Moss-created blocks only, to start.
- **Two-stage models:** vision describes, a separate model judges, configured independently.
- **Nudges from the start:** yes, with Judge now, Last judgment and a test nudge to verify it.

Open, for Ben:

- **D3 Where the image goes.** The router is text-only today, so the vision step needs image
  input added to it. That means the capture travels from the Mac to Moss (and to the vision
  provider, if hosted) transiently. The alternative is describing the image on the Mac with a
  local model and sending only text, which keeps images off the network but ties the description
  step to the Mac. Proposed: through Moss, per section 8, with explicit consent.
- **D1 Model binding.** Two new module service keys, user-bindable like other AI services. How a
  user assigns a model to a new key in the current UI is not yet verified.
- **D4 Local models.** Through Moss by default; the Mac calling a local model directly when Moss
  is unreachable is not in the first slice.
- **D6 Retention.** Proposed 30 days for judgments and corrections. Images never retained.

## 11. Amendments this requires to the companion spec

`2026-09-20-trail-marker-mac-companion.md` currently says the opposite in several places. This
work must amend them in the same pull request that builds the first slice:

- §1: no observation, classification or model calls in this release.
- §5: no model, key, interval or goal settings.
- §6: the required copy "Trail Marker is not observing your activity."
- §11: no window titles or activity are collected.
- §13: model routing, screen observation and nudges are listed as non-goals.

The permission copy, menu and settings inventory change with them. The in-app statement of what is
observed must always be true for the build the person is running.

## 12. Slices and kill criteria

1. **Server contract and calendar read.** Public "current block" read, observation and judgment
   endpoints under the companion credential, service key, structured judgment with a fake model.
2. **Mac observation, rungs 1 and 3.** Consent, allowlist, pause, indicator; sends summaries and,
   on opt-in, one capture per judgment. Judge now and Last judgment.
3. **Router image input and the two-stage pipeline** (describe, then judge), both bound in
   Moss settings.
4. **Nudges, review and corrections.** Nudge delivery with the gating in section 7, test nudge,
   web review screen, corrections recorded.

Stop the trial if, after a week of use, the person marks more than about a third of
`distracted` calls wrong or the nudges are being switched off, or if any observation is found leaving the Mac outside the documented
boundary.

## 13. Security and privacy checks the build must pass

Companion credential still opens nothing outside `/api/companion/*`; observation cannot be posted
for another person; window titles never appear in logs, job payloads or stored rows; pause stops
network requests immediately (extends the existing Disconnect test); prompt-injection text inside a
window title cannot change the schema of the answer or trigger a nudge on its own.
