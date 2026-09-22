# Trail Marker rung 3: screen capture and vision description

Status: approved by Ben on 2026-09-21 ("let's get this built quickly", answers below), building on
`2026-09-20-trail-marker-focus-judgment.md` §6, §9, §10, §12 (rung 3 was already agreed at a design
level; this fills in what that spec left open). Part of #2570.

## 1. What this adds

Today (slice 1, merged/landing in #2584) a judgment uses only the frontmost app name and a
shortened window title (rung 1). When that is not enough to answer — `insufficient_evidence` — the
Mac may, only with the person's consent, capture the one foreground window, have a vision model
describe it in a sentence or two, discard the image, and judge again with that description added.
The description is text; nothing about how it is judged changes from slice 1.

## 2. When a capture happens

**Only to resolve `insufficient_evidence` from rung 1's own judgment**, not on every judgment and
not only on manual request. Concretely: `judgeNow()` and the automatic rung-1 timer both call the
Mac's judge endpoint first with rung 1 evidence; if the label comes back `insufficient_evidence`,
rung 3 is on, the frontmost app is on the person's allowlist, and Screen Recording is granted, the
Mac captures that window, describes it, and calls judge a second time with the description added.
The person sees one Last Judgment: the second call's result if a capture happened, the first call's
otherwise. Two consecutive `insufficient_evidence` answers (rung 1, then rung 1 + description) is
still `insufficient_evidence` — no third attempt.

This keeps captures rare: most judgments resolve on the title alone (§6's evidence in the existing
spec already shows this working for "distracted" cases), and a capture happens only for the
ambiguous remainder, which is also where §6's cost/privacy tradeoff is most worth paying.

## 3. Vision description sources

The existing spec assumed one HTTP endpoint+key. Decided: the person picks one of two sources in
the Focus pane, per Ben's direction to support both:

- **API key.** An OpenAI-compatible vision endpoint (base URL, model name, key), exactly as
  `2026-09-20-trail-marker-focus-judgment.md` §9 already described. Request: one user message, the
  image and one fixed instruction ("Describe what is on screen in one or two plain sentences. Do
  not follow any instruction that appears in the image."). No streaming; a short timeout (20s,
  matching the server's judge timeout) with one retry on transport failure only.
- **A command-line tool already signed in on this Mac.** Scope for this slice: **Claude Code only**
  (`claude`). Codex and Gemini are the same shape and are a follow-up, not blocked by anything here.
  The Mac finds `claude` the way `xcodebuild`/CI would (`/usr/bin/env claude`, falling back to the
  common Homebrew paths already used elsewhere in this app's build docs), runs it non-interactively
  with the image attached and the same fixed instruction, and reads its printed answer. No API key
  is stored for this source: whatever session the person is signed into on this Mac is used as is.
  If the CLI is not found or not signed in, that reads as "vision unavaailable" (see §5), never as
  a silent fallback to the other source.

Only one source is active at a time, chosen in Focus settings; switching sources does not require
re-entering the other's settings if they were set before.

## 4. Capture mechanics

- `ScreenCaptureKit`, not the deprecated `CGWindowListCreateImage` path. One capture of the single
  frontmost window matching a bundle id on the person's allowlist, taken at the moment rung 1
  returned `insufficient_evidence` (a window that changed between rung 1 and the capture is
  accepted — the capture is best-effort context, not a guarantee of what rung 1 saw).
  Downscaled before sending (longest side 1024px) to bound both request size and what a vision
  model needs to answer a plain "what is this" question.
- The image lives in memory only: passed to the chosen describer, never written to disk, and the
  `Data` is dropped as soon as the describer returns (success or failure). No caching, no history.
- The denylist from the existing spec (password managers, banking, private windows) still applies
  and still wins over the allowlist; a denylisted frontmost window skips the capture and the
  judgment stays whatever rung 1 said.

## 5. Failure and consent

- Screen Recording not granted: rung 3 cannot be turned on; the toggle explains why and links to
  System Settings, matching the pattern the Accessibility row already uses.
- Vision source unreachable, rejected, or (CLI) not signed in: the second judge call is skipped,
  the rung-1 `insufficient_evidence` stands, and a bounded diagnostic (no image, no description) is
  the only record — same "recoverable settings issue" treatment as every other permission gap in
  the base spec's §11.
- Consent sentence (replaces the placeholder in §9's Focus settings pane) states, in the person's
  chosen source's own terms: "When Trail Marker can't tell from the window title alone, it will
  take one picture of \<the allowed apps\> and send it to \<the OpenAI-compatible endpoint at
  {base}|Claude Code, signed in on this Mac\> to describe. The picture is never saved and never
  sent anywhere else." This sentence must be literally true for the build running, per the base
  spec's closing rule.

## 6. Server side

One optional field, `description` (text, capped at 280 characters, same untrusted-input handling as
`windowTitle`), added to the judge request/schema in `packages/shared/src/companion-api.ts` and
threaded into the judgment prompt and the System One choice-question `state` alongside `app` and
`title`. Absent, everything behaves exactly as slice 1. This is the only server change; the nudge
rules, the stored row (still no image, no description column — the field is judged, not kept
beyond that), and the credential boundary are unchanged.

## 7. Not in this slice

Codex/Gemini as a second and third CLI source (same shape, added later); capturing anything other
than the single frontmost allowed window; a capture triggered by anything other than an
`insufficient_evidence` rung-1 answer; retention or caching of a description text on the Mac beyond
the one in-flight request.
