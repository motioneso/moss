# Handoff: visual reply contracts and turn-scoped snapshots

Task: [#3589](https://github.com/motioneso/moss/issues/3589), part of
[#3583](https://github.com/motioneso/moss/issues/3583).
Dependency: [draft PR #3585](https://github.com/motioneso/moss/pull/3585), branch
`spec/visual-chat-replies`. Source baseline before this handoff: `5313d9fb2`.
Ben requested this handoff after approving the spec, plan and beginning implementation.

## Start

1. Work only in `~/Jarv1s/.claude/worktrees/visual-chat-contracts`, branch
   `feat/visual-chat-contracts`. You are not alone in the repository: do not revert others'
   changes, switch the shared checkout, or work in another agent's tree.
2. Install with `pnpm install --frozen-lockfile`. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DEVELOPMENT_STANDARDS.md` and `.claude/skills/plan-build/SKILL.md`.
   Read the linked spec, plan and runtime evidence below in full.
3. Inspect #3589 and the dependency PR's current status. Search Hindsight knowledge pages
   for relevant decisions; prefer codebase-memory graph tools for code discovery.
   Verify actual contracts and package exports before choosing final signatures.
4. Write a bounded, task-linked implementation plan under `docs/superpowers/plans/` and
   commit it before coding. The approved spec and this bounded task authorize execution;
   proceed without another routine approval round. Do not delegate this slice.
5. Implement stage **1b.1 only**, verify it, commit and push, and open a draft PR against
   **`spec/visual-chat-replies`** while #3585 remains unmerged. Record its dependency.
   If the base merges meanwhile, inspect the resulting history before selecting the PR base.

## Authoritative documents and current state

- [Approved spec](../specs/2026-10-23-visual-chat-replies.md).
- [Staged implementation plan](../plans/2026-10-23-visual-chat-replies.md).
- [Stage-1a evidence](../../research/2026-10-23-visual-chat-runtime-evaluation.md).
- Experiment usage: `spikes/visual-chat-runtime/README.md`.

Stage 1a is an isolated runtime experiment, not production visual replies. Actual OpenUI
1.0.1 was exercised with Moss React 19.2.7, Zod 4.4.3 and Vite 7.3.5. Its unit tests,
TypeScript checks and Firefox development/production checks passed; restriction and loader
suppression negative controls failed as expected. Its measured incremental browser JS was
187,739 raw / 58,601 gzip bytes in the isolated fixture, not a whole-app estimate.
The experiment contains an inspected development-bootstrap adapter; read the evidence before
reusing any approach. **Do not import spike code into production.**

Production tool registration, authorized module reads, metadata/live/history integration,
frontend rendering, installed-Moss proof and the configured-engine 20-prompt gate remain open.
Stage 1 and all out-of-the-box domain families remain incomplete.

## Ownership and scope

Own renderer-independent shared contracts, strict validation and an in-memory turn registry:

- Expected shared seam: `packages/shared/src/visual-chat.ts` and its public export.
- Expected server seam: `packages/chat/src/visual/` and focused unit tests.
- Your task plan and concise verification/status notes.

Verify those seams via the graph and existing conventions before finalizing file placement.
Avoid unrelated refactors, dependency churn and edits to the spike.

Define `VisualReplyV1`, `VisualSnapshotV1`, `VisualPresentationProposalV1` and
`validateVisualReply(value: unknown)`, with explicit schema/version handling. The envelope
must support catalog identity, restricted program, approved source references/snapshots,
bounded supported interaction descriptors and host-readable fallback. Distinguish envelope
validation from the later renderer DSL's semantic validation: passing a schema does not make
a program safe to render. Keep contracts generic enough for novel approved compositions;
do not bake in domain templates or the experiment's three fixture fact names.

The model chooses whether a visual helps, its arrangement and concise interpretation.
Host/module code owns source facts, calculations, context, references, assets, statuses and
fallback. Models cannot mint a trusted reference or select actor/thread/turn context.

The registry accepts **already-authorized, normalizer-projected input**. It is a lifetime
and reference boundary, not an authorization source or substitute for actor-scoped reads/RLS.
Bind each instance to captured host actor/thread/turn identity. Generate opaque references
on the host, reject forged and foreign references, reject use after the turn closes, and
discard pending state on cancellation/failure. Document its lifecycle and ownership.

Capture immutable snapshots rather than retaining caller-owned mutable objects. Accept only
explicit normalized DTO fields; do not serialize arbitrary source properties, module records
or secrets. Validate references against the owning registry before creating a trusted reply.
Unknown versions and malformed inputs return explicit unavailable/fallback outcomes that
preserve readable text. Validate serialized data as well as TypeScript callers.

Use the spec's bounds: 3 sections, 3 metrics, 2 chart series with 24 points each, 10 table rows,
12 timeline/task rows, 6 cards/choices, depth 4, 80 nodes and a 64 KiB envelope. State which
limits this layer enforces and which require later semantic/catalog validation. Bound snapshot
and reference counts/bytes explicitly in the task plan; avoid an unbounded registry.

## Exclusions and honest completion

Do not register `chat.present`, wire engines, fetch module data, add persistence or metadata,
change live/history reducers, render UI, enable flags, or implement sports/weather/actions.
Do not claim authorization, renderer safety or production support from this internal slice.
There is no new visible capability to advertise in the app map. If your scope introduces one,
stop the expansion and keep this task internal; product changes require truthful same-PR map
updates. Do not merge/deploy, close #3583 or mark full stage 1b/stage 1 complete.

## Verification and delivery

Use meaningful unit cases for version/shape/size failures, serialization round trips, mutable
input isolation, foreign/forged references, host context binding and closed/cancelled lifetimes.
Follow the repo's test conventions. For each claimed security boundary, inspect receiving code
and observe the relevant test fail with that protection removed, then restore and rerun.
Record exactly which behavior was tested; avoid broader claims.

Run unpiped commands and preserve their exit codes:

- Focused unit suite for the new contracts and registry.
- `pnpm exec tsc --noEmit` and the owning package's TypeScript check.
- Scoped ESLint with `--max-warnings=0`, Prettier and the repo's file-size check.
- Other required checks from development standards appropriate to this internal slice.

Never run `pnpm verify:foundation` or DB-touching tests without first reading and following
`.claude/skills/verify-gate/SKILL.md`. This pure internal slice should not need a database.
No UI proof is claimed here; the full stage-1 live-path and configured-engine gates remain.

Before committing, follow the shared-checkout skill and inspect every owned diff. Use explicit
paths, check public docs for secrets/private hostnames/LAN addresses, and use `~/Jarv1s` in docs.
Finish clean and pushed with a task-linked draft PR, Category: N/A release note, verification
evidence, negative-control results and a clear list of remaining integration work. Report on
#3589 and link it from #3583 without closing the parent. Stop resources you start; claim any
needed preview port through `devports` (5180–5299). Existing previews are not yours to stop.
