# Onboarding Service Testing Webwright Handoff

## Current State

- Repo: `~/Jarv1s`
- User wants a fresh session to Webwright-test the onboarding service testing flow.
- Webwright is installed for Codex:
  - Codex plugin: `webwright@webwright`, installed and enabled.
  - Skill cache: `~/.codex/plugins/cache/webwright/webwright/0.1.0/skills/webwright/SKILL.md`
  - Runtime command: `~/.local/bin/webwright`
  - `webwright doctor` from the Webwright checkout passes Python, Playwright, browser screenshot, and plugin manifest checks. It only fails `OPENAI_API_KEY`, which is expected for host-driven plugin mode.
- API and web dev servers were running when this handoff was written:
  - API: `pnpm dev:api`, expected at `http://localhost:3000`
  - Web: `pnpm dev:web`, expected at `http://localhost:5173`
- Be careful restarting the API. The app currently lacks a stable `BETTER_AUTH_SECRET`; API restart can invalidate the user's session. If you restart API, reset the DB afterward before asking the user to test onboarding again.

## User Context

The user reported:

- "Codex and Gemini still aren't working but those notes are being resolved"
- They want the new session to use Webwright to test service testing.

I reopened the two Agentation notes and they should stay unresolved until there is live proof:

- `mqj0rsx2-buxd86`: "Codex testing still didn't work despite the service saying OK iin the pane"
- `mqj0swx3-i3cey5`: "Testing still isn't working for Gemini either. I can see it's logged in and you need to hit enter to accept the folder"

Do not mark these resolved just because the code looks plausible or the pane printed `OK`. Verify the UI result and route behavior end to end.

## Relevant Changed Files

Primary service-testing code:

- `packages/module-registry/src/chat-multiplexer.ts`

Provider-check changes already made:

- `PROVIDER_CHECK_TIMEOUT_MS` is now `25_000`.
- Non-Anthropic providers receive an initial empty submit to acknowledge prompts.
- Non-Anthropic providers receive periodic empty submits while waiting, intended to accept folder/trust prompts.
- `isProviderCheckOk()` accepts exact `OK`.

Important suspected remaining bug:

- Codex transcript detection probably reads the wrong `.jsonl` when another Codex session is active.
- Current transcript discovery looks at the latest file under `~/.codex/sessions/YYYY/MM/DD`. That can select this coding session, not the provider-check pane.
- Gemini transcript discovery likely does not recurse or does not match current Gemini output layout under `~/.gemini/tmp`, so the pane may show login/trust/OK while the API cannot parse a result.

Likely code to inspect next:

- `packages/chat/src/live/cli-chat-engine.ts`
- `packages/ai/src/adapters/tmux-bridge.ts`
- `packages/ai/src/adapters/transcript-reader.ts`
- `packages/module-registry/src/chat-multiplexer.ts`

## Live Evidence Seen So Far

Codex provider-check pane/session did produce an `OK` in a recent Codex transcript, but the UI still reported failure. That points away from "Codex is not authenticated" and toward "the API/provider-check code is reading the wrong transcript or missing the correct transcript event."

Known recent Codex transcript with provider-check content:

- `~/.codex/sessions/2026/06/17/rollout-2026-06-17T21-58-01-019ed917-e22f-7893-889e-0f6b069bbf15.jsonl`

Earlier inspected transcript showed:

- `event_msg` payload `agent_message` with message `OK`
- `response_item` output text `OK`
- `event_msg` payload `task_complete` with `last_agent_message: "OK"`

No recent Gemini JSONL was found where the parser expects it. Files seen under Gemini included:

- `~/.gemini/tmp/jarv1s-provider-check-s9iwyp/logs.json` with `[]`
- `~/.gemini/state.json`
- `~/.gemini/oauth_creds.json`
- `~/.gemini/projects.json`
- `~/.gemini/.project_root`

This supports the hypothesis that Gemini is either stuck at a folder trust prompt, writing logs elsewhere, or not producing a transcript readable by the current parser.

## Webwright Test Assignment

Use Webwright against the actual local app:

1. Open `http://localhost:5173`.
2. If the DB has been reset and onboarding appears, create/sign in with a disposable local user.
3. Navigate through onboarding to the CLI/service testing step.
4. Run the service tests for Codex and Gemini.
5. Save the action log under `final_runs/run_<id>/`.
6. For each provider, record assertions for:
   - the UI state before clicking test,
   - the live provider pane behavior if visible,
   - the UI result after the request completes,
   - the API log timing/status if available,
   - the transcript file that actually contains the provider's response, if any.
7. Only mark Agentation notes resolved when UI and backend behavior are both confirmed.

Recommended Webwright prompt for the new session:

```text
@webwright Test the Jarv1s onboarding service-testing flow at http://localhost:5173. Focus only on the CLI/service provider testing step for Codex and Gemini. Record before/after DOM state and provider request/result evidence, then verify whether the UI result matches the provider pane/transcript. Do not modify code. Do not resolve Agentation notes unless the live UI and backend behavior are confirmed.
```

## Debugging Plan If Tests Fail

For Codex:

1. Inspect newest provider-check transcript and this session's transcript list:

   ```bash
   ls -lt ~/.codex/sessions/2026/06/17/*.jsonl | head -20
   tail -n 80 ~/.codex/sessions/2026/06/17/rollout-2026-06-17T21-58-01-019ed917-e22f-7893-889e-0f6b069bbf15.jsonl
   ```

2. Confirm whether `CliChatEngineImpl.resolveTranscriptPath()` can distinguish the provider-check session from ordinary Codex sessions.
3. A robust fix is likely to filter Codex transcript candidates by `session_meta.payload.cwd === neutralDir` rather than selecting the newest file globally.

For Gemini:

1. Inspect recursive Gemini tmp output:

   ```bash
   find ~/.gemini -maxdepth 6 -type f -printf '%T@ %p\n' | sort -nr | head -80
   ```

2. Verify where Gemini writes the provider-check response, if anywhere.
3. If Gemini needs an Enter to accept folder trust, verify the current periodic empty submit actually reaches the pane.
4. If Gemini does not write JSONL in the current CLI version, either add parser support for the actual file format or change provider-check to use a one-shot CLI mode that returns stdout.

## Verification Commands After Any Code Fix

Run targeted checks first:

```bash
pnpm exec vitest run tests/integration/onboarding.test.ts
pnpm exec playwright test tests/e2e/onboarding.spec.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm check:file-size
```

If the API is restarted for code changes, reset the DB before handing back to the user:

```bash
pnpm db:down
pnpm db:up
pnpm db:migrate
pnpm dev:api
pnpm dev:web
```

Then tell the user the URL is `http://localhost:5173`.

## Guardrails

- This repo has many uncommitted onboarding design changes. Do not revert unrelated files.
- Do not use `git reset --hard`, `git checkout --`, or broad staging commands.
- `docs/superpowers/specs/2026-06-15-corrections-log.md` was already untracked before this handoff; leave it alone unless the user asks.
- Keep the Codex/Gemini Agentation notes pending until live verification succeeds.
