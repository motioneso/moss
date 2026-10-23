# chat.present and turn wiring (stage 1b.2)

Task: [#3591](https://github.com/motioneso/moss/issues/3591), part of
[#3583](https://github.com/motioneso/moss/issues/3583). Depends on draft
[PR #3590](https://github.com/motioneso/moss/pull/3590); base `feat/visual-chat-contracts`.
Approved scope: [handoff](../handoffs/2026-10-23-visual-chat-present-tool.md),
[spec](../specs/2026-10-23-visual-chat-replies.md),
[staged plan](2026-10-23-visual-chat-replies.md). Worktree: `~/Jarv1s/.claude/worktrees/visual-chat-present-tool`.

## Scope and seam evidence

Baseline `b43dc937c`. Internal implementation only; no production activation or app-map
capability claim. No persistence, DTO/history fields, reducers, renderer, module reads,
flags, engine acceptance campaign, or action/approval changes. Approval to build this
bounded task is in the handoff. This plan is committed before code.

| Assumed seam                            | Observed evidence and decision                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest tool discovery                 | `packages/ai/src/assistant-tools.ts:7` projects `assistantTools`; chat's declarations start at `packages/chat/src/manifest.ts:878`. Add a read tool requiring the internal presentation service.                                                                                                                                    |
| Read execution services                 | `packages/ai/src/gateway/gateway.ts:674` selects services; `packages/chat/src/gateway-services.ts:256` constructs read services. Add an optional collaborator, omitted by production routes, so the tool stays unavailable there.                                                                                                   |
| Captured actor/thread/session           | `packages/ai/src/gateway/gateway.ts:390` verifies the token before constructing `ToolContext`; SDK context at `packages/module-sdk/src/index.ts:119`. Capture optional turn ID from tokens before asynchronous preparation, never from arguments.                                                                                   |
| Active turn identity                    | `packages/chat/src/live/chat-session-turn.ts:102` creates the host turn ID, `:189` checks resolved privacy/thread; `:290` submits. Bind an internal registry after final thread checks and before submission.                                                                                                                       |
| Commit and cleanup                      | `packages/chat/src/live/chat-session-turn.ts:467` saves, `:499` checks stored result, `:540` enters finally. Close only on a stored result; discard on every other exit and release before asynchronous cleanup.                                                                                                                    |
| Runtime dependency injection            | `packages/chat/src/live/runtime.ts:548` declares optional collaborators and `:789` forwards lifecycle hooks into manager deps. Forward one optional presentation service through this existing factory.                                                                                                                             |
| Registry validation                     | `packages/chat/src/visual/turn-registry.ts:110` finalizes shape/ref ownership; semantic program/catalog validation is expressly absent. Trusted here means registry-owned snapshots, not renderer safety.                                                                                                                           |
| Claude print                            | `packages/chat/src/live/structured-claude-engine.ts:540` attaches MCP; manifest reads can use this existing path.                                                                                                                                                                                                                   |
| Claude/Codex interactive and persistent | `packages/chat/src/live/module-build-launch-commands.ts:91` and `:140` attach MCP; `packages/chat/src/live/persistent-runtime-engine.ts:97` forwards launch options to the configured runtime. No new engine transport.                                                                                                             |
| ACP                                     | `packages/chat/src/live/acp-chat-engine.ts:649` forwards the tool server to session creation. Configuration-specific execution remains unverified.                                                                                                                                                                                  |
| Missing engine seam                     | `packages/chat/src/live/structured-gemini-engine.ts:77` writes settings without MCP and `:179` writes only an empty native-tools allowlist. `packages/chat/src/live/constrained-structured-engine.ts:62` explicitly rejects MCP. Stop rollout work here; record on #3591. Owner: subsequent integration task/Ben for scope changes. |

The missing engine seam plus excluded semantic/persistence/rendering work means production
routes must not inject the new service. Keeping the implementation injectable allows an
assembled executable test without exposing a partial product capability. The alternative,
activating on only some production engines now, would need engine admission, product map,
and installed-dev acceptance beyond this slice. Do not silently add that scope.

## Decisions and files

1. `packages/chat/src/visual/presentation-service.ts`: own active turn bindings and pending
   finalization. `begin(sessionId, identity)` returns a turn handle with its registry,
   `registerUserData(fields, retrievedAt)`, `close()` and `discard()`. Presentation resolves
   only host context with actor/thread/turn identity matching the binding. One proposal
   attempt per turn; invalid input yields host prose, never an automatic retry.
2. User data enters through the host handle, never tool arguments. Label it `Your data`
   with origin `user`, bounded by the existing snapshot validator. The internal lifecycle
   can register the exact current user text (when within bounds); structured host-supplied
   fields prove a novel composition in tests. No extraction or invented source facts.
3. Host fallback is formatted from registered data with a bounded generic explanation on
   failure; never echo proposal/program text. The service returns a `FinalizeResult` to
   internal callers and retains accepted output for later integration. The tool returns
   only readable fallback/status, not a program or a claim that a visual rendered.
4. `packages/chat/src/visual/present-tool.ts`: manifest declaration/schema and execute adapter;
   `packages/chat/src/manifest.ts`: include declaration. Existing assistant catalog projects
   it without changes. Require `visualPresentation` in the read service map.
5. `packages/module-sdk/src/index.ts`, `packages/ai/src/gateway/gateway.ts`: optional host turn
   identity in context, captured at authenticated call arrival. No model identity input.
6. `packages/chat/src/live/chat-session-ports.ts`, `runtime.ts`, `chat-session-turn.ts`:
   optional service injection, one registry for the captured model turn, close after save,
   discard for cancellation/failure/undefined save. No shared/live response changes.
7. `packages/chat/src/gateway-services.ts`: optional collaborator for internal assembly;
   production routes intentionally omit it. No feature guidance in production persona.
8. `tests/visual-chat-present-tool.test.ts` and `tests/visual-chat-present-lifecycle.test.ts`:
   manifest/catalog, gateway context, user data, fallback and lifecycle execution.

The model has two jobs only: decide whether a visual helps and arrange approved components;
write concise interpretation. Host code owns snapshot facts, identity, fallback and status.
Added guidance stays under 150 words. This does not validate renderer syntax, authorize source
reads, or execute interactions. No writes, fetches, approvals or job payloads are added.

## Checks and kill gate

Tests execute the actual tool through manifest discovery and the gateway with an in-memory
runner, and the actual `runChatTurn` lifecycle with a deterministic engine. These are internal
assembled tests, not installed-dev UI or provider acceptance. Cover foreign actor/thread/turn,
missing context, delayed calls after turn replacement, closed/discarded use, malformed and
forged proposals, one attempt/no retry, no raw program in tool output, host user-data labeling,
successful save, rejected save, cancel and thrown submit/read/save. Test no production service
activation. Remove each claimed identity/lifetime/attempt/output guard, observe failure,
restore and rerun; record exact negative controls below.

Unpiped commands, expected exit 0 (negative controls expect nonzero):

- `pnpm exec vitest run tests/visual-chat-contracts.test.ts tests/visual-chat-turn-registry.test.ts tests/visual-chat-present-tool.test.ts tests/visual-chat-present-lifecycle.test.ts`
- `pnpm exec tsc --noEmit`
- `pnpm --filter @moss/chat typecheck`
- `pnpm --filter @moss/ai typecheck`
- `pnpm --filter @moss/module-sdk typecheck`
- `pnpm exec eslint <changed TypeScript paths> --max-warnings=0`
- `pnpm exec prettier --check <changed paths>`
- `pnpm check:file-size`

No database commands needed; any discovered need first requires verify-gate. Kill gate:
stop activation if engine/context seams are missing or semantic validation/lifecycle needs
excluded work. Implementer records evidence; Ben owns renderer/scope changes. Do not claim
stage 1 complete. Push a task-linked draft PR against the unmerged dependency, Category: N/A,
comment on #3591 and link from #3583. Do not merge, deploy or close either issue.

## Evidence and remaining work

Initial seam check: #3590 remains open/unmerged. Gemini and constrained paths lack the MCP
seam above; no attempt to add that transport here. Later tasks own production composition-root
activation, semantic catalog validation, persistence/live/history, UI, module normalization,
installed-dev lifecycle proof and the 20-prompt configured-engine gate.

### Implementation and negative controls

The synchronous authenticated context capture lives in
`packages/ai/src/gateway/tool-call-context.ts`; gateway preparation uses it before locale
lookup. Legacy injected token doubles without turn lookup produce no turn context; the
presentation service refuses those calls. The normal runtime factory forwards the optional
service, and production routes still omit it. Source-file limits remain intact.

`runChatTurn` registers bounded exact user text before submit. It listens for the host abort
signal and discards immediately on Stop, before engine interruption finishes. Finally releases
the binding before awaited live-turn settlement. Successful save closes it first; an undefined
save, submit/read/save failure, watchdog exit or cancellation discards it. The accepted envelope
is internal and is never added to recordTurn, live events or response DTOs.

Each control below ran the named focused Vitest assertions, exited **1**, and had its mutation
restored in a `finally` before further work. These test the named internal boundaries only;
they establish neither source-read authorization nor renderer safety.

| Removed protection                                                  |                                   Observed failed tests |
| ------------------------------------------------------------------- | ------------------------------------------------------: |
| Service actor/thread/turn comparisons                               |      4 (foreign actor, thread, turn and missing thread) |
| Host turn ID in captured tool context                               |              1 (registered tool through actual gateway) |
| Capture before awaited locale lookup (recaptured afterward instead) |                      1 (delayed call after replacement) |
| Single presentation-attempt guard                                   |                3 (invalid proposal then second attempt) |
| Service open-state check                                            |                      2 (close/discard refusal response) |
| Text-only handler output (included accepted raw reply instead)      |               1 (raw program/snapshot output assertion) |
| Close after successful save                                         |                          1 (successful lifecycle close) |
| Finally release/discard                                             | 4 (unsaved, save failure, submit failure, read failure) |
| Immediate host abort listener                                       |      1 (state already discarded at engine interruption) |

The discard control was rerun after adding immediate-abort disposal: cancellation now discards
through that independent path, while the other four exits still fail without finally cleanup.
The cancellation fixture records state before releasing the engine read, so it distinguishes
immediate disposal from eventual cleanup and does not rely on a timer.

### Restored final verification

All commands exited **0** on 2026-10-23:

- Frozen-lockfile install completed without changing the lockfile.
- The four focused Vitest files listed above: **90 tests passed**.
- Gateway regression run: **39 tests passed** across
  `tests/unit/gateway-read-tool.test.ts`, `gateway-action-origin-capture.test.ts`,
  `gateway-launch-replay-refusal.test.ts`, `chat-gateway-dependencies.test.ts` and
  `ai-gateway-audit-duration.test.ts` (all under `tests/unit/`).
- Root `pnpm exec tsc --noEmit`; owning `@moss/chat`, `@moss/ai` and
  `@moss/module-sdk` typechecks.
- Scoped ESLint on all 13 changed TypeScript files with `--max-warnings=0`;
  Prettier on those files and this plan; `pnpm check:file-size`; `git diff --check`.

No database/full foundation command, server, browser or installed-dev UI acceptance was run.
The optional presentation service remains absent from production routes. #3590 was checked
open/unmerged before delivery, so the draft targets `feat/visual-chat-contracts`.
Delivery links are posted on #3591 and #3583. Neither issue is closed; stage 1 remains incomplete.

### Independent review and CI follow-up

Ben authorized independent review and merge on 2026-10-23. Two read-only reviews inspected
`3b074f940`: Standards found no blockers; Spec found one P1. `chat.present` incorrectly used
the trusted-result exemption even though fallback text can carry supplied content. Changed
the declaration to `outside`, retaining the gateway's existing wrapping and provenance
admission. The tool adds no domain writes; gateway audit/provenance bookkeeping still applies.

The gateway fixture now supplies an in-memory provenance port. Tests assert admission with
captured actor/thread and `tool_external_content`, the `chat.present` source wrapper, and
withholding all supplied fallback/private error details after failed admission. Changing the
declaration back to `user_authored` made both new boundary assertions fail (exit **1**,
2 failed / 19 skipped); the declaration was restored. The six-file focused and content-policy
suite passed **167 tests** (exit **0**).

CI also exposed inherited formatting in the target-board HTML. Applied Prettier without
content edits; the standards reviewer independently confirmed the result equals Prettier's
output on the original file byte-for-byte. Both reviewers rechecked the fixes and found no
remaining blockers. Browser CI failures occurred during browser dependency installation:
slow package downloads timed out, followed by a package-manager lock failure; test execution
had not begun. Fresh CI must pass before merge.

Draft PR: [#3593](https://github.com/motioneso/moss/pull/3593). Its target remains
`feat/visual-chat-contracts` while #3590 is unmerged. Merging this slice into that dependency
branch does not complete stage 1 or authorize merging the parent PRs into `main`.
