# Visual reply contracts and turn registry (stage 1b.1)

Task: [#3589](https://github.com/motioneso/moss/issues/3589), part of
[#3583](https://github.com/motioneso/moss/issues/3583). Stacked on
[#3585](https://github.com/motioneso/moss/pull/3585) (`spec/visual-chat-replies`).
Parent docs: [spec](../specs/2026-10-23-visual-chat-replies.md),
[staged plan](2026-10-23-visual-chat-replies.md),
[stage-1a evidence](../../research/2026-10-23-visual-chat-runtime-evaluation.md).
Handoff: [handoff](../handoffs/2026-10-23-visual-chat-contracts.md).

## Scope

Internal only. Two new seams, no caller, no flag, no app-map change (no visible capability).
Excluded: `chat.present`, engines, module reads, persistence, live/history reducers, UI.
The registry is a lifetime and reference boundary. It trusts already-authorized,
normalizer-projected input and does not replace actor-scoped reads or RLS.

## Seams checked

| Fact                                                               | Evidence                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Shared contracts are plain TS plus hand-written JSON schemas       | `packages/shared/src/chat-action-outcome.ts`, `package.json`  |
| `@moss/shared` has no zod dependency; none added                   | `packages/shared/package.json`                                |
| Shared barrel re-exports each `*-api.ts`/helper file               | `packages/shared/src/index.ts`                                |
| `Brand<T, B>` already exists for branded ids                       | `packages/shared/src/index.ts:1`                              |
| Root vitest picks up `tests/**/*.test.ts`; no config change needed | `vitest.config.ts` `test.include`                             |
| `@moss/chat` source imports `@moss/shared`                         | `packages/chat/package.json`                                  |
| No `packages/chat/src/visual/` exists yet                          | directory listing                                             |
| File-size cap is 1000 lines                                        | `scripts/check-file-size.ts`; new files stay under ~300 lines |

## Files

- `packages/shared/src/visual-chat.ts` (exported from the barrel): types, limits, validators.
- `packages/chat/src/visual/turn-registry.ts`: per-turn registry.
- `tests/visual-chat-contracts.test.ts`, `tests/visual-chat-turn-registry.test.ts`.

## Contract signatures (shared)

```ts
export const VISUAL_REPLY_VERSION = 1;
export const VISUAL_LIMITS: Readonly<Record<string, number>>;
export type VisualValue = string | number | boolean | null | VisualValue[] | { [k: string]: VisualValue };
export type VisualOrigin = "source" | "user" | "example";
export interface VisualSnapshotV1 { ref; kind; origin; source: { id; label }; retrievedAt; coverage; revision?; fields }
export interface VisualBlockV1 { blockId; kind; snapshotRefs: string[]; program?: string }
export interface VisualInteractionV1 { interactionId; blockId; kind: "follow_up"|"navigate"|"action_request"; label; descriptorId; snapshotRef?; params }
export interface VisualReplyV1 { version: 1; catalogVersion; blocks; snapshots; interactions; fallbackText }
export interface VisualPresentationProposalV1 { catalogVersion; blocks: {kind; snapshotRefs; program?}[]; interactions?: ... }
export type VisualReplyValidation =
  | { ok: true; reply: VisualReplyV1 }
  | { ok: false; code: VisualFailureCode; fallbackText: string | null };
export function validateVisualReply(value: unknown): VisualReplyValidation;
export function validateVisualProposal(value: unknown): ProposalValidation;
```

Failure codes: `not_object`, `unsupported_version`, `too_large`, `not_serializable`,
`malformed`, `limit_exceeded`, `dangling_reference`. On any failure `fallbackText` carries the
envelope's readable text when it is a valid bounded string, otherwise `null`.

## Decisions

- Envelope validation checks shape only. A program that passes is not safe to render; catalog,
  argument, node-count and depth checks belong to the later renderer-side semantic validator.
- Validators copy while validating, so output never aliases caller objects. Unknown keys fail.
  Values must be JSON (plain objects, finite numbers); class instances, `undefined`, cycles fail.
- Model input cannot mint trust. A proposal has no block ids, snapshots, source labels or
  fallback text. The host mints `blockId`/`interactionId`/refs and supplies fallback text.
- `TrustedVisualReply = Brand<VisualReplyV1, "TrustedVisualReply">`, produced only by the registry.
- Interaction `descriptorId` is a name the later dispatcher resolves. No URLs, verbs or paths.

## Limits

Enforced here: envelope 64 KiB serialized; 3 blocks; 6 interactions; 4 refs per block; 8 snapshots
per reply; snapshot 16 KiB; value depth 4; arrays 24; object keys 32; strings 500 (program 16 KiB,
fallback 4000); interaction params 4 scalars.

Deferred to catalog validation: 3 metrics, 2 series, 10 table rows, 12 timeline rows, 6 cards,
component depth 4 and 80 nodes. They need parsed program structure. The array cap of 24 is a
data-size ceiling only.

Registry bounds per turn: 16 snapshots, 128 KiB total snapshot bytes.

## Registry

```ts
export interface VisualTurnIdentity {
  actorUserId: string;
  threadId: string;
  turnId: string;
}
export type TrustedVisualReply = Brand<VisualReplyV1, "TrustedVisualReply">;
export class VisualTurnRegistry {
  constructor(identity: VisualTurnIdentity);
  readonly state: "open" | "closed" | "discarded";
  register(identity, input: VisualSnapshotInput): { ok: true; ref } | { ok: false; code };
  finalize(
    identity,
    proposal: unknown,
    fallbackText: string
  ): { ok: true; reply: TrustedVisualReply } | { ok: false; code; fallbackText };
  close(identity): void; // after a successful commit; nothing further works
  discard(identity): void; // cancel/failure; snapshots dropped
}
```

Lifecycle: the turn-finalization code (later task) creates one registry from captured host
identity when the turn starts, registers normalized snapshots during the turn, calls `finalize`
once before save, then `close` on commit or `discard` on cancel/failure. Refs are
`vs_<random uuid>`, valid only in the issuing instance. Identity is compared on every call.
Snapshot input is an explicit DTO; extra properties are rejected, never serialized.

## Tests (behaviour, and why a broken build fails)

Contracts: valid round trip through JSON; unknown version returns `unsupported_version` with
fallback text kept; each limit one over fails; non-JSON values (cycle, `undefined`, class
instance, NaN) fail; unknown keys fail; dangling block ref fails; `program` only on
`composition`; output does not alias input.
Registry: finalize with unregistered, forged and other-registry refs fails; wrong
actor/thread/turn identity fails on each method; register/finalize after `close` and after
`discard` fail; `discard` drops snapshots; mutating the input after `register` does not change
the snapshot; stored snapshot is frozen; unknown input property rejected; count and byte caps hold;
finalized reply includes only referenced snapshots.

## Negative controls

Remove each guard, observe the named tests fail, restore, rerun: version check, size check,
dangling-ref check, owning-registry lookup, identity comparison, closed-state check, input copy.
Results recorded in the PR.

## Verification (unpiped, expected exit 0)

```bash
pnpm exec vitest run tests/visual-chat-contracts.test.ts tests/visual-chat-turn-registry.test.ts
pnpm exec tsc --noEmit
pnpm --filter @moss/shared typecheck
pnpm --filter @moss/chat typecheck
pnpm exec eslint packages/shared/src/visual-chat.ts packages/chat/src/visual tests/visual-chat-*.test.ts --max-warnings=0
pnpm exec prettier --check <changed paths>
pnpm check:file-size
```

No database needed. No UI proof is claimed.

## Remaining after this slice

`chat.present` registration and per-turn context injection; module read adapters; fallback-text
formatting from snapshots; catalog/semantic validation; shared/live DTO and history fields;
persistence; frontend slot; installed-dev proof; 20-prompt engine gate. Stage 1 stays incomplete.
