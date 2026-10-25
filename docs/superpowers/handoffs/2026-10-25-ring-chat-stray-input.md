# Ring chat input: stray "." pinned to the bottom of chat

Bug follow-up for #3584 under the approved
`docs/superpowers/specs/2026-10-20-vocci-automatic-delivery.md` and the normal-chat-input plan
`docs/superpowers/plans/2026-10-24-vocci-normal-chat-input.md`. Ben reported the symptoms
on 2026-10-25. The user has authorized reviewed merges.

## Observed in production (2026-10-25, through the real UI and the app's own API)

- Main chat shows a user bubble containing only ".". Ben did not type it.
- `GET /api/chat/voice-requests` returns one request: created 2026-10-24T23:50:36Z, transcript
  ".", state `interrupted`, `userMessageId` and `assistantMessageId` null, status message
  "This request was interrupted. Check Main chat before sending a new message."
- That status message shows as a notice at the bottom of chat and never clears, even though Ben
  is already in Main chat.
- Ben: "The dot stays even when I send another message." It stays below newer messages.
- Moss could not explain the notice, because the app map has no entry for it.
- Unproven: an earlier lamp request answered "Done" and then reported itself aborted. It may be
  the same interruption. Check it, but don't claim it without evidence.

## Diagnosis so far

- `apps/web/src/chat/voice-input-records.ts` `mergeVoiceInputRecords`: a request with no saved
  records and no later voice request is spliced at `records.length`. That puts it at the end on
  every merge, after any newer typed turn. Place it by `createdAt` among the timestamped
  records instead.
- A punctuation-only or empty transcript (a near-silent ring press with hold-to-talk on) is
  accepted as a normal chat input. It should be dropped before it becomes a chat turn. Decide
  where the server should do this deterministically, and keep the original recording and its
  receipt.
- The interrupted state needs a truthful, clearable outcome. Its copy must not send the person
  to Main chat when they are already there. Keep the copy short, following
  `feedback-ui-copy-is-marketing-not-documentation`. Add the notice and its remedy to the app map
  in the same PR.

## Cycle

1. `pnpm install`. Read `AGENTS.md`, `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, the spec and
   plan above, and the commits `df7e0667e` and `dc4ebd4ca`.
2. Commit a bounded plan with the repo `plan-build` skill. Use test-first behavioral checks for
   each of the three bugs.
3. Implement. Focused tests, `pnpm verify:static` unpiped. Use `verify-gate` for anything that
   touches a database. Claim ports with `devports`. Use the `design-system` skill for any UI.
4. Independent Standards and Spec reviews by a fresh session on a different model than the
   builder, against immutable base/head commits. Resolve every finding and get re-review.
5. Live proof on an isolated instance through the real chat UI with a seeded voice request
   (`scripts/proofs/seed-legacy-voice-input.ts` is a starting point). No intercepted responses.
   Record it on the PR. Run exact-head CI, fill the Release note, then
   `gh pr merge --squash --auto`.
6. After deploy, confirm that production chat no longer pins the dot or the notice. Clearing
   Ben's existing stuck request needs his OK first.

## Boundaries

- No phone, ring or ADB access, and no new recordings.
- No production database reads or writes. Use the product's screens and API.
- This repository is public. Keep hostnames, addresses, credentials and private transcripts out
  of every committed file.
- Another session (`meeting-claude-fix`) is changing Meeting summaries. Don't touch that.
- Leave the worktree clean and stop owned servers when finished.

## Start

Begin at Cycle step 1 now.
