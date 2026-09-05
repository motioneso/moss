# Relay — #1869 Slice 2 + #2129 regression fix

**Worktree:** `~/Jarv1s/.claude/worktrees/1869-current-time-r20`, branch `build/1869-current-time-r20`
**Coordinator:** agent name `coordinator` (herdr), pane label "Coordinator". Message via
`herdr agent prompt coordinator "<text>"` (herdr-pane-message skill), then verify with
`herdr pane read <pane> --source recent --lines 12`. Resolve the pane fresh each time — don't
reuse a cached `w1:pBN`-style id.
**Plan status: APPROVED by the coordinator**, verbatim reply received:

> "PLAN APPROVED exactly as posted. Keep the diff to those five files, make the prompt-contract
> test red on current code before the wording fix and green after, preserve all existing
> time-authority tests, and record live UI proof for both an ordinary non-time question and a
> direct time question. Continue through pushed PR without ending between steps."

Do not re-ask for approval. Continue straight to finishing the build and opening the PR.

## What's already done

1. **Slice 2's tool (`chat.getCurrentTime`) was already merged into `main` before this session
   started**, via PR #2150 (commit `203d39504`). `packages/chat/src/current-time-tool.ts`,
   `packages/chat/src/manifest.ts`, `packages/chat/src/index.ts`, and
   `tests/unit/chat-current-time-tool.test.ts` already exist on this branch and already pass. No
   new work needed there — do not rebuild it.
2. **The #2129 regression fix is committed** as commit `2b73308ac` on this branch:
   - `packages/chat/src/live/time-context.ts` — the line that told the model to "State that local
     date, weekday, time and time zone as fact" on every turn (the cause of the bug) is replaced
     with an instruction to keep the time in mind silently and only mention it when asked or
     relevant.
   - `tests/unit/chat-engine-text.test.ts` — added a new test proving the context no longer tells
     the model to always state the time, and updated the neighboring test that used to assert the
     old always-state wording. I confirmed the new test failed against the old wording (red) before
     making the fix, and confirmed all 15 tests in the file pass (green) after.
   - Also ran and confirmed green: `tests/unit/chat-session-manager.test.ts` (27 tests),
     `tests/unit/chat-current-time-tool.test.ts` (3 tests).
   - Ran and confirmed clean: `npx eslint packages/chat/src/live/time-context.ts
     tests/unit/chat-engine-text.test.ts --max-warnings=0`, `npx prettier --check` on the same two
     files, `npx tsc --noEmit`.
   - This is the full diff — exactly two files changed. Do not touch anything else (the plan
     approval says "keep the diff to those five files", referring to the two changed here plus the
     three already-merged Slice 2 files it's paired with in the PR).

## What's running right now — you must account for all of it

- **Full gate**, started via `scripts/run-gate.sh start`, gate DB `jarvis_gate_1869_current_time_r20`,
  log `/tmp/jarv1s-gate/1869_current_time_r20-20260902-093919.log`. A `scripts/run-gate.sh wait
  --follow` was launched in the background (task id `b4ri7590a` in the relayed session — that id is
  meaningless to you; just re-run `scripts/run-gate.sh wait --follow` yourself as a fresh
  `run_in_background` Bash call and read the exit code / `### FINAL` line when it completes). Do
  NOT start a second `scripts/run-gate.sh start` until you've confirmed the first one isn't still
  running (`scripts/run-gate.sh wait` will just re-attach).
- **Manual dev instance I started from this worktree, on the standard ports** (nothing else was
  listening on them at the time):
  - API: `nohup pnpm dev:api > /tmp/1869-dev-api.log 2>&1 &` → PID **931471**, port 3000, confirmed
    `GET /health` → 200.
  - Web: `nohup pnpm dev:web > /tmp/1869-dev-web.log 2>&1 &` → PID **931688**, port 5173, confirmed
    200.
  - This is a normal from-source dev instance against the shared dev Postgres (`jarv1s-postgres`
    :55433, db `jarv1s`) — the same one described in memory `dev-preview-recipe`. Login
    `ben@ben.com` / `jarvistest123!`.
  - **You must stop both PIDs by exact PID (`kill 931471 931688`, confirm with `ps -p`) once the
    live-proof step below is done, before you report to the coordinator.** Never kill by name
    pattern — a stray unrelated `pnpm dev:api` process (PID 1121269, not listening on any port, not
    yours) is also present on the box; leave it alone.

## What's left — do these in order, then stop

1. **Finish the live-UI proof** (the coordinator explicitly required this in its approval). A
   scratch Playwright script is at the worktree root: `1869-live-proof.mjs` (untracked — do not
   commit it, delete it when done). It logs in, opens chat, asks an ordinary question then a direct
   time question, and captures the `/api/chat/turn` request bodies plus a screenshot. It currently
   fails on `page.getByRole("button", { name: "Send" })` matching two elements (a feedback-toolbar
   button also matches by accessible name) — scope it the way
   `tests/uat/specs/runtime-context.uat.spec.ts` does, e.g.
   `page.getByRole("button", { name: "Send" }).and(page.locator(".chatd-send"))` or use the
   `.chatd-send` class selector directly. Fix that, rerun, and read the actual assistant reply text
   from the page (find the right selector for the assistant's message bubble — inspect the DOM via
   `page.content()` or a screenshot if the guessed selector doesn't match).
   - **What "pass" looks like:** for the ordinary question (e.g. "What's a good name for a pet
     goldfish?"), the reply does NOT contain a volunteered date, weekday, time, or time zone. For
     the direct question ("What time is it right now?"), the reply DOES give an accurate time/date
     that matches the server's actual current time and the account's configured local time zone (or
     admits it doesn't know the zone, if none is configured — check Settings first if unsure).
   - Save a screenshot and the two reply texts; you'll quote them in the PR comment.
   - If the account has no chat-capable AI provider configured (check for a "Connect a provider"
     empty state, as the UAT spec's scope note describes), that's a real blocker — check Settings →
     Assistant & AI on the running dev instance first, and if there's genuinely no usable provider,
     escalate to the coordinator rather than guessing at a fix; do not fabricate reply text.
   - Also run the UAT spec this diff triggers per `.claude/skills/coordinate/uat-trigger-map.tsv`
     (`packages/chat/**` → `tests/uat/specs/runtime-context.uat.spec.ts`, blocking) — `pnpm
     test:uat -- runtime-context.uat.spec.ts`, unpiped, record the exit code. Note in the PR that
     this spec cannot exercise a real model reply (see its own header comment) — it's a
     complementary structural check, not a substitute for the manual live-UI proof above.
2. **Stop the two dev-instance PIDs** (931471, 931688) once the proof is captured. Delete
   `1869-live-proof.mjs` and the scratch logs under `/tmp/1869-*` are fine to leave (not part of the
   repo).
3. **Confirm the full gate is green** (`### FINAL rc=0` in the gate log). If red, debug
   (`superpowers:systematic-debugging`) before proceeding — don't report done on a red gate.
4. **Pre-push trio + rebase:** `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`. Fix anything that breaks.
5. **Push and open the PR:**
   `git push -u origin build/1869-current-time-r20`, then `gh pr create --base main --head
   build/1869-current-time-r20` with a title like `fix(chat): current-time tool + stop
   volunteering date/time (#1869, #2129)`. Body: scope (Slice 2 tool already-merged context, plus the
   #2129 wording fix), spec link
   (`docs/superpowers/specs/2026-08-30-1869-date-time-context.md`), gate exit codes, and the
   "Release note" section per CLAUDE.md (Category: Fixed, plain-English description of the
   volunteering-time bug fix — no file paths or code terms).
6. **Post the live-path proof as a PR comment** (`gh pr comment`): the two live chat exchanges
   (question asked, reply text or a tight excerpt), the screenshot reference, and the UAT run exit
   code.
7. **Report to the coordinator** via `herdr agent prompt coordinator` (herdr-pane-message skill),
   terse and result-first, e.g.: "1869 DONE. PR: <link>. Gate rc=0 (gate DB
   jarvis_gate_1869_current_time_r20). Live-path: proof comment posted (ordinary question — no
   volunteered time; direct time question — accurate reply). Branch pushed, rebased on origin/main
   as of <sha>. Dev instance stopped (PIDs 931471/931688). Ready for QA + merge. [pane <your pane
   id>]". Then **stop** — do not merge, do not touch the board.

## Standing rules (carry these to anyone else you spawn)

- Plain English in all chat/status text — no jargon, no coined shorthand (box-wide CLAUDE.md rule).
- Never pipe a gate command. DB-touching test commands go through `scripts/run-gate.sh` only.
- Never `git add -A`. Stage explicit paths.
- This relay is the ONE relay budget for this lane (Ben's rule: one session per unit of work). If
  you also hit the 70% context warning before the PR is open, do NOT relay again — push what you
  have, write the state to a doc, and tell the coordinator the slice needs re-scoping into smaller
  lanes.
- Do not edit anything under `docs/coordination/`.
- Never end your turn mid-procedure — chain straight into the next step.
