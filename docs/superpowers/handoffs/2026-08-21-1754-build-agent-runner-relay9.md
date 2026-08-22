# 1754 build agent runner — relay 9

PR: https://github.com/motioneso/moss/pull/1816 (open, not merged, do not merge)

## Status: coordinator sent it back. Do not re-read the spec or plan. Read this in full, then go straight to "What's left."

The coordinator rejected the PR on 2026-08-21 around 21:42 UTC with two findings, both confirmed
true by me independently:

1. **The feature isn't actually connected to anything.** I searched the whole branch, leaving out
   test files, for anyone calling the three entry points this PR adds:
   - `startModuleBuild` (`packages/ai/src/module-build/start-build.ts`) — nobody calls it.
   - `runModuleBuildStep` (`packages/ai/src/module-build/run-build-step.ts`) — nobody calls it.
   - `createModuleBuildWorker` (`packages/jobs/src/module-build-jobs.ts`) — nobody calls it, and
     nothing registers a worker on the build queue at startup.
   Installing this build today changes nothing a person can see or trigger.
2. **The full test run (CI) failed**, not just the known flaky test I reported last relay. Check
   with: `gh pr checks 1816`. "Verify foundation and app" and "CI gate" both show failed.

Full text of the coordinator's PR comment: `gh pr view 1816 --comments` (read it in full, it has
more detail than this summary).

## The one open question — ask the coordinator before writing the fix

`runModuleBuildStep` needs a function called `launchLiveAgent` that actually starts the coding
agent and waits for it to finish a build step. The code's own comment says to build that function
out of two existing pieces in `packages/chat/src/live`: `buildLaunchCommand` and
`writeClaudePermissionHook`.

I read both closely. They don't do what's needed here:

- `buildLaunchCommand` only builds a line of shell text meant to be typed into a live, interactive
  terminal window. That terminal session never finishes on its own — a real person has to click
  approve or deny on every action it wants to take, then eventually close it. There's no way to
  call this and get back "done, here's what it wrote" the way an unattended background build needs.
- `writeClaudePermissionHook` is the piece that shows that approve/deny popup to a person. A
  background build has no person watching it, so this can't be the approval mechanism here either.

There's a second, different piece in the same folder built for exactly this situation:
`ClaudePrintChatEngine` (`packages/chat/src/live/claude-print-chat-engine.ts`). It was built in an
earlier, unrelated task specifically to run Claude with no visible terminal and no human clicking
anything, and it already knows how to tell when a run has finished, by reading its own private
transcript file. That looks like the right building block — not the two the code comment names.

**I sent this question to the coordinator by message before relaying** (confirmed sent, but could
not confirm it was read — the coordinator's terminal had Ben actively typing in it at the moment I
checked, so I did not wait on it). If the coordinator has not answered by the time you pick this
up, re-ask before spending time writing the composition, since building it against the wrong piece
would be wasted work. If no answer arrives quickly, my own judgment is to use
`ClaudePrintChatEngine` — it exists for exactly this "run headless, tell me when it's done"
purpose — but confirm rather than guessing if there's time to ask.

One more thing worth checking once you're inside `ClaudePrintChatEngine`: its transcript records
carry a tool name and outcome, but I did not find where they'd carry which files were written —
that's needed for the `wroteFiles` result the step function expects. Check `parseTranscript` in
the `@moss/ai` package for whether the raw file path is available anywhere before assuming it needs
new plumbing.

## What's left — do this next, in order

1. Get the coordinator's answer on the composition question above (or proceed on the judgment call
   noted above if there's no answer and time is short).
2. Register a real worker on the build queue at startup, the same way other queues are registered
   in `apps/worker/src/worker.ts` — read that file for the pattern other modules already use
   (`registerDataContextWorker`, `boss.work`, etc.), don't invent a new shape.
3. Write the real `launchLiveAgent` and wire it into `runModuleBuildStep`'s dependencies at the
   worker's startup composition, instead of only ever being given a fake in tests.
4. Add at least one test that runs the real composition (not a fake `launchLiveAgent`) — even a
   narrow one that proves the wiring exists and calls through, is enough; it does not need to run a
   real Claude session in CI.
5. Fix the PR description (`gh pr edit 1816`) so it says plainly what is and is not wired — don't
   leave it claiming the runner works end to end.
6. Get a clean run: `scripts/run-gate.sh start` locally, then push and wait for
   `gh pr checks 1816` to come back green (or only the known flake from before — check with
   `gh pr checks 1816`, don't assume).
7. Report back to the coordinator the same way I did this relay: confirm with
   `herdr agent list` that a live agent is still registered under the name `coordinator` (names can
   move between relays), then `herdr agent prompt coordinator "<message>"`, then verify with
   `herdr pane read <its pane> --source recent --lines 12` that it actually landed — unless, like
   this relay, the coordinator's pane shows Ben himself actively typing, in which case send it and
   move on without waiting to watch it be read.

## Standing rules (carried on every relay, pass this on to anyone you spawn)

- Plain English in every message to the coordinator, every spawn prompt, and this document. Say
  what something does, not what the code calls it. Keep exact names only for things someone must
  literally type or open — a command, a file path, an error string.
- Do not report anything done until you've actually checked it yourself. If CI is red, say so and
  show the check output, don't just say "should be fine."
- This is a shared checkout — other sessions are working in other worktrees on this same machine.
  Only touch files inside this branch's scope. Never `git add -A`.
- Relay again at the next 70 percent context warning, or if you see a compaction summary.
- Do not move the project board, close the issue, or merge — that is the coordinator's job, not
  yours.
