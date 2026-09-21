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
- **Spec and mockups first** (CLAUDE.md process gates).

## 3. Non-goals

- Continuous screenshot upload, screen recording, or keeping images. If images are ever used, one
  is captured, described locally or discarded, and never stored or uploaded (see §6, rung 3).
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
4. **Moss judges.** It builds a prompt from the block and the summary, and asks the configured
   model for a typed answer: `focused`, `necessary_detour`, `distracted` or `insufficient_evidence`,
   with a short reason.
5. **Moss decides whether to nudge.** Conservative rules (§7). Default is to say nothing.
6. **Pause and stop are always one click on the Mac** and stop all observation immediately.

## 5. Calendar seam

Moss has no "what is happening now" read today. Only `GET /api/calendar/events` exists, which
returns every visible event for the caller to filter. Add one **public read** to the calendar
module: the block(s) covering a given instant for a user, returning title, start, end and whether
Moss created it. Focus reads it through that public API; it must not import calendar internals or
query its tables (module isolation).

Open rule (§10, D2): which blocks count. Proposed default: any timed, non-declined, non-all-day
event the person owns, with a per-event and per-calendar opt-out in Moss settings.

## 6. What the Mac observes

Cheapest rung that answers the question, escalating only with the person's explicit choice:

| Rung         | What                                                                 | macOS permission | Default |
| ------------ | -------------------------------------------------------------------- | ---------------- | ------- |
| 1            | Frontmost app name and window title, at change events                | Accessibility    | **On**  |
| 2            | Selected text or page title from an allowlisted app or browser       | Accessibility    | Off     |
| 3 (fallback) | One foreground-window capture, described on the Mac, image discarded | Screen Recording | Off     |

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

## 8. Data boundary

- The Mac sends: block title (echoed back), app name, shortened window title or selected text,
  timestamps, and the device's own credential. Moss derives the person from the credential, never
  from the payload.
- Moss stores: the judgment, a one-line reason, the block reference, and the person's correction.
  **Not stored:** window titles, selected text, or screenshots. They exist in memory for the
  duration of one model call.
- The prompt is built from the summary only. Connector and AI credentials, tokens and session data
  are never included. Logs are content-free. Job payloads carry IDs only.
- Every claim above needs a test watched failing with the protection removed before it is written
  in a PR (CLAUDE.md, Claims About Security Properties).

## 9. Screens to agree before building

To be drawn and agreed with Ben, one at a time:

**Mac (native, design guide is the authority):**

1. Menu: the Active block, its end time, Pause / Resume, and what is being observed right now.
2. First-time consent for observation, per rung, in plain words, with the exact macOS permission
   named and a way to decline that still leaves the app working.
3. Settings, new **Focus** pane: allowlist, denylist, rung, pause schedule.
4. The nudge itself (what it says, how to mark it wrong, how to dismiss for the block).
5. The visible indicator that observation is on. Never hidden.

**Moss web:**

6. Settings → AI: pick the model for focus judgment (and for image description if rung 3 is used).
7. Settings → Focus: which calendars or blocks count, quiet hours link, nudge cap.
8. Focus review: today's judgments with wrong / right, no scores.

Every screen needs its empty, loading and error state drawn. Copy avoids surveillance language;
it says what is seen, not "monitoring".

## 10. Open decisions for Ben

- **D1 Model binding.** New module service key, user-bindable like other AI services. Confirm how
  a user assigns a model to it in the current UI (not yet verified).
- **D2 Which blocks trigger.** Proposed default in §5.
- **D3 Image input.** `generateStructured` is text-only today. Rung 3 needs image support added to
  the router, or the Mac describes the image with a local model and sends only text. Proposed:
  defer rung 3 entirely until rung 1 proves value.
- **D4 Where Qwen-style local models run.** Through Moss (which may itself call a local runtime) is
  the default. Allowing the Mac to call a local model directly when Moss is unreachable is
  possible later; not in the first slice.
- **D5 Trial shape.** Silent first (judgments recorded, no nudges) for about a week, then nudges
  only if the corrections say it is worth it.
- **D6 Retention.** Proposed 30 days for judgments and corrections.

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
2. **Mac observation, rung 1, silent.** Consent, allowlist, pause, indicator; sends summaries.
3. **Review and corrections.** Web review screen; corrections recorded.
4. **Nudges**, only after §12 criteria hold.

Stop the trial if, after a week of silent judgments, the person marks more than about a third of
`distracted` calls wrong, or if any observation is found leaving the Mac outside the documented
boundary.

## 13. Security and privacy checks the build must pass

Companion credential still opens nothing outside `/api/companion/*`; observation cannot be posted
for another person; window titles never appear in logs, job payloads or stored rows; pause stops
network requests immediately (extends the existing Disconnect test); prompt-injection text inside a
window title cannot change the schema of the answer or trigger a nudge on its own.
