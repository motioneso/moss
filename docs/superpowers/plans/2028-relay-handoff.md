# Handoff for issue 2028 - Gemini as a real chat provider

Plain English only, in everything a human reads, and pass that rule to anything you spawn.

## Where things stand

Branch `fleet/lane-2028`, three commits:

- `69cff249e` the spec, also posted on the issue
- `c165793c6` the build plan: `docs/superpowers/plans/2026-08-27-2028-gemini-chat-provider.md`
- `961d83563` the new Google chat path. **The tree does not typecheck yet** - callers still name
  the old tool. Finishing that is your first job.

Read the plan document. It has the measured flag list, the measured output shapes, the three traps
and the five decisions. Do not re-derive them.

## What is verified

Everything below was measured against the real tool, version 0.57.0, installed at
`/tmp/gemini-scratch`. Trust it.

- The command is `gemini`, not `agy`. The old code launched a tool that is never installed, so the
  whole Google chat path was dead, not just the one line the issue asks for.
- First turn takes `--session-id <uuid>`, later turns take `--resume <uuid>`. Passing both makes
  the tool refuse to start.
- With `-o stream-json` the reply arrives as many small chunks that must be joined in order, and
  the turn ends on a `result` line.
- A throwaway folder is untrusted, which silently downgrades approval and makes the run hang. The
  `--skip-trust` flag fixes it.
- The tool writes crash reports into the temporary folder and they quote the founder's question
  word for word. The launch line points the temporary folder at the session folder so they get
  deleted with everything else.
- An empty built-in tool list really does turn every built-in tool off. Checked in the tool's own
  code: it treats the empty list as "allow none", not as "not configured". That is what makes
  automatic approval safe here.
- A headless run does leave state behind: two folders named by a short id, an entry in a registry
  file, and stray temporary copies of that registry. The short id cannot be worked out from the
  folder name - it has to be read from the registry.
- **There is no signed-in Google account on this machine.** `~/.gemini/google_accounts.json` has no
  active account and there are no stored credentials. An agent cannot finish a browser sign-in. So
  the live end-to-end proof the brief asks for is very likely not producible. If you confirm that,
  the honest status is code-complete, unverified - say so plainly on the pull request. Do not claim
  done.

## Next steps, in order

1. Make it compile. `pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"` and work the list:
   - `packages/chat/src/live/cli-chat-engine.ts` - the long-lived multiplexer path still calls the
     removed Antigravity helpers. Replace them with the new ones in
     `private-transcript-cleanup.ts`: generate the session id up front, pass it on the launch line,
     save it with `persistGeminiSessionIdentity`, and purge with `purgeGeminiConversation`. This
     path is not the one Google chat actually uses (every provider row is set to one-shot mode), so
     make it honest and commented, not proven.
   - `packages/chat/src/live/cli-launch-commands.ts` - `buildGeminiCommand` still builds the old
     tool's flags. Use the real ones. Drop the `disableYoloMode` setting: with it on, the tool
     refuses to start when automatic approval is asked for. Keep the empty built-in tool list.
   - `packages/ai/src/cli-availability.ts` line 23 - make `gemini` the main command name and keep
     `agy` only as an alias if anything still needs it.
   - `packages/module-registry/src/chat-multiplexer.ts` line 286 - it runs `agy auth status`. The
     pinned tool has no `auth` command at all. Copy the one-shot check that already works in
     `packages/chat/src/live/provider-probe.ts` line 81.
2. Tests. Delete `tests/unit/agy-print-chat-engine.test.ts` and write
   `tests/unit/gemini-print-chat-engine.test.ts` in its place, reusing its fake input/output and
   spawn scaffolding. Cover: first turn's command, second turn resuming, no command anywhere under
   `packages/` starting with `agy`. Also update `tests/unit/private-transcript-cleanup.test.ts`,
   `tests/unit/ai-tmux-bridge.test.ts`, `tests/unit/cli-runner-execution-mode.test.ts`,
   `tests/unit/cli-runner-server.test.ts`, `tests/unit/chat-multiplexer-provider-check.test.ts`,
   and add a reader test with a recorded sample of the tool's output.
3. The last piece the issue literally asks for: add the Google entry to `DEFAULT_CHAT_MODELS` in
   `packages/ai/src/auto-register.ts` (display names "Gemini (default model)" and "Gemini",
   interactive tier, chat capability) and the Google model list to `CLI_STATIC_MODELS` in
   `packages/ai/src/model-discovery.ts`. Both files currently carry a note saying Google is
   deliberately absent - replace those notes. Some tests assert Google is absent; update them.
4. Wrap up: format check, lint, typecheck, each written as `<command> > /tmp/x.log 2>&1;
   echo "EXIT=$?"` with no pipe. Rebase on `origin/main`. Full gate **only** through the
   `verify-gate` skill - an unscoped run hits the live development database. Push, open the pull
   request, run `node scripts/append-release-note.mjs --pr <number>` and commit the result, then
   `node /home/ben/jarv1s-fleet/fleetctl.mjs set 2028 status=pr-open pr=<number>`.

## Things that will bite you

- Never run a database-touching test outside the `verify-gate` skill.
- Never pipe a verification command. The exit code gets lost and a failure reads as a pass.
- Port 1533 is production. Never a test target.
- Stage files by name. Never `git add -A`, never a repo-wide format.
