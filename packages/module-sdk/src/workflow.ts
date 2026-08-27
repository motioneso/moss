// #2012 (slice 819-A of epic #819): the shape a built-in module's developer writes a workflow in.
// Spec: docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md -> "Workflow Definition API".
//
// Declarations only. Nothing in this slice executes a workflow: there is no database schema, no
// pg-boss queue, no worker and no UI yet. Those land in later 819 slices. The one behaviour that
// ships alongside these types is boot-time validation, in
// packages/module-registry/src/workflow-registry.ts.
//
// Split out of index.ts rather than added to it: index.ts is the SDK barrel, already ~830 lines
// against the 1000-line `pnpm check:file-size` gate, and is not on that gate's exemption list.
//
// This file must not import anything from `node:*`. It is re-exported from the barrel, which is
// guarded by tests/unit/module-sdk-barrel-browser-safety.test.ts, and a node: import there breaks
// the web build.

/**
 * Upper bound on `WorkflowStepRetryPolicy.maxAttempts`. This is the "bounded implementation cap"
 * the spec requires: without a ceiling a definition could pin a worker to one step indefinitely.
 * Stated once here so the validator and its tests read the same number.
 */
export const MAX_WORKFLOW_STEP_ATTEMPTS = 10;

/**
 * How a run starts. V1 has no user-facing workflow builder: `manual` means module or server code
 * starts the run after its own permission checks, `module` means another module event does.
 */
export type WorkflowTrigger = "manual" | "module";

/** A step either runs code (`task`) or waits for a human decision (`approval`). */
export type WorkflowStepKind = "task" | "approval";

/** Retry spacing. `fixed` waits `backoffMs` each time; `exponential` doubles it per attempt. */
export type WorkflowBackoffStrategy = "fixed" | "exponential";

/**
 * How a step handler reads and writes large or private payloads. Artifact bytes always move
 * through `VaultContext` under the run owner's access context — never raw `fs`, and never inside
 * a step's result JSON, which carries metadata only.
 *
 * Declared now so handler signatures type check. Nothing implements this in slice 819-A.
 */
export interface WorkflowArtifactPort {
  write(input: {
    readonly workflowRunId: string;
    readonly stepRunId: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ artifactRef: string; sha256: string; sizeBytes: number }>;
  read(artifactRef: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

/**
 * What a task step's handler is given. `actorUserId` is always the run owner, never an arbitrary
 * caller, so every read the handler makes stays inside that user's RLS scope.
 *
 * V1 has no edge input-mapping language: whoever starts the run supplies bounded `runInput` and
 * initial `stepInput`, and a handler reads a predecessor's bounded result by step id through
 * `getStepResult()`.
 *
 * Declared now so handler signatures type check. Nothing implements this in slice 819-A.
 */
export interface WorkflowStepContext {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly workflowRunId: string;
  readonly stepRunId: string;
  readonly runInput: Record<string, unknown>;
  readonly stepInput: Record<string, unknown>;
  /** Bounded result of an earlier step in this run, or null if it has not produced one. */
  getStepResult(stepId: string): Promise<Record<string, unknown> | null>;
  readonly artifacts: WorkflowArtifactPort;
}

/**
 * A task step's code. The resolved object is the step's bounded result: it is persisted, and
 * `resultEquals` edges route on its shallow fields, so it holds small metadata — never private
 * content, secrets, or artifact bytes.
 */
export type WorkflowStepHandler = (
  context: WorkflowStepContext
) => Promise<Record<string, unknown>>;

/**
 * What an approval step shows the person deciding. Deliberately minimal in v1 — a summary line
 * plus optional shallow scalar details. Approval persistence and the approval UI are later slices.
 */
export interface WorkflowApprovalSpec {
  readonly summary: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/** Per-step retry policy. Validated at boot: 1..MAX_WORKFLOW_STEP_ATTEMPTS inclusive. */
export interface WorkflowStepRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
  readonly backoff?: WorkflowBackoffStrategy;
}

/**
 * When an edge is followed. These four shapes are the whole routing language in v1 — anything
 * else is rejected at boot. `resultEquals` reads one shallow field of the from-step's bounded
 * result, which is also how an approval step's `{ status: "approved" | "denied" }` routes.
 */
export type WorkflowEdgeCondition =
  | { readonly type: "always" }
  | { readonly type: "onSuccess" }
  | { readonly type: "onFailure" }
  | {
      readonly type: "resultEquals";
      /** Shallow key in the from-step's bounded result metadata. Not a path expression. */
      readonly field: string;
      readonly equals: string | number | boolean | null;
    };

/** A directed edge between two steps of the same workflow. */
export interface WorkflowEdgeDefinition {
  readonly from: string;
  readonly to: string;
  readonly condition: WorkflowEdgeCondition;
}

/**
 * One step. `handler` is required for `kind: "task"` and forbidden for `kind: "approval"`;
 * `approval` is required for `kind: "approval"`. The types cannot express that pairing, so the
 * boot validator enforces it.
 */
export interface WorkflowStepDefinition {
  readonly id: string;
  readonly kind: WorkflowStepKind;
  readonly retry?: WorkflowStepRetryPolicy;
  readonly timeoutMs?: number;
  readonly handler?: WorkflowStepHandler;
  readonly approval?: WorkflowApprovalSpec;
}

/**
 * A whole workflow, as declared on a built-in module's manifest.
 *
 * `id` must be prefixed with the declaring module's own id and a dot, and must be unique across
 * every module — a workflow id is a global name, so an unprefixed one would let two modules
 * collide. `version` is a positive integer that a module bumps when it changes the graph, so a
 * later slice's worker can tell which shape a stored run was started against.
 *
 * Note there is no queue name here, and there never will be: queue naming stays with the host, and
 * the validator rejects a definition that tries to carry one.
 */
export interface ModuleWorkflowDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly version: number;
  readonly startStepId: string;
  readonly trigger: WorkflowTrigger;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly edges: readonly WorkflowEdgeDefinition[];
}
