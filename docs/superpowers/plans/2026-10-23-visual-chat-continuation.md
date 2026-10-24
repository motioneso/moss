# Visual chat host integration (stage 1b.3)

Task: [#3600](https://github.com/motioneso/moss/issues/3600), part of
[#3583](https://github.com/motioneso/moss/issues/3583).
Authority: [continuation handoff](../handoffs/2026-10-23-visual-chat-continuation.md),
[approved spec](../specs/2026-10-23-visual-chat-replies.md) and
[staged plan](2026-10-23-visual-chat-replies.md). Work stays in
`~/Jarv1s/.claude/worktrees/visual-chat-continuation`.

## Boundary and current evidence

Baseline: `3dd26e111`. Parent PRs #3585, #3590 and #3593 are merged; live task
#3583 still leaves stage 1b open. No newer host integration PR was found.

| Capability                           | Current evidence                                                                                                 | Decision                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Captured turn and snapshot lifecycle | `packages/chat/src/live/chat-session-turn.ts:102`, `:287`; `packages/chat/src/visual/presentation-service.ts:21` | Retain existing identity/abort guards. Register exact supplied data and append dynamic catalog/ref context to the submitted turn, never to the cached persona.           |
| Authenticated tool service           | `packages/chat/src/routes.ts:341`, `:474`; `packages/chat/src/gateway-services.ts:270`                           | Share one presentation service between production gateway and lifecycle. No new transport or source authority.                                                           |
| Registry trust is shape-only         | `packages/chat/src/visual/turn-registry.ts:110`; `packages/shared/src/visual-chat.ts:1`                          | Add a production-owned shared semantic validator before proposal acceptance, before save, and before render.                                                             |
| Atomic message metadata              | `packages/chat/src/live/persistence.ts:540`, `:596`; `packages/chat/src/repository.ts:567`, `:747`               | Add versioned metadata through the existing completed-turn options. No migration or separate store.                                                                      |
| Live completion after save           | `packages/chat/src/live/chat-session-turn.ts:479`, `:530`                                                        | Publish a complete visual only with the stored reply identity; never trust visual fields from engine records.                                                            |
| History serializer and schemas       | `packages/chat/src/route-serializers.ts:55`; `packages/shared/src/chat-api.ts:91`, `:205`                        | Explicitly validate/read metadata and update actual response schemas plus server live contract. Preserve bounded fallback for unknown versions.                          |
| Stream identity                      | `apps/web/src/chat/stream-record-identity.ts:14`                                                                 | Existing turn/message convergence is canonical; carry visual metadata through history and HTTP completion too.                                                           |
| Shared drawer reply                  | `apps/web/src/chat/message-row.tsx:132`                                                                          | Add an adjacent lazy slot with Suspense/error boundary, plain fallback and accessible copy text. Meeting and other text-only surfaces stay on their existing path.       |
| Pinned runtime/loading               | `spikes/visual-chat-runtime/runtime-entry.ts:5`, `guard.ts:10` and stage-1a evidence                             | Build production-owned adapter and restriction; no production import from spikes. Preserve inspected bootstrap removal. Measure the actual app build.                    |
| Engine transport gaps                | `packages/chat/src/live/structured-gemini-engine.ts:77`; `constrained-structured-engine.ts:62`                   | MCP-capable configured routes are evaluation candidates; unsupported routes retain prose. Do not claim those gaps fixed or full stage 1 complete without route evidence. |

## Implementation decisions and order

1. Shared `visual-chat-catalog.ts`: catalog version, restricted Reply/Section/Fact grammar,
   scalar snapshot binding and resource limits. The grammar consumes the complete input;
   no expressions, HTML, URLs, state, queries, mutations or event handlers. A Fact names an
   opaque snapshot ref and an own field; values always come from the snapshot. Keep the
   catalog to at most three sections/three facts for this first composition.
2. `packages/chat/src/visual/`: accept one proposal attempt, semantically validate it and
   generate fallback from the registered user data. The host accepts bounded exact text or
   a user-pasted JSON object (including a fenced object); no model-extracted values. Label
   every snapshot Your data, not independently verified. Unsupported data stays prose.
3. Wire the production service and current-turn catalog/ref context. Validate before save;
   discard on Stop, failure or unsaved completion. Retain existing upstream authorization,
   outside-content provenance and all action/approval paths. No domain tool reads.
4. Carry optional `visualReply` and a host-readable compatibility fallback through completed
   options, repository metadata, serializer, response JSON schemas, live/HTTP DTOs and browser
   hydration. Incognito never gains durable metadata. Deletion follows the existing message.
5. Production web dependency pinned to OpenUI 1.0.1. Add inspected Vite loading adapter,
   lazy renderer, authored Moss components and local layout-only CSS. Validate on render;
   reject unsupported catalog/interactions; error/loading paths preserve the ordinary answer
   and readable data. Copy contains prose and data, never the program. Update core app map.
6. Add meaningful semantic, serialization, persistence, live/reconnect and browser tests.
   Exercise the real installed UI and configured route before review/merge. Measure app
   bundle delta against the same baseline build and record per-turn overhead/latency.

The model has exactly two jobs: decide whether a visual helps and arrange approved components;
write concise interpretation. Host code owns data, identity, fallback, validation and save
status. New guidance stays below 150 words plus generated signatures and supplied data.
No model-authored value is written into user records by this slice; no Apply or write controls.
The smaller fixed-template alternative is simpler but cannot prove the approved novel-composition
behavior. The bounded catalog reuses the evaluated runtime without introducing domain families.

## Verification and kill gate

Tests must reject forged/foreign refs, unknown fields, extra arguments, incomplete/recovered
syntax, unsupported catalog/features and excess nodes/depth/facts. They must distinguish a
saved visual from one proposed before Stop/failure, and verify that only the matching turn is
replaced after save and hydration. Unknown metadata must keep useful fallback without DSL.
Observe relevant semantic/identity/publication negative controls failing, restore and rerun.

Commands are unpiped; expected exit 0 except explicitly recorded negative controls:

- Focused `pnpm exec vitest run <changed unit tests>`.
- Root `pnpm exec tsc --noEmit` and owning shared/chat/web package typechecks.
- Scoped ESLint and Prettier; `pnpm check:file-size`, design tokens and UI-class checks.
- Full gate only via verify-gate: `scripts/run-gate.sh start`, then sentinel
  `scripts/run-gate.sh wait --follow` in a detached tool session; inspect its exit code.
- Real installed-dev Playwright: prompt -> proposal -> save -> render -> reload/reconnect/copy;
  Stop, model failure, thread switch, incognito/deletion and text-only compatibility. Real app
  responses only; any disclosed third-party stand-in does not count as model reliability.
- Twenty fixed prompts per configured rollout route: novel compositions, ordinary prose and
  explicit text-only. At least 19/20 intended visual outcomes first attempt; 20/20 useful text.

Kill gate: if restriction, loading, lifecycle or configured-route reliability fails, record a
measured recommendation on #3583 and stop domain rollout. Ben owns renderer/scope changes.
Unavailable live prerequisites remain honestly unverified and block product merge.

Independent Standards and Spec reviews inspect the exact final head. Resolve findings, record
live evidence on the PR, require green CI, then squash merge using the reviewed head without
admin override/branch deletion. Keep #3583 open for later stages. Preserve durable work by
explicit-path commits/pushes and finish with clean tree and session-owned resources stopped.

## Review resolutions

The first independent review of `4b9d22ba1` found three integration gaps. Stop now passes its
signal through the existing persistence transaction, checks after message writes and at the
last transaction boundary, and suppresses publication if cancellation wins after the save await.
A database commit that already won the race may remain in history. Proposal acceptance emits
host-owned Preparing visual status; every terminal path clears that exact turn's status.
The browser uses the validator's compatibility fallback for future HTTP envelopes.

Reconnect catch-up previously recovered reminders only. History now exposes the existing stored
turn ID, and the browser recovers a saved reply only for a turn already observed in the selected
transcript. It replaces that turn's draft, clears progress and deduplicates the saved identity;
it does not import older or foreign-thread replies. This is exercised by a real disconnect that
misses both HTTP completion and the stream's saved reply.

Portable archive output also needs the readable facts. The archive query moves to
`packages/chat/src/archive-messages.ts`; its visibility predicate is shared with the repository.
Archive and settings export use shared `storedVisualText`. Integration tests cover rollback
after actual inserts, archive text, a privileged fixture deletion's foreign-key cascade and zero
private visual rows. Durable threads deliberately have no runtime deletion API; the cascade test
uses the isolated database's bootstrap fixture channel and makes no user-facing deletion claim.
No new store.

The acceptance script now uses twenty visual requests plus four prose/text-only controls,
checks every rendered binding, records usage, program/fallback bytes and latency, and faults
the real CLI after an accepted proposal to verify failure cleanup. Preliminary sixteen-visual
results are not treated as the full acceptance gate.
