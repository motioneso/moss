# Plan — #2028 Gemini as a real chat provider

Spec: `docs/specs/2028.md` on this branch (same text as the `SPEC` comment on issue #2028).
Issue: #2028. Risk tier: security. Branch: `fleet/lane-2028`.

## What this is, in one paragraph

The product already installs Google's Gemini command-line tool and signs a founder into it. What it
does not do is talk to it. Every piece of the Google chat path was written against a different
Google tool (Antigravity, command `agy`), so the command name and most flags do not exist on the
tool that actually gets installed. This plan replaces that path with one written against the pinned
tool, and turns Gemini on as a selectable chat provider.

## Ground truth (measured, not assumed)

I installed the exact pinned package (`@google/gemini-cli` at 0.57.0) into `/tmp/gemini-scratch`
and ran it. Everything below is from that run or from the package's own source, not from memory.

### The real launch line

Confirmed against `gemini --help` on the pinned version:

| What the code uses today         | What the pinned tool has                                  |
| -------------------------------- | --------------------------------------------------------- |
| command `agy`                    | command `gemini`                                          |
| `--print`                        | `-p, --prompt <text>`                                     |
| `--conversation <uuid>`          | `--session-id <uuid>` first turn, `--resume <uuid>` after |
| `--log-file <path>`              | nothing — use `-o stream-json` on standard output         |
| `--dangerously-skip-permissions` | `--approval-mode default\|auto_edit\|yolo\|plan`, or `-y` |
| `--mode accept-edits`            | `--approval-mode auto_edit`                               |

`--resume` accepts `latest`, a full UUID, or a 1-based index — the UUID form is what we need, and
it is real (`chunk-GPOBVDAD.js:10112`, `findSession` matches on `session.id`). The tool refuses to
start if both `--session-id` and `--resume` are passed, so they are either/or, exactly like the
Claude one-shot engine at `packages/chat/src/live/claude-print-chat-engine.ts:254`.

### The real output shape

One JSON object per line on standard output. Measured from a live run
(`/tmp/gemini-run2.out`), event names and fields confirmed in `gemini-PSRJNVY5.js:10858` onward:

```
{"type":"init","timestamp":"...","session_id":"<the id we passed>","model":"auto"}
{"type":"message","timestamp":"...","role":"user","content":"say hi"}
{"type":"message","timestamp":"...","role":"assistant","content":"<chunk>","delta":true}
{"type":"tool_use","timestamp":"...","tool_name":"...","tool_id":"...","parameters":{...}}
{"type":"tool_result","timestamp":"...","tool_id":"...","status":"success","output":"..."}
{"type":"error","timestamp":"...","severity":"error","message":"..."}
{"type":"result","timestamp":"...","status":"success|error","stats":{...},"error":{...}}
```

**The reply arrives in pieces.** Assistant `message` events carry `delta: true` and one chunk of
text each; the full answer is every chunk joined in order. A parser that takes the first chunk as
the answer returns one word. The turn is finished when the `result` event arrives.

### Three traps the spec did not know about

These came out of running the tool and each one would have shipped a broken feature.

1. **A throwaway folder is not trusted, and that silently cancels the approval mode.** The measured
   run printed `Approval mode overridden to "default" because the current folder is not trusted`.
   Every chat session runs in a fresh folder, so this would fire every time and any tool call would
   sit waiting for an approval nobody can give. `--skip-trust` fixes it and is the flag the tool
   provides for exactly this.

2. **The tool writes crash reports containing the founder's prompt into the system temp folder.**
   `reportError` in `chunk-DFPYJMVX.js:307855` defaults its output folder to the operating system
   temp folder. I confirmed the file it wrote contains the prompt text verbatim. That is private
   conversation content landing outside anything we clean up. Setting `TMPDIR` to the session's own
   folder on the launch line puts those reports inside the folder we already delete.

3. **Saving a conversation to disk happens in headless mode too.** After one headless run the tool
   had created `~/.gemini/tmp/<short id>/`, `~/.gemini/history/<short id>/`, an entry in
   `~/.gemini/projects.json`, and stray `projects.json.<uuid>.tmp` files beside it. So continuing a
   conversation works, and so does leaving private content behind if we do not clean all of it.

### Where a conversation really lives

Confirmed against the real `~/.gemini/projects.json` on this machine:

```json
{ "projects": { "/absolute/folder/path": "<short id>" } }
```

The short id is the folder's last name, lower-cased, non-letter/digit characters turned into
dashes, with `-1`, `-2` appended when two folders would collide. Because collisions are resolved by
a counter, the id **cannot be computed** — it has to be read out of that file. The folders are
`~/.gemini/tmp/<short id>` and `~/.gemini/history/<short id>`.

`transcriptGlobDir` at `packages/ai/src/adapters/tmux-bridge.ts:120` computes it as
`basename(cwd).toLowerCase()`, which is right only when there is no collision and no punctuation.

### The saved chat file is not the format the reader expects

Measured content of a saved chat file: a header line
(`{"sessionId":...,"projectHash":...,"kind":"main"}`) followed by change lines shaped
`{"$set":{...}}`. The reader's Gemini mapping at
`packages/ai/src/adapters/transcript-reader.ts:330` expects lines with `type: "gemini"`, `content`
and `thoughts`. Those never appear. This is the second reason to read the reply from standard
output instead of from the tool's own file, and it is why the existing mapping is being replaced
rather than adjusted.

## Decisions

**D1 — read the reply from standard output.** Run the turn with `-o stream-json` and redirect both
output streams into a file inside the session's own folder, then parse that file. The alternative,
reading the tool's own chat file, needs the short id out of a registry we would have to parse and
race, and that file is a change log rather than a transcript. The redirect file is deterministic
and is already inside the folder the session deletes.

**D2 — continuing a conversation.** Generate a UUID at launch. First turn passes
`--session-id <uuid>`, every later turn passes `--resume <uuid>`. Never both. This mirrors the
Claude one-shot engine exactly.

**D3 — approval mode. This is the security-shaped call and it goes on the pull request.**
The session settings file the code writes today sets `security.disableYoloMode: true`, and the
pinned tool treats that as a hard refusal: asked for automatic approval it will not start at all.
A headless turn has nobody to answer an approval prompt, so leaving it on means any tool call
either stalls or kills the turn.

Chosen: **drop that setting and launch with `--approval-mode yolo --skip-trust`**, while keeping
`tools: { core: [] }` in the session settings so the tool has no built-in tools to run in the first
place. Two independent guards: nothing to approve, and nothing that could stall if something did
appear. The turn runs in a throwaway folder that is deleted afterwards.

Rejected: `--approval-mode auto_edit` with the setting left on. It still prompts for shell
commands, so it does not remove the stall; and with the setting on the tool refuses automatic
approval anyway, so the combination does not even start. It is the stricter-looking option that
delivers less safety, because the guard that actually matters here is having no tools at all.

This matches what the other two providers already do: Claude launches `--permission-mode dontAsk`
(`claude-print-chat-engine.ts:261`) and Codex launches `-a never` with `approval_policy="never"`
(`cli-launch-commands.ts:157`).

**D4 — Gemini chat has no Jarv1s tools in this change.** The one-shot Gemini engine does not wire
the Jarv1s tool server today and this change does not add it. The issue's bar is an ordinary
conversation, and adding a tool bridge is its own piece of work with its own approval questions.
Stated plainly on the pull request rather than left to be discovered.

**D5 — the persistent-session path is fixed but not claimed as proven.** New provider rows default
to the one-shot mode (`packages/ai/src/repository.ts:391`) and the engine picker sends one-shot
Google sessions to the one-shot engine (`engine-selection.ts:89`), so one-shot is the live path.
The persistent path's launch line still names `agy`; it gets the real command and real flags so it
no longer names something nothing installs, plus a comment saying it has not been exercised
against the pinned tool. Making it fully work needs the saved-chat-file reader rewritten, which is
separate work.

## Determinism boundary

Nothing here is model-authored. The reply text is rendered from the parsed record; readiness,
errors and cleanup outcomes are decided by exit codes and file checks, never by anything the model
says. No prompt guidance is added by this change.

## Seams — every capability this plan leans on, cited

| Assumed                                                | Cited                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Google is installable, pinned and checksummed          | `packages/cli-runner/src/catalog.ts:151`                                    |
| Google has a sign-in adapter                           | `packages/cli-runner/src/login-adapters.ts` (`google` entry)                |
| Readiness already runs the real `gemini --prompt`      | `packages/chat/src/live/provider-probe.ts:81`                               |
| `gemini` already accepted as an installed-command name | `packages/ai/src/cli-availability.ts:33`                                    |
| Settings already offers Google in the provider list    | `apps/web/src/settings/settings-ai-admin-pane.tsx:69`                       |
| New provider rows default to one-shot                  | `packages/ai/src/repository.ts:391`                                         |
| One-shot Google sessions reach the one-shot engine     | `packages/chat/src/live/engine-selection.ts:89`                             |
| Model names inferred for Google, tier included         | `packages/ai/src/model-discovery.ts` (`inferModel`, `inferTierFromModelId`) |
| Auto-register is data-driven per provider              | `packages/ai/src/auto-register.ts:55`                                       |

Open question, owner Ben: **there is no signed-in Google account on this machine.**
`~/.gemini/google_accounts.json` reads `"active": null` and there are no stored credentials. The
live proof needs a real browser sign-in with a real Google account, which an agent cannot do. See
"Live proof" below.

## Tasks

Each task commits green on its own. Test names are behaviour, not implementation.

### Task 1 — the launch line (write this test first)

`packages/chat/src/live/gemini-print-chat-engine.ts` (renamed from `agy-print-chat-engine.ts`),
class `GeminiPrintChatEngine` (renamed from `AgyPrintChatEngine`). Update the imports in
`packages/chat/src/live/engine-selection.ts`, `tests/unit/cli-runner-execution-mode.test.ts`,
`tests/unit/cli-runner-server.test.ts`.

Signatures kept as they are (the interface `CliChatEngine` does not change):

```ts
export interface GeminiPrintChatEngineOpts {
  readonly mux?: Multiplexer;
  readonly homeBase?: string;
  readonly sessionId?: string;
}
export class GeminiPrintChatEngine implements CliChatEngine {
  /* provider = "google" */
}
```

Tests, in `tests/unit/gemini-print-chat-engine.test.ts`:

- First turn's command contains `gemini`, `-p`, `--session-id <uuid>`, `-o stream-json`,
  `--approval-mode yolo`, `--skip-trust`, and sets `TMPDIR` to the session folder.
  _Fails against today's code because the command says `agy --print --conversation`._
- Second turn's command contains `--resume <the same uuid>` and does **not** contain
  `--session-id`. _Fails if someone passes both, which the tool refuses to start on._
- No command built anywhere under `packages/` begins with `agy`. A grep-style guard test.
  _This is the test that catches the whole class of bug; it fails today in five places._

### Task 2 — reading the reply

`packages/ai/src/adapters/transcript-reader.ts`: replace `mapAgyPrintRecord` and the Gemini part of
`mapGeminiRecord` with a mapper for the streamed shape above, and replace the format note at
line 49. Keep the exported signature of `parseTranscript` unchanged.

Tests, in `tests/unit/transcript-reader-gemini.test.ts`, using a recorded sample of real output
(`tests/fixtures/gemini-stream-json-sample.jsonl`, taken from the live run, not invented):

- Several assistant chunks join into one reply in order. _Fails if a parser returns only the first
  chunk — the most likely wrong implementation._
- The turn is not reported finished until the `result` event arrives.
- A `result` with `status: "error"` finishes the turn and surfaces the message rather than hanging.
- `tool_use` and `tool_result` become activity lines, not part of the reply text.

### Task 3 — cleaning up after a conversation

`packages/chat/src/live/private-transcript-cleanup.ts`: replace the Antigravity conversation-id
capture and folder purge with a purge keyed on the session's working folder.

```ts
export async function readGeminiShortId(
  io: Pick<TmuxIo, "readFile">,
  workingDir: string,
  homeBase?: string
): Promise<string | null>;

export async function purgeGeminiConversation(
  io: Pick<TmuxIo, "readFile" | "writeFile" | "run">,
  workingDir: string,
  homeBase?: string
): Promise<boolean>;
```

It removes `~/.gemini/tmp/<short id>`, `~/.gemini/history/<short id>`, the working folder's entry
in `~/.gemini/projects.json`, and any `projects.json.*.tmp` left beside it. Following the rule
already in that file, a purge that cannot confirm it removed everything throws rather than
reporting success.

Tests in `tests/unit/private-transcript-cleanup.test.ts`:

- All three locations are removed. _Fails if only the chats folder is removed, which is what the
  current code's shape would tempt._
- The registry entry for a **different** folder is left alone.
- A removal that fails makes the purge report failure, never success.

### Task 4 — the remaining wrong command names

- `packages/ai/src/adapters/tmux-bridge.ts`: drop `agyPrintTranscriptRoot`; point the Google
  transcript folder at `~/.gemini/tmp` and read the short id from the registry rather than
  computing it from the folder name.
- `packages/module-registry/src/chat-multiplexer.ts:286`: replace `agy auth status` with the same
  one-shot readiness check `provider-probe.ts:81` already uses. Test:
  `tests/unit/chat-multiplexer-provider-check.test.ts` asserts the command run is `gemini`.
- `packages/ai/src/cli-availability.ts:23`: make `gemini` the primary command name for Google,
  keeping `agy` accepted as an alternative so an existing declared host tool still resolves.
- `packages/chat/src/live/cli-launch-commands.ts`: real command and flags in `buildGeminiCommand`;
  drop `security.disableYoloMode` from `writeGeminiSettings` per D3; comment per D5.

### Task 5 — turn Gemini on

- `packages/ai/src/auto-register.ts:77`: replace the note with a `google` entry beside Claude and
  Codex, using the same "let the tool pick its own model" placeholder, display names
  `Gemini (default model)` and `Gemini`, tier `interactive`, capability `chat`.
- `packages/ai/src/model-discovery.ts:48`: add the Google list and update the note. Names read out
  of the pinned tool's own user-facing model table (`chunk-DFPYJMVX.js:363530` onward), not from
  memory: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`,
  `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`.
- Update any test asserting Google is absent from either list.

## Verification

Never piped, exit code stated.

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"        # expect 0
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"               # expect 0
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"            # expect 0
```

Full gate through the `verify-gate` skill only — it touches the database and an unscoped run hits
the live dev database.

```bash
pnpm verify:foundation > /tmp/vf.log 2>&1; echo "EXIT=$?"    # expect 0, via verify-gate
```

## Live proof

The bar for this issue, on the dev instance at `http://192.168.50.36:5173` (never port 1533, which
is production):

1. Install the Gemini tool from Settings and sign in with a real Google account.
2. Confirm Gemini appears as a pickable chat model without anyone adding it by hand.
3. Hold a two-turn conversation where the second turn shows the model remembered the first.
4. End the session and confirm on disk that both folders and the registry entry are gone.
5. Put pictures of steps 2 and 3 and the terminal output of step 4 on the pull request.

**Known obstacle.** Step 1 needs a real Google account signed in through a browser, and this
machine currently has none. If it cannot be done, the honest status is code-complete, unverified,
said plainly on the pull request — not "done".

## Kill gate

After Task 2, run one real turn end to end. If the reply cannot be read back from standard output —
for example the tool buffers nothing until exit, or the pieces cannot be joined into the answer a
person actually sees — stop and report rather than continuing to Tasks 3 to 5. Owner: Ben, through
the lane record.

## Release note

Category: Added. Title: Chat with Google's Gemini. Description: You can now sign in to Google's
Gemini and choose it for chat, alongside Claude and Codex.
