# Vocci hold-to-talk: cut the chat-turn wait

Follow-up to #3584 after PR 3707. Read first:

- `docs/evidence/vocci/2026-10-25-server-latency.md` (stage timings)
- `docs/superpowers/plans/2026-10-25-vocci-server-latency.md` (ranked options, proven seams)
- `docs/superpowers/plans/2026-10-25-vocci-hold-latency.md` (phone-side timeline)

## Goal

Ben wants a ring long press ("turn off the lights") to act as close to immediately as
possible, and would like the current total halved. After PR 3707 the server queues cost
about 30 ms. What remains on the server:

1. **Busy-chat retry.** When the chat turn is busy, voice admission returns `deferred`
   and reschedules 15 s later (`packages/chat/src/voice-request-service.ts`, the
   `schedule(db, actor, id, 15)` call). Run 9 sample 1 waited 15.5 s this way.
2. **Model turn.** Upload return to first tool call is 3.4-10 s, with one 23 s outlier.
   It is not broken down by stage: CLI or session startup, tool discovery, time to the
   first token, and the model's own thinking.

## Cycle

1. `pnpm install`. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md` and the
   docs above. Search Hindsight for "voice request", "chat session manager", "deferred
   admission" and "tool discovery".
2. **Busy-chat retry.** Admit a deferred voice request as soon as the blocking turn ends,
   keeping the delayed job as the fallback. Keep the existing guarantees: exactly once,
   in order beside live turns, the receipt, replay, and interruption. Build test-first.
3. **Model turn.** On an isolated instance (verify-gate, a `devports` port, or moss-proof
   on 5181), time the turn in stages with temporary local timing only. Never log
   transcripts, prompts or secrets. Write a ranked option list with the `plan-build`
   skill. Build options that keep the configured provider and model and need no new
   setting, for example a warm session, cached tool discovery, or less prompt per turn.
   An option that changes which model answers voice commands, or adds a setting, is a
   decision for Ben (see Boundaries). Write it up, don't build it.
4. `pnpm verify:static` unpiped. Use `verify-gate` for anything touching a database.
5. Independent review by a fresh session on a different model from the builder (pick
   with `llm-pick review`). Resolve every finding.
6. Live proof on the isolated instance through the real voice-recording API and Chat,
   with text-to-speech audio only. Record before and after timings for each stage on the
   PR and in a committed evidence doc. Release note: Category Changed. Then
   `gh pr merge --squash --auto`.
7. Update the Vocci entry in `docs/coordination/AWAITING-BEN.md`: Ben times real presses
   after `updateMoss`, plus any model-choice decision from step 3.

## Boundaries

- No phone, ADB or ring. No production database reads or writes.
- Hard invariants apply, including provider-agnostic AI. Never hardcode a model or
  provider, and never silently swap the user's model or remove tools to win a benchmark.
- A real decision for Ben goes in AWAITING-BEN and through `needs-ben vocci-turn-latency
  "<question>"`. Keep building whatever doesn't depend on the answer.
- Public repo. Keep hostnames, addresses, device ids, credentials and transcripts out of
  committed files.
- Leave the worktree clean and stop any servers you start.

## Start

Begin at Cycle step 1 now.
