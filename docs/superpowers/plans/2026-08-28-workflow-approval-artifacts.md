# Workflow approval and artifact continuation build plan

Issue: #2015
Spec: `docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md`, sections `Artifacts`, `Approval Steps`, `API Surface`, and `Verification`.

## Current seams check

- `packages/workflows/src/routes.ts:113-149` already owns approval resolution and preserves the required 404 and 409 responses, but its dependencies do not include pg-boss.
- `packages/workflows/src/repository.ts:593-645` performs the owner-scoped compare-and-set and changes the step to `queued`, clearing the old job id. It returns the step needed for continuation.
- `packages/workflows/src/jobs.ts:65-93` is the existing metadata-only enqueue boundary and emits only `actorUserId`, `workflowRunId`, and `stepRunId`.
- `packages/workflows/src/workers.ts:113-169` already treats approval steps separately from task handlers, while the artifact port is still a throwing placeholder at lines 161-167.
- `packages/workflows/src/workers.ts:241-265` registers both workflow queues; the worker dependency interface at lines 27-32 is the place to add the vault runner.
- `packages/workflows/src/repository.ts:672-709` already provides owner-and-run artifact listing, and `packages/workflows/src/repository.ts:651-670` records metadata without bytes. The lookup method must be tightened to check the requested step and return the stored reference metadata needed by the port.
- `packages/vault/src/vault-context.ts:31-49` provides `VaultContextRunner.withVaultContext`; `packages/vault/src/vault-ops.ts:67-86` provides the only required byte read/write operations.
- `packages/module-registry/src/index.ts:2255-2265` wires workflow routes and workers but currently passes neither the queue client to routes nor the vault runner to workers.
- `apps/web/src/api/client.ts:1044-1053` and `apps/web/src/api/client.ts:1407-1439` establish the existing request helper pattern; `apps/web/src/chat/action-request-card.tsx:18-124` establishes the accessible action-card states and double-submit guard.
- `packages/workflows/sql/0202_workflow_runs.sql:151-184` confirms the applied workflow artifact table already stores owner, run, optional step, path, hash, type, and size; no migration is needed.

All assumptions needed by this slice are present on the branch. The approved issue comment is the source of the exact acceptance criteria.

## Decisions

- Keep approval resolution in the existing route transaction. After a successful repository result, call `enqueueWorkflowStep` with the returned queued step, then persist the returned job id in a fresh owner-scoped data-context call. A null job id remains safe because queue bookkeeping already ignores terminal or cancelled steps.
- Add a small `WorkflowArtifactPort` factory in `packages/workflows/src/artifacts.ts`. It owns one actor, workflow run, and step run, validates every write input against those ids, hashes bytes with Node's standard `crypto`, writes through `VaultContextRunner`, records only bounded metadata, and reads only after an owner/run/step-checked repository lookup.
- Keep `artifactRef` server-only. The port may use it internally; `safeArtifact` continues returning only stable id, run/step ids, hash, content type, size, and timestamps.
- Give approval continuation the run owner from the resolved step/run record. The HTTP actor can resolve only its own approval; it is never copied into the job as a substitute for the owner.
- Reuse existing action-card classes and add no CSS unless the authored design-system audit proves a missing primitive. The new card will expose only summary/status text and the two buttons.
- Determinism boundary: the card renders its state from the approval response or `ApiError`, not from model output; no model turn or chat injection is added.

## Phase 1: approval continuation

Files: `packages/workflows/src/routes.ts`, `packages/workflows/src/repository.ts` only if a narrow lookup/transaction correction is needed, `packages/module-registry/src/index.ts`, `tests/unit/workflows-routes.test.ts`, `tests/integration/workflow-step-worker.test.ts`.

Contracts:

- `WorkflowsRouteDependencies` gains `boss: PgBoss`.
- A resolved approval sends exactly one `WORKFLOW_STEP_EXECUTE_QUEUE` job with `{ actorUserId: ownerUserId, workflowRunId, stepRunId }`, then stores its returned id.
- Approval delivery creates one pending approval, duplicate delivery no-ops, and a resolved approval records `{ status: "approved" | "denied" }`, completes without a task handler, and routes through matching result edges.
- Cancellation stays terminal and repeat-safe; late jobs remain no-ops.

Tests must fail if the route enqueues before the transaction result, uses the resolving actor instead of the owner, adds content to the job, creates duplicate approvals, invokes an approval handler, or revives a cancelled run. Keep the existing 404, 409, cancellation, and response-redaction assertions.

Observed end-to-end check for this phase: the integration worker test resolves both approval outcomes through the real repository and queue boundary and observes the successor step and final run state.

Kill gate: stop this slice if the existing transaction cannot safely commit the approval and queue bookkeeping without exposing a second job; the owner is the build agent and the decision is to report the blocker rather than add a second workflow table or migration.

## Phase 2: Vault-backed artifact port

Files: `packages/workflows/src/artifacts.ts`, `packages/workflows/src/workers.ts`, `packages/workflows/src/repository.ts`, `packages/workflows/src/index.ts`, `packages/workflows/package.json`, `packages/module-registry/src/index.ts`, `tests/integration/workflow-approval-artifact.test.ts`.

Contracts:

- Export `createWorkflowArtifactPort(input: { ownerUserId: string; workflowRunId: string; stepRunId: string; dataContext: DataContextRunner; vaultRunner: VaultContextRunner; repository: WorkflowsRepository }): WorkflowArtifactPort` and the `WorkflowArtifactPort` type.
- `write` accepts the spec's `{ workflowRunId, stepRunId, contentType, bytes }`, rejects mismatched ids, writes to `workflows/<workflowRunId>/<generated-id>`, computes SHA-256 and byte count, records metadata, and returns the internal reference plus hash and size.
- `read(artifactRef)` first resolves the artifact through the owner/run/step-scoped repository lookup, then reads with `readVaultFileBytes`, verifies SHA-256 and size, and returns bytes plus stored content type. A path supplied by a handler is never trusted.
- Worker handlers receive this port; bytes never enter step results, queue payloads, logs, prompts, or HTTP responses.

Tests must fail if raw `fs` is used, a second owner/run/step can read, stored bytes/hash/size differ, or the database/HTTP output contains bytes or a raw reference.

Observed end-to-end check for this phase: the isolated VaultContext integration test writes and reads bytes through the worker handler and verifies the metadata-only database and response boundaries.

## Phase 3: small approval card

Files: `apps/web/src/api/workflows-client.ts`, `apps/web/src/chat/workflow-approval-card.tsx`, `tests/unit/workflow-approval-card.test.tsx`, `tests/uat/specs/workflow-approval-card.uat.spec.ts`, `.claude/skills/coordinate/uat-trigger-map.tsv`.

Contracts:

- `resolveWorkflowApproval(approvalId: string, decision: "approve" | "deny")` uses `requestJson` and shared workflow response types.
- `WorkflowApprovalCard` accepts the safe approval summary and id, renders Approve and Reject, prevents double submission, shows the resolved state, and turns status 409 into `This approval has already been answered`.
- Use existing authored action-card classes and accessible button behavior; no new page, stream, download, or builder.

Tests must fail if either button is missing, a second click sends another request, resolved state is not shown, or 409 is presented as an opaque error.

Observed end-to-end check for this phase: the UAT spec exercises owner signup, the real workflow approval UI path, one decision, and the resulting bounded status/DOM evidence on a live dev instance.

## Verification

- `pnpm format:check` -> 0.
- `pnpm lint` -> 0.
- `pnpm typecheck` -> 0.
- `pnpm check:design-tokens` -> 0.
- `pnpm build:web` (or the repository's existing web-build script) -> 0.
- Full database and integration checks run only through `.claude/skills/verify-gate/SKILL.md`: `scripts/run-gate.sh start`, then one background `scripts/run-gate.sh wait --follow`, with the runner exit code recorded.
- UAT runs through the real dev instance and its exit code plus bounded assertions are posted as a PR comment whose first line is exactly `LIVE-PATH PROOF`.

Every verification command is unpiped so its exit code is trustworthy. No new database migration is planned.
