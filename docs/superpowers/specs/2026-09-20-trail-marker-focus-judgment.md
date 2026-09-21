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
- Nudges that interrupt without a clear, repeated mismatch.

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

Cheapest rung that answers the question, escalating only with the person's explicit choice. Rung 3 is in the first build because the describe-then-judge pipeline is the thing being tested:

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
- **Images never reach Moss.** A rung-3 capture goes only to the image model the person
  configured on the Mac. If that endpoint is on the same Mac, the image does not leave it. If it is
  a hosted service, the image is sent there directly by the companion, so the consent screen must
  show the endpoint and say plainly that the image will be sent to it. The image is held in memory
  for that one call and is never written to disk, logged, or retried from storage.
- **The image-model key lives only in the Mac Keychain.** It is never sent to Moss, never logged,
  never put in a prompt, an export, or a crash report (same rule and test as the companion
  credential). Redaction and the denylist run before the capture leaves the process.
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

6. Settings → Trail Marker (Moss web): **Judge focus** model picker (text), plus the rung and
   nudge settings. The **Describe the screen** model is set on the Mac in the Focus pane
   (endpoint, model name, key, a Test button); Moss shows only that a description model is
   configured on this Mac, never its key or address.
7. Settings → Trail Marker, focus section: nudge cap, quiet hours link, send a test nudge.
8. Focus review: today's judgments with wrong / right, no scores.

Every screen needs its empty, loading and error state drawn. Copy avoids surveillance language;
it says what is seen, not "monitoring".

## 10. Decisions

Resolved:

- **Which blocks trigger:** Moss-created blocks only, to start.
- **Two-stage models:** vision describes, a separate model judges, configured independently.
- **Nudges from the start:** yes, with Judge now, Last judgment and a test nudge to verify it.
- **The image model is set on the Mac and called by the companion; Moss stays text-only.** No
  router image input is needed.

Open, for Ben:

- **D1 Model binding.** One new module service key for the judgment step, user-bindable like
  other AI services. How a user assigns a model to a new key in the current UI is not yet verified.
- **D7 Image-model API shape.** Which request formats the Mac supports (for example an
  OpenAI-compatible chat endpoint with an image input) and how a person tests one. Proposed:
  OpenAI-compatible first, with a Test button that describes a built-in sample image, and a
  fallback to window title only (rung 1) when the image model is unavailable or slow.
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
- §5: the Mac now stores an image-model endpoint and key (Keychain only); the earlier "no key
  settings" line must say the Mac holds exactly this one.

The permission copy, menu and settings inventory change with them. The in-app statement of what is
observed must always be true for the build the person is running.

## 12. Slices and kill criteria

1. **Server contract and calendar read.** Public "current block" read, observation and judgment
   endpoints under the companion credential, service key, structured judgment with a fake model.
2. **Mac observation, rungs 1 and 3.** Consent, allowlist, pause, indicator; sends summaries and,
   on opt-in, one capture per judgment. Judge now and Last judgment.
3. **The two-stage pipeline:** the Mac describes with the user's image model, Moss judges with the
   bound model. Timeouts and the fall-back to rung 1 when the image model is unavailable.
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
