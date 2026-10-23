# Visual chat replies implementation plan

Part of [#3583](https://github.com/motioneso/moss/issues/3583).
Approved product/design: [visual replies spec](../specs/2026-10-23-visual-chat-replies.md).
Ben authorized planning and starting implementation on 2026-10-23. This plan is staged:
the first runtime experiment ships independently; later stages remain bounded outlines
until the runtime gate supplies evidence. Work stays in one task worktree under `~/Jarv1s`.

## Current state

- Spec and eight-family design targets approved; production support is not implemented.
- Start: runtime evaluation in `spikes/visual-chat-runtime/`, isolated from app entry points.
- First checkpoint: actual published runtime, Moss React/Zod/Vite setup, useful text fallback,
  restricted composition, development/production network behavior and measured bundle size.
- Full stage 1 additionally requires actual chat tool/persistence/engine/browser evidence.
  Passing the isolated experiment alone does not pass that gate.

## Verified seams and gaps

Source baseline: `e92b1e1c4`. Citations below refer to that tree, before implementation.

| Capability                    | Current evidence                                                                                               | Decision                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Existing React runtime        | `apps/web/package.json:34` declares React 19                                                                   | Evaluate against the same resolved React and Vite versions; pin OpenUI 1.0.1, including its core parser through the lockfile. |
| Shared message contract       | `packages/shared/src/chat-api.ts:91` (`ChatMessageDto`), `:205` (`TranscriptRecord`), `:691` (response schema) | Add optional versioned metadata to all actual live/history contracts and JSON schemas after runtime evaluation.               |
| Server live record            | `packages/chat/src/live/types.ts:21` declares a separate `TranscriptRecord`                                    | Update this contract too; changing only the shared DTO misses the live producer.                                              |
| Stored metadata serialization | `packages/chat/src/route-serializers.ts:89` reconstructs known fields                                          | Validate metadata explicitly; unknown visual versions retain a host-readable fallback.                                        |
| Completion ordering           | `packages/chat/src/live/chat-session-turn.ts:467` stores, `:517` re-emits stored reply                         | Attach a complete visual only after save, using captured thread/turn/message identity.                                        |
| Persistence port              | `packages/chat/src/live/chat-session-ports.ts:89` declares `recordTurn` options                                | Extend the existing metadata lifecycle, not a separate visual store.                                                          |
| Existing reply slot           | `apps/web/src/chat/message-row.tsx:132` renders Markdown, provenance and freshness                             | Add a bounded adjacent slot; preserve approvals, image restrictions, feedback and text paths.                                 |
| Tool discovery                | `packages/ai/src/assistant-tools.ts:7` lists manifest assistant tools                                          | Register `chat.present` through the existing catalog; per-turn context injection is a gap owned by the stage-1 implementer.   |
| Sports read restriction       | `packages/sports/src/manifest.ts:312` blocks overview for external effects                                     | Add a Sports-owned latest-completed-result read; never enable the overview route for chat.                                    |
| Weather forecast              | `packages/weather/src/manifest.ts:45`, `packages/shared/src/weather-api.ts:33` expose current/daily reads      | Add bounded intervals, time zone and coverage in Weather; daily lows cannot answer hourly questions.                          |
| Authored UI                   | `packages/ui/src/index.ts:1`, `docs/design-system.md`                                                          | Register Moss components; add genuinely missing primitives to `@moss/ui`.                                                     |

Open questions have named owners and are resolved by observation, not assumed as platform features:

- Stage-1 implementer: where every configured engine admits a read-only presentation tool and
  can supply captured actor/thread/turn context without making it model-controlled.
- Stage-1 implementer: the narrow common point for module read snapshots, preserving existing
  outside-content provenance and actor/conversation authorization.
- Stage-1 implementer: published runtime's parser/evaluator behavior, permissive recovery,
  developer loader suppression, observability and actual network requests.
- Stage-1 implementer with Ben: configurations used for rollout; evaluate each through its real
  configured route, without exporting credentials or using the prototype's local CLI bridge.

## Decisions and boundaries

The model has exactly two jobs: (1) decide whether a visual helps and select/arrange approved
components; (2) write concise interpretation and propose supported follow-ups. Host/module
code owns source facts, calculations, asset identities, bounds, statuses and action execution.
Loading, validation errors and save/action outcomes render from host records. Modules do not
inject turns. Keep runtime guidance under 150 words plus generated component signatures.

Use a host-owned versioned envelope with catalog identity, approved source snapshots/references,
restricted program, supported interaction descriptors and host-formatted fallback text.
Expose `chat.present` as a read-only proposal in the current authorized turn; no fetch or write
authority belongs to the renderer. Start with final-only publication while prose streams.

Evaluate OpenUI rather than adopt the prototype's bespoke JSON renderer: the prototype is
smaller and already demonstrated model interaction, but has not proven the agreed runtime or
its composition semantics. Conversely, OpenUI provides a parser and component schemas but
needs explicit restriction, dependency review and measured loading behavior. If it fails,
record the evidence and recommend a decision; do not silently substitute a different runtime.

## 1. Runtime and end-to-end contract gate

### 1a. Published-runtime experiment — start here

Own `spikes/visual-chat-runtime/`, its workspace dependency/lockfile changes and an evidence note.
No production caller, feature flag, app-map capability claim or production dependencies yet.

1. Pin `@openuidev/react-lang@1.0.1`; inspect the installed parser/evaluator and development
   bootstrap, not just upstream documentation. Record resolved transitive versions.
2. Register a tiny authored Moss catalog with Zod v4 schemas. Exercise several new arrangements
   without domain template IDs; keep separate ordinary text and readable fallback.
3. Enforce the experiment's documented restricted syntax before rendering; test unknown calls,
   truncation, malformed inputs, excessive depth/size and rejected query/mutation/state/action
   constructs. Unsupported programs fall back rather than relying on permissive recovery.
4. Build and mount the real renderer under Vite in development and production. Observe actual
   browser requests, loader mounts, React errors and readable output. Keep observability off;
   remove or suppress the inspected dev bootstrap with a bounded, verified integration.
5. Record baseline and incremental raw/gzip browser bytes using the same fixture and build.
   State that these are isolated fixture measurements, not whole-app savings or latency.

Tests must distinguish broken behavior: removing the restriction must make rejection tests
fail; removing loader suppression must make the development-loader check fail. Browser checks
must assert rendered content rather than only that an element exists. No model reliability,
source authorization or production lifecycle claim follows from fixed fixture programs.

### 1b. Host integration — only after 1a is evaluated

Own `packages/shared/src/visual-chat.ts`, shared exports/contracts/schemas,
`packages/chat/src/visual/`, the existing completion/persistence/serialization seams,
`apps/web/src/chat/visual/` and the minimal calls in the shared record renderer/reducer/history.
Add module catalog declarations only where required by the verified registration seam.

Define and validate `VisualReplyV1`, `VisualSnapshotV1`, `VisualPresentationProposalV1` and
`validateVisualReply(value: unknown)` independently of the renderer. The turn registry binds
actor/thread/turn and normalizer-approved facts; model input cannot mint source references.
Use one typed, explicitly labeled user-data read-only composition for the first complete path.

Wire `chat.present` through all rollout engines. Finalization validates before save; cancelled
or failed turns discard pending visuals. Publish the saved envelope on the existing reply;
update live reduction/history to converge on its identity. Lazy-load the visual slot with an
error boundary, preserve copy/export/incognito/deletion and text-only destinations, and update
the core app map only to describe behavior actually available in that PR.

Required evidence: a real installed-dev Playwright case from prompt to tool proposal to stored
reply, reload/reconnect/copy; cancellation and switching threads cannot misattach a visual.
Twenty fixed prompts per rollout engine/provider configuration include novel compositions,
simple prose and explicit text-only requests. At least 19/20 first attempts produce the intended
visual; all 20 retain useful text. Measure prompt/output overhead, latency and app bundle delta.

Kill gate: stop before domain rollout if runtime restriction, observed loader behavior,
message lifecycle, configured-engine reliability or data/action boundaries fail. The implementer
records a measured recommendation on #3583; Ben decides any renderer or scope change. Do not
declare stage 1 complete without its real installed-dev proof and configured-engine results.

## 2. Sourced read-only answers

After the gate, write a detailed task plan for Sports/Weather public reads, normalizers and
cards; then planning, tasks, money, comparisons and recommendations through authorized reads.
Each normalizer registers facts, coverage, freshness and reviewed assets without selecting
every possible layout. Sports uses correct real logos with accessible failure fallbacks.
Add missing general chart/table/timeline primitives to `packages/ui`, keeping domain cards in
their owning module. Update manifests and core app map in the same product PR.

Required installed-dev browser cases: latest completed Liverpool match across covered
competitions; evening weather using actual interval data; a novel user-data composition.
Tests also cover null scores, draws/shootouts, incomplete competition coverage, unavailable
hourly forecasts, unknown calendar coverage, money period/currency and asset failures.

## 3. Conversational controls

Detailed plan follows read-only acceptance. Add bounded choices, explicit slider Apply and
registered navigation through the host dispatcher. Submit visible normal follow-up messages
with captured thread identity and interaction IDs; server validates selected values. Drafts
survive a busy-send failure locally and reset on reload. No budget/calendar write from a slider.

Installed-dev browser evidence: keyboard slider change sends nothing until Apply; one Apply
creates one contextual reply; follow-up changes layout and values; busy/retry/thread switching
cannot lose or redirect the selection; history does not submit or refetch on mount.

## 4. Actions and complete catalog

Detailed plan follows conversational acceptance. Reuse the existing resolver/writer and
ActionRequestCard/WorkflowApprovalCard, re-resolve revisions and render host-authored outcomes.
Complete all eight families and map declarations. No generated action URL or second approval
system. Record live successful, denied, failed and stale-target interactions, including reload
and repeat click. Announce out-of-the-box support only after the full spec acceptance matrix.

## Verification and delivery

Commit this plan before implementation. Keep review decisions/evidence below and stage status
on #3583. Each independently reviewable slice receives its own honest evidence and release-note
classification; internal experiment/docs are Category: N/A. No merge is implied by starting.

Commands are unpiped; expected exit code is 0 unless a negative control is explicitly named:

- `pnpm exec prettier --check <changed paths>` and `pnpm exec eslint <changed code paths> --max-warnings=0`.
- `pnpm exec tsc --noEmit` and the owning package/browser TypeScript check.
- `pnpm exec vitest run <unit paths>` for deterministic contract/boundary failures.
- Runtime experiment: its documented build and real-browser check commands.
- Product slices: `pnpm lint`, `pnpm format:check`, `pnpm check:file-size`, `pnpm typecheck`.
- Database/full checks only through `.claude/skills/verify-gate/SKILL.md`:
  `scripts/run-gate.sh start`, then detached `scripts/run-gate.sh wait --follow`;
  inspect the actual exit code. This excludes CI's separate browser suite.
- Live product evidence uses the real dev instance and API, with no intercepted/faked app
  responses. Claimed security guards need an observed failing negative control.

## Rulings and evidence ledger

- 2026-10-23: Ben approved planning and beginning implementation after reviewing capabilities
  and limits. Real logos and on-the-fly composition remain required release behavior.
- 2026-10-23: separate server live record and explicit response schema verified above;
  both must change alongside the shared DTO. No general visual metadata currently exists.
- 2026-10-23: runtime evaluation started; runtime/network/engine acceptance not yet passed.
