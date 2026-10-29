# One path for Meeting summaries - slices 1 and 2

Issue #3696, parent #3689. Spec is [the one-path spec](../specs/2026-10-25-one-path-for-ai-calls.md), approved 2026-10-25.
Evidence is [the tools-off live results](../../evidence/acp-tools-off/results.md).
This plan covers slices 1 and 2 in one PR, as the task brief asks. Slices 3 and 4 stay for later PRs.

## Seams check

Every item below was read in the current tree before this plan was written.

- ACP profiles exist and only chat is built. The gate is in [capabilities.ts](../../../packages/acp/src/capabilities.ts), and the tool table is in [tool-table.ts](../../../packages/acp/src/tool-table.ts).
- The ACP client opens a session, sends the launch off-list, and counts tool calls it sees. It lives in [client.ts](../../../packages/acp/src/client.ts).
- The runner starts the adapter, prepares the agent home, and purges the chat scratch folder when the session stops. That code is in [acp-host.ts](../../../packages/cli-runner/src/acp-host.ts) and the home-preparation script beside it.
- Claude needs three session options to close its holes. The evidence doc proves each one, and the probe beside it shows the exact shape.
- Codex needs a launch-time config file in its home. The constrained Codex profile in the chat package already carries the same keys, and the evidence doc proves they drop the offered tools from 26 to 0.
- Meeting summaries today go through the constrained runner. The meeting runtime prepares one structured call, and the shared structured layer parses JSON and checks the shape. The meeting service then runs its own evidence validation and saves the result.
- API-key models use the web API adapter. That adapter has no tool access by construction, so Meeting summaries on an API-key model keep that route. Only subscription models move.

## Determinism boundary

The screen renders from the saved meeting record, never from model output. The model gets one job. It reads the bounded meeting evidence and returns one JSON object that matches the meeting output shape. Guidance stays under 150 words because the prompt already exists and does not grow in this work.

## Slice 1 - no-tools ACP profile

Add a profile named `no-tools` to the ACP package.

- The provider table gains a no-tools column. Claude and Codex are ready. Google and OpenCode are not ready, and the gate says why in plain words.
- The tool table gains a no-tools column. Every row is off, so the launch off-list for this profile is every known tool.
- The client refuses a tool server on this profile. It sends no tool server entry at all.
- For Claude, the client sends the three proven session options plus the full off-list.
- For Codex, the runner writes the proven config file into the per-call home before the adapter starts. The config turns off the shell, project files, history saving, the plan tool and the user-input tool, and the feature list from the evidence probe.
- Each call gets a fresh private home under its own session folder. The runner deletes that home, the working folder and any transcript folder when the session stops. The boot sweep reuses the same marker record, so a crashed runner leaves nothing behind.
- The proof runs after launch and before the caller trusts the answer. The client checks the Claude options it sent, checks that no tool server was attached, and fails the call if the agent announces any tool call during the prompt. For Codex the runner-side config is the launch proof, and the same zero-announced-tools check applies to the reply. A failed proof blocks the call with a clear error. It never falls back to a tool-capable route.

Tests state behaviour and why a broken build fails.

- A no-tools session sends the three Claude options. Removing any one option makes the test fail.
- A no-tools session sends no tool server, even when the caller tries to pass one.
- Google and OpenCode refuse the profile before anything spawns.
- The Codex config text contains every off switch. Dropping one switch makes the test fail.
- A scripted agent that announces a tool call makes the prompt fail. A silent agent passes.
- The runner spawn for this profile records a private home inside the session folder, and the stop path purges it.

## Slice 2 - Meeting summaries through the profile

Add a structured adapter in the chat package that runs one prompt through the no-tools profile and returns the raw text. Wire it where the constrained adapter is wired today, for subscription models only.

- The caller states the profile, never the provider. The existing model routing still picks the model and provider.
- The adapter opens one session per attempt, sets the model when the agent offers a model option, sends the meeting prompt, checks the zero-tools proof, and closes the session. The close deletes the private home through the runner stop path.
- It asks for JSON in the prompt it already receives. It does not force a shape at the protocol layer.
- The shared structured layer keeps parsing the JSON and checking the meeting shape. The meeting service keeps its evidence validation. One retry on a bad shape makes a second fresh call when the first reply is not usable JSON, fails the shape, or fails evidence validation, so a bad shape gets exactly one second try.
- The old constrained route stays in the tree for the conversation summary job and for slice 4 to retire. Meeting summaries no longer use it, so a new Claude or Codex build cannot break them through the old allowlist.
- The readiness probe for Meeting summaries stops asking the constrained runner. A subscription model is ready when the runner connection is ready and the provider row serves the no-tools profile. That keeps the Meeting screen honest without running a model call on every screen load, and a down runner reads as unavailable instead of available.

## App map

Meeting summaries keep the same screen, the same errors a user can act on, and the same recovery words. The route under the screen changes, and no user-facing behaviour changes. No app-map change is needed. The PR will say so plainly.

## Verification

Every command runs unpiped so the exit code survives.

```bash
pnpm vitest run packages/acp packages/chat/src/live/constrained-structured-adapter.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"
npx tsc --noEmit > /tmp/tsc.log 2>&1; echo "EXIT=$?"
npx eslint <files touched> --max-warnings=0 > /tmp/lint.log 2>&1; echo "EXIT=$?"
```

Expected exit code is 0 for each.

Each new guard test is run once with the guard removed, and the failure is recorded in the PR. A test that passes either way proves nothing.

Live proof runs on a real dev instance through the real Meeting screen. It covers a normal meeting summary and an imported recording. Codex proof with a real model waits for the usage reset on 2026-10-31, so the live proof uses the Claude subscription route and the PR says so.

## Kill gate

Slice 1 ships inside this PR, but the gate is named here. If the no-tools profile cannot prove zero announced tools on the real Claude route, slice 2 does not route Meeting summaries through it, and the PR stops at slice 1 with the finding recorded. Ben makes that call from the live proof.

## Out of scope

The update-system live check is slice 3. Retiring the constrained runner is slice 4. Chat behaviour, the Moss tool server, provider settings and transcription do not change.
