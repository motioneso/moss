# Relay — issue 1869, slice 1 (per-turn time context)

Spec: `docs/superpowers/specs/2026-08-30-1869-date-time-context.md`
Plan: `docs/superpowers/plans/2026-08-30-1869-date-time-context.md` — your scope is the
"Slice 1 - fresh `<current_time_context>` on every turn" section ONLY. Do not start slices 2, 3A,
or 3B.
Branch/worktree: `build-1869-time-context`, this same worktree.
Coordinator: herdr agent name `coordinator` — confirm exactly one live agent with that name via
`herdr agent list` before messaging it. It already approved this plan with no changes ("Clean,
in-scope plan, matches the spec — approving.").
Relay depth: this is relay 1. If your own context-meter 70% warning fires again with no PR open,
do NOT relay again — push what you have and report to the coordinator that the slice needs
re-slicing into smaller pieces.

## What is done (not yet committed — do that first)

- New file `packages/chat/src/live/time-context.ts`: a plain function that turns a moment in time
  and an optional time zone into the small block of text that gets added to every message sent to
  the assistant. It always includes the current time in UTC; it adds the person's local date,
  local time, and time zone offset only when a valid time zone was given.
- Edited `packages/chat/src/live/engine-text.ts` (the code that builds the text sent to the
  assistant each turn):
  - It can now be told what "now" is from outside (for tests); if not told, it uses the real
    clock.
  - Every path through this function now puts the time block in front of whatever else it sends
    to the assistant — including the path used when none of the optional lookup features
    (memory recall, cross-tool reading, notes) are turned on, which used to skip everything.
  - If the step that looks up the person's saved time zone fails, the time block still appears,
    just without the local date and time (only the UTC time is shown).
- Edited `tests/unit/chat-engine-text.test.ts` to match: fixed two existing tests that used to
  expect no time block, and added three new tests: no optional features turned on, the time-zone
  lookup failing, and a lookup step throwing partway through the main path.

## What is NOT done yet — next steps, in order

1. **Run the tests for what's built so far and make sure they actually pass.** Nothing has been
   run yet this session:
   `pnpm test:unit tests/unit/chat-engine-text.test.ts` (do not pipe the output; check the exit
   code). Fix any mismatch.
2. Do the same change to the other half of the chat turn code, in
   `packages/chat/src/live/chat-session-manager.ts`: it needs the same "what time is it right now"
   override so tests can control it, threaded through to the call that builds the message text
   (around line 418-429, still accurate on this branch). Read the plan's Slice 1 section for the
   exact field name to add.
3. In `tests/unit/chat-session-manager.test.ts`, add the key proof test: send two messages in the
   same ongoing conversation with the clock moved forward across the person's local midnight, and
   check that the two messages sent to the assistant carry different, correct local dates without
   the conversation having to restart. Also check that the fixed introduction text shown to the
   assistant at the start of a conversation does not change between the two messages (no dates
   leaking into it). Also find the existing test with the phrase "continues with raw text when
   passive retrieval throws" and update its expectation the same way the two tests in
   chat-engine-text.test.ts were fixed — it will now also get the time block in front.
4. Run the full check list at the end of the plan's Slice 1 section (search for "Slice 1
   verification" in the plan file): the two test files, a type check, a lint check on the exact
   five changed/added files, and a formatting check. Run each one without piping its output, and
   check the exit code every time.
5. Then follow `coordinated-wrap-up`: the quick pre-push checks, the proper test-database gate
   (only through the `verify-gate` skill, never a raw command), push the branch, open the pull
   request, and post a real live demonstration — a real conversation on the dev site showing the
   assistant behaves sensibly with the time information now included — as a comment on the pull
   request. Say plainly that this is the judgment call that decides whether the later pieces of
   this work (issue 1869 slices 2 and 3A) can start.

## Facts already confirmed — don't re-derive these

- This worktree was brought fully up to date with the main branch before any code was written; no
  other changes are mixed in.
- Every place in the code that the plan expects to exist and edit was checked and matches the plan
  exactly — no surprises, no renumbering needed.
- There is already an unrelated "clock" used elsewhere in `chat-session-manager.ts` for a
  completely different purpose (measuring how long a conversation turn has been idle). Do not
  reuse it for the new "what time is it" seam — the plan keeps them separate on purpose.
