# Deterministic scriptable UAT chat

**Date:** 2026-08-10

**Status:** Draft — implementation-ready

**Issue:** #1121

**Grounded on:** `origin/main` = `71149d36e`; issue #1121 and its corrections; the approved
`2026-07-12-dev-uat-harness.md`; every in-tree `#1121` UAT reference; the shipped real-token opt-in;
and Fable's binding #1557 run-and-record ruling (comment `5249826990`) for issue ownership only.

## Decision summary

Add one deterministic, repo-owned executable matching the bounded Anthropic adapter already used in
the shipped Compose/CLI-runner topology. The existing fallback launches it once per turn with
`claude -p`, and it uses the server-minted MCP token to call the real tool gateway. The only fake is
the model's choice of tool and final prose: an ordered fixture supplies both.

The executable is named `claude` because it speaks that adapter's documented print/transcript
protocol; that vendor detail stays inside `tests/uat/fixtures/`. Product UI, user-visible status,
assertions, and neutral runtime contracts continue to say _assistant_, _model_, or _provider_.

This is deliberately narrower than a generic fake-model framework. It adds no provider kind, no
production engine-selection branch, no REST mock, no credential, no dependency, and no prompt
interpreter.

## Why the earlier #1121 work is insufficient

PR #1225 shipped a safe, opt-in **real-token** route. It proves real provider authentication when a
human supplies a dedicated-account credential, but the default gate still skips it and real model
behavior remains slow and nondeterministic. The default seed correctly has no chat-capable model:
`seedAiProviderChunk` creates a `custom`, JSON-only model bound to `module.news`.

The remaining gap is therefore not another credential path. It is a deterministic child process
that can cross the same chat/process/MCP/tool/UI boundaries without an upstream provider.

## Locked boundaries

1. **Prod-shaped path stays real:** browser drawer → `/api/chat/turn` → model router →
   `ChatSessionManager` → CLI-runner → bounded `claude -p` child → `/api/mcp` → real gateway → real
   module handler/repository → real DB or `VaultContext` → transcript drain → SSE/UI.
2. **Fixture owns decisions only:** which tool to call, its fixture-declared arguments, and the final
   reply. It never writes DB/vault state directly and never calls product REST routes as a shortcut.
3. **Default behavior is unchanged:** no `chatScript` in a spec means no scripted chat provider,
   normal `/data/cli-tools`, and the existing credential-free seed. The existing regression that
   `selectChatModelForUser()` returns `null` remains green.
4. **Explicit opt-in:** only a repo-allowlisted `chatScript` identifier may select the fixture. An
   unknown/missing script, unexpected turn, ambiguous match, malformed fixture, MCP error, or reply
   mismatch fails the run. There is no fallback to a real executable or canned success.
5. **Secrets stay absent:** scripted runs create no token credential. The server-minted MCP bearer is
   read from the runtime-generated MCP config, used only in the Authorization header, and never
   logged, persisted in a fixture, placed in evidence, or returned to Playwright.
6. **Actor scope stays server-owned:** fixtures never contain actor/user IDs. Identity comes only
   from the minted MCP token. Existing RLS and `DataContextDb` boundaries remain authoritative.
7. **Approval policy stays real:** `tools/call` waits on the actual confirmation registry. A
   confirmation-required write must render the browser card and execute only after Playwright clicks
   Approve. Scripted mode gets no bypass.
8. **Provider-neutral product surface:** seed display names use `UAT Scripted Provider` /
   `UAT Scripted Chat Model`. Vendor names are limited to fixture path, adapter-specific unit tests,
   and operator diagnostics, as #1554 requires.
9. **No #1557 dependency:** this harness issue neither gates nor proves #1557. It does not change
   persistent runtime selection, provide #1557 live-path evidence, or redefine #1557's
   baseline-identical run-and-record gate.
10. **Scripted transport is pinned:** every scripted run writes
    `chat.persistent_runtime.enabled = false` for its ephemeral instance and accepts only the
    bounded one-shot print launch. The fixture requires `-p` plus exactly one session flag; a
    different engine shape fails immediately with `scripted UAT requires bounded one-shot print`,
    not with a later empty-reply timeout. Supporting scripted persistent sessions is a separate
    follow-up.

## Minimal implementation

### 1. Ordered fixture contract

Add `tests/uat/fixtures/chat-scripts/*.json`. A fixture is versioned and contains ordered turns:

```json
{
  "version": 1,
  "turns": [
    {
      "expectIncludes": ["Follow the Yankees"],
      "calls": [
        {
          "tool": "sports.followTeam",
          "arguments": { "competitionKey": "mlb", "teamKey": "nyy" }
        }
      ],
      "reply": "You're following the Yankees."
    }
  ]
}
```

The engine consumes exactly one step per submitted user frame. Every `expectIncludes` value must
occur; zero or multiple eligible next steps fail. There is no regex dispatch or fuzzy/natural-
language matching. Dynamic values use a small closed capture set, initially only:

- `firstAttachmentId` from the server-composed `<attachments>` manifest;
- named values from a prior MCP result via an explicit JSON pointer.

Arguments may substitute `${captureName}` strings recursively. Unknown captures, invalid JSON
pointers, extra turns, or EOF before all expected turns fail. Do not add loops, conditionals, sleeps,
JavaScript snippets, shell commands, arbitrary URLs, or fixture inheritance.

Each call declares its exact tool name/arguments and optional result assertions. The executable
checks that the tool appeared in `tools/list`, calls it through MCP, and validates the JSON-RPC
response before emitting the fixture reply. This is the check that prevents a canned answer from
passing when the real read/write failed.

### 2. Fixture executable

Add an executable Node script at `tests/uat/fixtures/scripted-provider/bin/claude`; the existing
Docker build already copies the full repository, so no Dockerfile stage or dependency is needed.
It accepts the complete `ClaudePrintChatEngine.buildCommand` launch shape:

- `-p` and exactly one of `--session-id <id>` on the first turn or `--resume <id>` thereafter;
- `--permission-mode dontAsk`;
- on the MCP path, `--mcp-config <path>`, `--settings <path>`, and
  `--allowedTools <space-separated-patterns>`; or, on the no-MCP path, `--tools ""`;
- `--append-system-prompt-file <path>` and `--strict-mcp-config`;
- optional `--model <name>`; and
- the prompt as the final positional argument.

It validates and uses the mode, session, MCP config, allowed-tool patterns, and prompt. It accepts
but otherwise ignores the permission mode, settings path, system-prompt path, strict-config flag,
and optional model after validating their arity and fixed values. The no-MCP shape parses, then
fails closed because a scripted turn cannot prove the real gateway without `--mcp-config`.

The same binary may be reached through `buildStructuredCommand`, whose full distinguishing shape is
`--print --input-format stream-json --output-format stream-json --include-partial-messages
--verbose --no-session-persistence --permission-mode dontAsk --tools "" --strict-mcp-config
--json-schema <json> --append-system-prompt-file <path>` plus optional `--model`. The fixture
recognizes that shape only to reject it: any stream-JSON/structured invocation exits non-zero with
the bounded-engine diagnostic and appends no transcript reply.

For each valid bounded invocation it:

1. loads that session's fixture cursor from a fixture-owned state file under the neutral working
   directory and rejects a missing/mismatched transition;
2. locks the state file to mode `0600` before storing only the script id, turn index, and declared
   captures—never prompt text, MCP config, bearer, arbitrary tool results, or attachment content;
3. performs the declared real MCP list/call/result checks; and
4. appends minimal adapter-valid `assistant` tool-activity and `assistant`/`end_turn` reply records
   to
   `transcriptGlobDir("anthropic", cwd, JARVIS_CLI_HOME_BASE)/<sessionId>.jsonl`, then exits.

The transcript path must be obtained from the same `@moss/ai` helper the real reader uses; do not
copy its path-encoding algorithm. Appends are newline-terminated and complete before exit so the
existing drain sees tool activity and the fixed final reply. A resumed turn advances the cursor
across processes but does not pretend the PID is stable.

For a tool step, the executable:

1. reads the runtime-generated MCP URL/bearer from `--mcp-config`;
2. requires the URL to be the in-stack `/api/mcp` endpoint;
3. calls `tools/list` and requires the fixture-declared bare tool to appear;
4. derives the same CLI-visible name as the production MCP transport (for example,
   `calendar.listVisibleEvents` → `mcp__jarvis__calendar_listVisibleEvents`) and requires it to match
   at least one command-line `--allowedTools` pattern;
5. calls `tools/call` with the fixture arguments;
6. waits for the real call to finish (including browser approval when required);
7. records tool-use metadata and the fixed assistant reply, then returns success.

The allowed-tool matcher supports the exact and trailing-`*` prefix forms emitted by the production
launcher; it does not turn patterns into arbitrary regular expressions. Native vault patterns such
as `Read(<root>/**)` cannot authorize an MCP call. An undeclared or out-of-pattern tool fails before
`tools/call`, even if the MCP token itself would permit it.

On failure it exits non-zero without appending a successful final reply. Stderr may identify only
script id, turn index, and failure class—never prompt text, MCP config, token, tool
arguments/results, attachment content, captures, or reply content.

### 3. Harness and seed wiring

Extend `readUatLevel`'s existing single anchored regex—do not add a second parser—to accept one
optional string-valued `chatScript: "<id>"` after the existing optional
`withoutNewsJsonBinding` and `withJobSearchFixture` fields. The literal order accepted by the
extended regex is:

```ts
export const uatLevel = {
  level: "solo-admin",
  without: [],
  withoutNewsJsonBinding: false,
  withJobSearchFixture: false,
  chatScript: "runtime-context"
} as const;
```

The parsed value threads through one typed path:
`readUatLevel` →
`provisionForUat(level, { excludeChunks, withoutNewsJsonBinding, withJobSearchFixture, chatScript })`
→ optional `UatProvisionOptions.chatScript`. Use one allowlist shared by `run-uat.ts` validation and
the seed/provisioner tests. Do not accept an arbitrary path. When present:

- the provisioner writes the allowlisted id to the ephemeral run env;
- the ephemeral seed/config explicitly writes `chat.persistent_runtime.enabled = false` rather than
  inheriting a current or future default;
- Compose maps the existing `JARVIS_CLI_TOOLS_PREFIX` to
  `/app/tests/uat/fixtures/scripted-provider` for that run only (the production default remains
  `/data/cli-tools`);
- the seed creates one active `anthropic`-kind provider configured for `non_interactive` execution
  with the neutral display name above and one active `chat`-capable model; its encrypted credential
  payload is the existing non-secret `{ cli: true }` UAT marker, never a provider credential;
- the existing #1025 JSON-only News provider/binding remains unchanged when its chunk is requested.

The seed entrypoint's `JARVIS_UAT_SEED_CONFIRM=1` plus `assertTargetIsEphemeral()` guard must run
before this provider or setting is written. A normal production compose start cannot select the
fixture, and the `seed` profile remains inert outside an explicit UAT run.

No general `scripted` provider kind is added to shared API/DB types. The router sees a normal
chat-capable configured model; only the executable found on this ephemeral run's PATH is synthetic.
The first fixture invocation is also the live engine-shape assertion: it must contain `-p` and the
session flag. Stream JSON or any other launch form fails immediately with the locked-boundary-10
diagnostic, so an engine-selection change cannot silently degrade scripted coverage.

### 4. Keep real-provider proof separate

The existing GPG-encrypted dedicated-account token flow and
`real-chat-onboarding.uat.spec.ts` stay intact. That conditional live-provider proof exercises
authentication, discovery, and upstream inference when an operator supplies the dedicated-account
credential; scripted cases prove different boundaries and do not replace it or change its default
skip behavior.

## Acceptance mapping

Every active scripted case asserts the final reply **and** the real tool result/effect. Fixed prose
alone is insufficient.

| Surface                                        | Scripted behavior and proof                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-map-grounding.uat.spec.ts`                | Restore the three #1110 deferrals: News prerequisite remediation calls `chat.getCurrentView` + `app.getMapSlice` and links Assistant & AI settings; known-unanswerable calls the map and declines without inventing a surface; transient error calls the same reads and names it as transient, not configuration. The non-admin case becomes load-bearing and proves no admin-only text is returned. |
| `runtime-context.uat.spec.ts`                  | Replace both fixmes: screenshot request returns the fixed safe refusal with no screenshot tool call; News screen question calls `chat.getCurrentView` + `app.getMapSlice`, then returns the declared JSON-capable-model remediation/link. Existing real turn-body and manifest checks remain.                                                                                                        |
| `1133-chat-attachments.uat.spec.ts`            | Capture the uploaded attachment id from the real manifest, call `chat.readAttachment`, require the MCP result to contain `attachment uat proof body`, then answer with that content. Existing upload/type gates remain.                                                                                                                                                                              |
| `1264-settings-self-operation.uat.spec.ts`     | Ordered turns call the exact settings tools for theme, quiet hours, weather, notifications, and `settings.undoLast`; UI/API state proves each effect, the notification reply names its consequence, persona change makes no call, and `.action-request-card` remains absent throughout.                                                                                                              |
| `self-operation-content-commands.uat.spec.ts`  | Call real News add-topic and Sports follow/unfollow tools with manifest-valid catalog inputs; assert DB-backed UI/API effects and no card.                                                                                                                                                                                                                                                           |
| `1311-install-grant.uat.spec.ts`               | Call a real `task_changes` tool from the default-enabled Tasks module before any explicit enable action; assert the effect and no card.                                                                                                                                                                                                                                                              |
| `scripted-chat-confirmation.uat.spec.ts` (new) | Create a temporary task list, call the real confirmation-required `tasks.deleteList`, prove no mutation before the browser action card is approved, then prove deletion afterward.                                                                                                                                                                                                                   |

### Relationship to #1557 and the drawer-private UAT

Fable's binding ruling in issue #1557 comment `5249826990` makes #1121 explicitly independent of
#1557. That runtime change owns a baseline-identical run-and-record gate at its submitted head, not
a zero-skip gate, and it gets its persistent-runtime proof from separate real-provider live-path
evidence. This spec does not unblock, gate, or supply evidence for #1557.

Both tests in `1089-1090-chat-drawer-private.uat.spec.ts` remain intentionally `test.fixme` under
that ruling. In particular, #1089 needs injected response ordering that the prod-shaped UAT harness
deliberately excludes; its canonical deterministic proof remains
`tests/e2e/chat-drawer.spec.ts`. #1121 adds no latency injection and does not alter that file's skip
accounting. `real-chat-onboarding.uat.spec.ts`, `cli-terminal.uat.spec.ts`, and
`module-install.uat.spec.ts` are likewise outside this implementation's edit set.

## Automated checks

Smallest checks required before the prod-shaped UAT run:

1. Fixture unit tests: three bounded invocations preserve one session cursor and append parseable
   transcript records; every value-taking print flag is consumed correctly; structured stream JSON,
   no-MCP mode, mismatch/unknown script/malformed fixture/tool error fail closed; capture
   substitution works; no secret or prompt reaches stderr.
2. MCP fixture integration test: real `tools/list` + read call succeeds; confirmation-required write
   remains pending until registry approval and does not mutate before approval. An undeclared tool
   and a declared tool outside the parsed `--allowedTools` patterns both fail before `tools/call`.
3. Seed tests: default seed still resolves no chat model; scripted seed resolves the neutral active
   chat model and pins `chat.persistent_runtime.enabled` false; News JSON binding remains its
   existing separate model.
4. Harness/config tests: allowlisted id threads to the ephemeral env/PATH; arbitrary ids/paths fail;
   the anchored `readUatLevel` regex accepts `chatScript` only in the declared order and threads it
   through `UatProvisionOptions`; normal compose/default run retains `/data/cli-tools` and no
   scripted model/setting.
5. Engine-selection regression: the scripted provider tuple (`anthropic`, `non_interactive`,
   persistent runtime off) selects the bounded one-shot `ClaudePrintChatEngine`, and the fixture's
   launch-shape assertion reports a clear failure for any structured/persistent selection.
6. UAT result checks parse Playwright's result rather than trusting exit 0 alone. Each converted
   #1121 case must be runnable and pass; unrelated intentional skips are neither removed nor counted
   as #1121 failures.

Run DB-backed checks only through the repository's verify-gate procedure. The implementation PR also
needs the normal lint/format/type/file-size checks and the live-path evidence required by
`docs/DEVELOPMENT_STANDARDS.md`. Evidence contains scenario ids, test names, and exit codes only—no
prompts, replies, attachment contents, tool payloads, or credentials.

## Rollout and rollback

This is test infrastructure, not a production feature flag.

- Land the bounded fixture and harness wiring from `main`; there is no #1557 ordering dependency.
- Convert only the mapped #1121 scenarios, incrementally, while their targeted UAT cases stay green.
  A script mismatch is a hard failure, never a reason to reintroduce `fixme`.
- Rollback is removing `chatScript` from a spec/run. That returns the harness to its credential-free,
  no-chat default without changing production configuration or data.
- Keep the real-token opt-in until it is separately retired; it proves a different boundary.

## Non-goals

- Proving that any real model follows instructions, chooses the same tool, or emits the same prose.
- Provider authentication, model discovery, billing, latency, token use, or upstream availability.
- Generic model simulation, prompt parsing, fixture branching/loops, record/replay, snapshots of real
  provider output, or a provider parity framework.
- Mocking REST, repositories, the MCP gateway, confirmation registry, RLS, vault, or module handlers.
- Changing either intentionally-fixme'd drawer-private UAT case or solving #1089 with latency
  injection.
- Proving, gating, or changing #1557's persistent runtime or its real-provider live-path evidence.
- Changing production product vocabulary, provider selection, API contracts, or UI.

## Exit criteria

1. The default seed still has no usable chat engine and uses no credential/network upstream.
2. An allowlisted Compose scripted run completes drawer → bounded child/transcript → MCP → real
   read/write → UI, with unexpected input failing closed.
3. The mapped #1121-owned fixmes are active passing assertions, and the deferred app-map chat
   scenarios have deterministic prod-shaped coverage.
4. The confirmation-required write does not mutate before browser approval and does mutate after it.
5. The drawer-private UAT and live-provider onboarding proof retain their existing behavior and skip
   accounting; no #1557 gate or evidence claim depends on this work.
6. No secret/private content appears in logs or evidence, and the production/default compose path is
   byte-for-byte behaviorally unchanged.
