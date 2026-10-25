# Vocci hold-to-talk: make a long press near-immediate

Follow-up to #3584 under `docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md` and
`docs/superpowers/plans/2026-10-24-vocci-normal-chat-input.md`.

## Goal

Ben tested a ring long press (hold-to-talk) on 2026-10-25. It works but is too slow. He wants
to use it for quick commands like "turn off the lights", so the time from releasing the button
to Moss acting should be as short as possible. Ben: "I'd like long press to be as immediate as
possible for it to be useful."

## Known so far (from reading `apps/vocci-delivery` on origin/main, not yet measured)

- `DeliveryService` loop waits `RetryPolicy.connectionDelayMs(0)` = 30 s between cycles unless
  a command arrives.
- `retrieve()` skips a file until its packet and sidecar sizes match `previousInventory`, so a
  new recording needs two inventories in a row. Phone-side wait is about 30-60 s before
  retrieval starts.
- Every cycle opens a fresh `RingConnection`. Connection setup cost is unmeasured.
- After upload, the client polls `/api/meetings/voice-recordings/:id`. Server-side stages
  (upload, transcription, chat admission, model reply, tool call) are untimed.

## Cycle

1. `pnpm install`. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, the spec and
   plan above, and `apps/vocci-delivery/` (DeliveryService, RingConnection, RingProtocol,
   RingTelemetry, VoiceInputs, ResumableUpload). Search Hindsight for "vocci ring protocol",
   "hold-to-talk" and "voice request".
2. **Measure first.** Build a stage-by-stage timeline for one real long press: button release,
   ring file complete, phone sees it, retrieval done, upload done, server receipt, transcript
   ready, chat turn admitted, reply or tool done. Use timestamps the product already keeps
   (receipt, message and phone store times). Add temporary local timing only if needed, and
   never log transcripts or secrets.
3. Write a short plan with the repo `plan-build` skill. Rank options by seconds saved against
   battery, ring wear and safety. Candidates to evaluate, not decided:
   - Detect a finished hold recording without the second sighting (completion marker in the
     sidecar or telemetry), so a still-growing file is never fetched.
   - Keep the ring connection open, or check much faster, only while hold-to-talk is on or
     just after a press. Use any button or recording event the ring sends.
   - Server side: skip queue waits for voice requests, pick the fastest transcription path,
     and avoid extra polling hops.
   Commit the plan and show Ben the timeline and the ranked options in plain English before
   building. He is available for decisions.
4. Build test-first. `pnpm verify:static` unpiped. Use `verify-gate` for anything touching a
   database. Android native checks per the module README.
5. Independent review by a fresh session on a different model than the builder. Codex is out
   of usage, so use a fresh Opus session. Resolve every finding.
6. Live proof on the real phone and ring: time several long presses before and after the change,
   and record the numbers on the PR. Release note: Category Fixed. Then
   `gh pr merge --squash --auto`.

## Boundaries

- **The phone and ring are shared.** Another session, agent `vocci-phone-range`, is running
  physical out-of-range and interrupted-upload checks with Ben right now. Don't use ADB, install
  builds or connect to the ring until that session finishes. Check with
  `herdr agent list`, or message it with the `herdr-pane-message` skill. Steps 1-3 need no device.
- Keep delivery enabled, the hold-to-talk opt-in, cleanup choices, the official app's Bluetooth
  permission handoff and the phone timeout as you find them.
- No production database reads or writes. Use the product's screens and API.
- Keep the receipt, the durable destination rules and exactly-once delivery intact. A faster
  path must never deliver a partial recording or a duplicate.
- This repository is public. Keep hostnames, addresses, device ids, credentials and transcripts
  out of committed files.
- Leave the worktree clean and stop owned servers when finished.

## Start

Begin at Cycle step 1 now.
