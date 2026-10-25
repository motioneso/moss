# Vocci hold-to-talk: speed up the server side

Follow-up to #3584 under `docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md`, after
the phone-side latency work in `docs/superpowers/plans/2026-10-25-vocci-hold-latency.md` merged.

## Goal

Ben timed ring long presses at 18.1, 10.1 and 15.9 seconds from release to Moss acting, down
from about 40. He wants that halved again so short commands ("turn off the lights") feel
immediate. The phone side is done. This session works on what happens after the audio reaches
Moss: the queue hop to transcription, transcription itself, the hop to a chat turn, and the model
reply and tool call (stages 7-10 in the plan's timeline).

## Cycle

1. `pnpm install`. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, the spec and
   the latency plan above. Search Hindsight for "voice request", "transcription provider" and
   "chat turn latency".
2. **Measure first.** On an isolated instance (`verify-gate` for databases, `devports` for ports;
   the moss-proof copy on 5181 has a real model signed in), upload a short spoken hold recording
   through the product's own voice-recording API and time each stage from stored timestamps:
   upload finalized, transcription job picked up, transcript ready, chat turn admitted, first
   reply token, tool call done. Use a recording you make with text-to-speech, never a private
   one. No intercepted or rewritten responses.
3. Commit a short plan with the repo `plan-build` skill. Rank options by seconds saved. Candidates,
   not decided:
   - Admit the chat turn inside transcription finish instead of a second queued job.
   - Wake the job worker on insert instead of waiting for its poll.
   - Use the fastest configured transcription path for short voice requests, through the
     existing provider router. Never hardcode a provider or model.
   - Start the chat turn with the lightest routing that can still call tools.
4. Build test-first. `pnpm verify:static` unpiped. Use the `verify-gate` skill for the gate.
5. Independent review by a fresh session on a different model than you. Resolve every finding
   and get re-review.
6. Live proof on the isolated instance through the real chat UI with before and after timings
   recorded on the PR. Release note: Category Changed. Then `gh pr merge --squash --auto`.
7. After it deploys, Ben will time real presses. Record that as the remaining step in the
   Vocci AWAITING-BEN entry rather than waiting.

## Boundaries

- Ben is asleep and has authorized reviewed merges. Don't stop for check-ins. For a real design
  decision, add it to `docs/coordination/AWAITING-BEN.md`, run `needs-ben`, and continue with
  independent work.
- No phone, ring or ADB use. No production database reads or writes.
- Keep exactly-once delivery, the receipt, and the durable destination rules intact.
- Hard invariants in `CLAUDE.md` apply: metadata-only job payloads, provider-agnostic AI, module
  isolation through public APIs.
- This repository is public. Keep hostnames, addresses, credentials and transcripts out of
  committed files.
- Leave the worktree clean and stop owned servers when finished.

## Start

Begin at Cycle step 1 now.
