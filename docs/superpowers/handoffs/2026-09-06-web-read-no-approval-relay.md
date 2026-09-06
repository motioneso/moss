# Handoff: page reader should stop asking for approval (issue #2326)

Worktree: `/home/ben/Jarv1s/.claude/worktrees/web-read-no-approval`
Branch: `build/2326-web-read-no-approval`
Coordinator: agent named `coordinator`, pane label "Coordinator"

## What this task is

The page reader tool, `web.read`, used to ask the person to approve every single call. Ben ruled
on 2026-09-05 that it must stop asking. Full task and his ruling: `gh issue view 2326`.

## Done (all committed, one commit on the branch)

1. `packages/web-research/src/manifest.ts` — `web.read` no longer declares
   `selfOperationGrant: "confirm_always"`. Its risk changed from `"write"` to `"read"`, which is
   the code's existing rule for "never ask, just run" (same as `web.search`). Comment rewritten to
   record the new decision and the reason.
2. `packages/ai/src/gateway/self-operation.ts` — `web.read` removed from the list of tools allowed
   to demand a confirmation on every call. Both comment blocks that explained the old reasoning are
   rewritten to explain the new decision.
3. `docs/superpowers/specs/2026-09-04-web-search-default-native.md` — the line saying this
   behavior would not change is updated, and a new section spells out the accepted risk in plain
   words: page text is untrusted, a hidden instruction in a page could tell the assistant to fetch
   a second address and carry private information out, the private-address block still stops the
   local half of that, and Ben has accepted the remaining risk on public addresses.
4. Three test files updated to check the new rule instead of the old one (counts and lists that
   enforce which tools are allowed to always-confirm): `tests/unit/web-research.test.ts`,
   `tests/unit/self-operation-manifests.test.ts`, `tests/integration/mcp-gateway-self-operation.test.ts`.
5. Checked the app map (`packages/shared/src/app-map-core.ts` and the web-research module's own
   manifest): the page reader has no screen, setting, or navigation entry that mentions the
   approval prompt, so nothing there needed changing.
6. Ran the full local gate (`scripts/run-gate.sh`) — passed, exit code 0.
7. Ran the pre-push checks (formatting, lint, full typecheck) — all clean.
8. Rebased on `origin/main` — already up to date, no conflicts.

## Not done yet — this is the actual next step

**The live proof has not been produced or posted.** Nothing has been pushed and no pull request is
open yet. Both are still required before this is done.

The tricky part: the shared development instance that normally proves this kind of change runs
from the main checkout at `/home/ben/Jarv1s`, on the current `main` branch — not from this
worktree's branch. I must not touch that main checkout. I was partway through working out how to
prove this change live from inside this worktree instead, without touching the shared instance,
when I had to stop and hand off.

What I found so far, for the next session to pick up:
- A written recipe for exactly this situation already exists — see the memory file named
  `kill-gate-2175-dev-approval-prompt-trap`. Short version: run `pnpm dev:api` from this worktree
  on its own port (not the shared instance's ports), log in with a cookie through the sign-in
  endpoint, open the chat stream, send one chat turn, and check the results — no automated browser
  click needed. That avoids the main checkout entirely.
- There is also a "real chat" test setup in `tests/uat/real-chat-env.ts` that can drive an actual
  chat model through a decrypted login token, used for other proofs like this one. It was not
  finished being checked before I had to stop.
- The proof needed, in the plainest terms: start a chat turn that makes the assistant read a real
  web page, and show two things — no approval prompt appeared for that page read, and the turn
  finished with an answer. The Live-Path Gate rule says not to use screenshots for this — use exact
  log lines, database rows, or similar plain evidence instead, and quote them in the pull request.
- One more thing worth checking before trusting any "no approval prompt" result: confirm through a
  log line or a database row that `web.read` actually ran (not just that no prompt appeared,
  which could also mean the assistant never tried to read a page at all).

## Plan for the rest of this task

1. Work out the live proof using the worktree-only recipe above (no shared instance, no main
   checkout).
2. Push the branch and open the pull request. Fill in the release note section of the pull request
   template — this is a user-visible fix ("Changed" category, plain description: the assistant no
   longer asks permission every time it reads a web page).
3. Post the live proof as a comment on the pull request, with what was run and what was seen.
4. Report the pull request and the proof to the coordinator. Then stop — merging, closing the
   issue, and moving the project board are the coordinator's job, not this lane's.

## Rules that still apply

- Never touch `/home/ben/Jarv1s` (the main checkout) or port 1533 (the real live system).
- Any gate run goes through the `verify-gate` skill, never a hand-rolled command, never piped.
- This is meant to be one relay only. If the next session also hits the 70 percent context warning
  without an open pull request, stop and report to the coordinator for a re-slice instead of
  relaying again.
- Every message a person reads — status updates, this document, anything sent to the coordinator —
  must be in plain English: no invented shorthand, plain punctuation, at most one piece of code
  formatting per sentence. Exact names like file paths and pull request numbers are fine to keep,
  just do not lead with them or stack several together.
