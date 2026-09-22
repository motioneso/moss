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
rung 3 is on, the frontmost app is being observed (on the person's allowlist, or any app if they
chose to watch the entire desktop — base spec §6 amendment below), and Screen Recording is granted,
the Mac captures that window, describes it, and calls judge a second time with the description added.
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
  frontmost window for whichever app is being observed — a bundle id on the person's allowlist, or
  (base spec §6 amendment below) any app when the person chose to watch the entire desktop instead
  — taken at the moment rung 1 returned `insufficient_evidence` (a window that changed between
  rung 1 and the capture is accepted — the capture is best-effort context, not a guarantee of what
  rung 1 saw). Downscaled before sending (longest side 1024px) to bound both request size and what
  a vision model needs to answer a plain "what is this" question.
- The image lives in memory only: passed to the chosen describer, never written to disk, and the
  `Data` is dropped as soon as the describer returns (success or failure). No caching, no history.
- The denylist from the existing spec (password managers, banking, private windows) still applies
  and still wins, whether the person is watching specific apps or the entire desktop; a denylisted
  frontmost window skips the capture and the judgment stays whatever rung 1 said.

## 5. Failure and consent

- Screen Recording not granted: rung 3 cannot be turned on; the toggle explains why and links to
  System Settings, matching the pattern the Accessibility row already uses.
- Vision source unreachable, rejected, or (CLI) not signed in: the second judge call is skipped,
  the rung-1 `insufficient_evidence` stands, and a bounded diagnostic (no image, no description) is
  the only record — same "recoverable settings issue" treatment as every other permission gap in
  the base spec's §11.
- Consent sentence (replaces the placeholder in §9's Focus settings pane) states, in the person's
  chosen source's own terms: "When Trail Marker can't tell from the window title alone, it will
  take one picture of \<an allowed app|the app in front\> and send it to \<the OpenAI-compatible
  endpoint at {base}|Claude Code, signed in on this Mac\> to describe. The picture is never saved
  and never sent anywhere else." The first blank names an allowed app when the person picked
  specific apps, or says "the app in front" when they chose to watch the entire desktop instead —
  never a generic phrase that would be false either way. This sentence must be literally true for
  the build running, per the base spec's closing rule.

## 6. Server side

One optional field, `description` (text, capped at 280 characters, same untrusted-input handling as
`windowTitle`), added to the judge request/schema in `packages/shared/src/companion-api.ts` and
threaded into the judgment prompt and the System One choice-question `state` alongside `app` and
`title`. Absent, everything behaves exactly as slice 1. This is the only server change; the nudge
rules, the stored row (still no image, no description column — the field is judged, not kept
beyond that), and the credential boundary are unchanged.

## 7. Amendment to the base spec: watching the entire desktop

Ben's direction, 2026-09-22: rather than only a per-app allowlist, the Focus pane also offers
**"Watch the entire desktop"** as a whole-desktop alternative to picking apps one at a time —
getting distracted rarely stays inside one app, so watching everything is a real choice, not a
lesser version of choosing apps.

- Amends the base spec's §6 table ("Every rung: an allowlist of apps the person opts in") and §9
  ("the app allowlist"): the person picks either specific apps or the entire desktop, never both
  at once, in the same Focus settings section. Choosing apps stores an allowlist as before, kept
  even while entire-desktop watching is on, so switching back does not lose it.
- The fixed denylist (password managers, the keychain app, private-browsing windows, §6) still
  always wins, unchanged, whichever mode is chosen — watching the entire desktop never means
  watching a denied app or window.
- Rung 1 observation, and rung 3 capture (§2, §4 above), gate on the same "is this app being
  observed" check either way; nothing about *how* a judgment happens changes, only *which* apps
  can produce one.
- The consent copy in the Focus pane (both the always-shown observation sentence and the rung-3
  sentence in §5 above) names its actual scope — "the apps you have allowed" or "the entire
  desktop" — never a sentence that is only true for one of the two choices.

## 8. Not in this slice

Codex/Gemini as a second and third CLI source (same shape, added later); capturing anything other
than the single frontmost observed window; a capture triggered by anything other than an
`insufficient_evidence` rung-1 answer; retention or caching of a description text on the Mac beyond
the one in-flight request.
