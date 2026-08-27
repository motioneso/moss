// #2012 (slice 819-A of epic #819): boot-time validation of developer-authored workflow
// definitions, plus the validated lookup a later slice's worker will read.
//
// Spec: docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md -> "Workflow Definition API".
//
// Two properties this file exists to guarantee:
//
//  1. A malformed definition stops the API and the worker from starting, rather than failing
//     halfway through a user's run. `assertModuleRegistryConsistency` calls into here and is
//     itself invoked at module load, so importing the registry throws before anything registers.
//  2. An invalid definition never silently disappears from the registry. There is no "skip the
//     bad one and carry on" path: the first breach throws.
//
// Definitions are treated as UNTRUSTED INPUT at run time, not merely type-checked input. A module
// authored in plain JavaScript, or one that casts, can hand over fields the TypeScript types
// forbid -- so every rule below re-checks shape at run time rather than trusting the declaration.

import {
  MAX_WORKFLOW_STEP_ATTEMPTS,
  type ModuleWorkflowDefinition,
  type MossModuleManifest,
  type WorkflowEdgeCondition,
  type WorkflowEdgeDefinition,
  type WorkflowStepDefinition
} from "@moss/module-sdk";

/** One validated workflow, and the module that declared it. */
export interface WorkflowRegistryEntry {
  readonly moduleId: string;
  readonly definition: ModuleWorkflowDefinition;
}

/** Validated workflows keyed by workflow id. Ids are globally unique, so the id is enough. */
export type WorkflowRegistry = ReadonlyMap<string, WorkflowRegistryEntry>;

/** The subset of a registration this validator reads. Keeps callers and tests free of the rest. */
export interface WorkflowRegistrationInput {
  readonly manifest: MossModuleManifest;
}

/**
 * Rule names are part of the contract: they appear verbatim in every thrown message so a test, a
 * log search or a future operator can act on the specific rule without matching English prose.
 */
type WorkflowRule =
  | "duplicate-workflow-id"
  | "workflow-id-prefix"
  | "workflow-version"
  | "steps-empty"
  | "duplicate-step-id"
  | "start-step"
  | "edge-endpoint"
  | "unreachable-step"
  | "cycle"
  | "retry-policy"
  | "step-handler"
  | "step-approval"
  | "approval-terminal"
  | "edge-condition"
  | "queue-name";

/**
 * Every failure names the module, the workflow and the rule. `detail` stays structural -- step and
 * edge ids only. It must never quote handler source, approval details, or any value that could
 * carry private data, because this message reaches boot logs.
 */
function workflowError(
  moduleId: string,
  workflowId: string,
  rule: WorkflowRule,
  detail: string
): Error {
  return new Error(
    `Module "${moduleId}" workflow "${workflowId}" failed rule "${rule}": ${detail}`
  );
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** True if the object carries a queue-naming property, whatever its declared type says. */
function declaresQueue(value: object): boolean {
  return "queue" in value || "queueName" in value;
}

function isScalarMatch(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** The four routing shapes are the whole language. Anything else is a definition error. */
function isValidEdgeCondition(condition: unknown): condition is WorkflowEdgeCondition {
  if (typeof condition !== "object" || condition === null) {
    return false;
  }
  const type = (condition as { type?: unknown }).type;
  if (type === "always" || type === "onSuccess" || type === "onFailure") {
    return true;
  }
  if (type !== "resultEquals") {
    return false;
  }
  const { field, equals } = condition as { field?: unknown; equals?: unknown };
  // A shallow key, not a path expression: an empty or non-string field can never match anything,
  // so it is a mistake rather than a no-op branch.
  return typeof field === "string" && field.length > 0 && isScalarMatch(equals);
}

function validateStep(
  moduleId: string,
  workflowId: string,
  step: WorkflowStepDefinition,
  outgoingCount: number
): void {
  if (declaresQueue(step)) {
    throw workflowError(
      moduleId,
      workflowId,
      "queue-name",
      `step "${step.id}" names a queue; queue naming belongs to the host`
    );
  }

  if (step.retry !== undefined) {
    const { maxAttempts, backoffMs } = step.retry;
    if (!isPositiveInteger(maxAttempts) || maxAttempts > MAX_WORKFLOW_STEP_ATTEMPTS) {
      throw workflowError(
        moduleId,
        workflowId,
        "retry-policy",
        `step "${step.id}" has maxAttempts outside 1..${MAX_WORKFLOW_STEP_ATTEMPTS}`
      );
    }
    if (
      backoffMs !== undefined &&
      (typeof backoffMs !== "number" || !Number.isFinite(backoffMs) || backoffMs <= 0)
    ) {
      throw workflowError(
        moduleId,
        workflowId,
        "retry-policy",
        `step "${step.id}" has a backoffMs that is not a positive number`
      );
    }
  }

  if (step.kind === "task") {
    if (typeof step.handler !== "function") {
      throw workflowError(
        moduleId,
        workflowId,
        "step-handler",
        `task step "${step.id}" has no handler`
      );
    }
    // A task step with no outgoing edges is an end point, which is allowed.
    return;
  }

  if (step.kind === "approval") {
    if (step.handler !== undefined) {
      throw workflowError(
        moduleId,
        workflowId,
        "step-handler",
        `approval step "${step.id}" must not carry a handler`
      );
    }
    if (step.approval === undefined) {
      throw workflowError(
        moduleId,
        workflowId,
        "step-approval",
        `approval step "${step.id}" has no approval spec`
      );
    }
    if (outgoingCount === 0) {
      // v1 has no terminal flag to lean on, so this is the concrete reading of the spec's
      // "every non-terminal task step has at least one outgoing edge": an approval that ends a
      // workflow has asked a person a question that routes nowhere.
      throw workflowError(
        moduleId,
        workflowId,
        "approval-terminal",
        `approval step "${step.id}" has no outgoing edge, so its answer routes nowhere`
      );
    }
    return;
  }

  throw workflowError(
    moduleId,
    workflowId,
    "step-handler",
    `step "${step.id}" has an unknown kind`
  );
}

/**
 * Depth-first walk from the start step. Returns every reachable step id, and throws on the first
 * cycle found. Iterative rather than recursive so a deep graph cannot blow the stack at boot.
 */
function walkGraph(
  moduleId: string,
  workflowId: string,
  startStepId: string,
  outgoing: ReadonlyMap<string, readonly string[]>
): ReadonlySet<string> {
  const reached = new Set<string>();
  // "onPath" is the current root-to-node path. A revisit of a node on that path is a cycle; a
  // revisit of a node already finished is just a diamond join, which is allowed.
  const onPath = new Set<string>();
  const stack: { readonly stepId: string; readonly entering: boolean }[] = [
    { stepId: startStepId, entering: true }
  ];

  while (stack.length > 0) {
    const frame = stack.pop();
    /* c8 ignore next 3 -- the loop guard already proves the stack is non-empty */
    if (frame === undefined) {
      break;
    }
    if (!frame.entering) {
      onPath.delete(frame.stepId);
      continue;
    }
    if (onPath.has(frame.stepId)) {
      throw workflowError(
        moduleId,
        workflowId,
        "cycle",
        `step "${frame.stepId}" is part of a cycle`
      );
    }
    if (reached.has(frame.stepId)) {
      continue;
    }
    reached.add(frame.stepId);
    onPath.add(frame.stepId);
    stack.push({ stepId: frame.stepId, entering: false });
    for (const next of outgoing.get(frame.stepId) ?? []) {
      stack.push({ stepId: next, entering: true });
    }
  }

  return reached;
}

function validateDefinition(
  moduleId: string,
  definition: ModuleWorkflowDefinition,
  seenWorkflowIds: Map<string, string>
): void {
  const workflowId = definition.id;

  const previousOwner = seenWorkflowIds.get(workflowId);
  if (previousOwner !== undefined) {
    throw workflowError(
      moduleId,
      workflowId,
      "duplicate-workflow-id",
      `already declared by module "${previousOwner}"`
    );
  }
  seenWorkflowIds.set(workflowId, moduleId);

  // Prefix check needs the dot: a bare startsWith would let module "wellness" claim
  // "wellnessy.thing", which belongs to nobody.
  if (!workflowId.startsWith(`${moduleId}.`) || workflowId.length <= moduleId.length + 1) {
    throw workflowError(
      moduleId,
      workflowId,
      "workflow-id-prefix",
      `id must start with "${moduleId}." so workflow ids cannot collide across modules`
    );
  }

  if (!isPositiveInteger(definition.version)) {
    throw workflowError(
      moduleId,
      workflowId,
      "workflow-version",
      "version must be an integer of 1 or more"
    );
  }

  if (declaresQueue(definition)) {
    throw workflowError(
      moduleId,
      workflowId,
      "queue-name",
      "definition names a queue; queue naming belongs to the host"
    );
  }

  const steps: readonly WorkflowStepDefinition[] = definition.steps ?? [];
  if (steps.length === 0) {
    throw workflowError(moduleId, workflowId, "steps-empty", "a workflow needs at least one step");
  }

  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) {
      throw workflowError(
        moduleId,
        workflowId,
        "duplicate-step-id",
        `step "${step.id}" is declared more than once`
      );
    }
    stepIds.add(step.id);
  }

  if (!stepIds.has(definition.startStepId)) {
    throw workflowError(
      moduleId,
      workflowId,
      "start-step",
      `startStepId "${definition.startStepId}" names no step in this workflow`
    );
  }

  const edges: readonly WorkflowEdgeDefinition[] = definition.edges ?? [];
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
      const missing = stepIds.has(edge.from) ? edge.to : edge.from;
      throw workflowError(
        moduleId,
        workflowId,
        "edge-endpoint",
        `edge "${edge.from}" -> "${edge.to}" names step "${missing}", which does not exist`
      );
    }
    if (!isValidEdgeCondition(edge.condition)) {
      throw workflowError(
        moduleId,
        workflowId,
        "edge-condition",
        `edge "${edge.from}" -> "${edge.to}" has a condition that is not one of always, onSuccess, onFailure or resultEquals`
      );
    }
    const fromEdges = outgoing.get(edge.from);
    if (fromEdges === undefined) {
      outgoing.set(edge.from, [edge.to]);
    } else {
      fromEdges.push(edge.to);
    }
  }

  // Cycles first: an unreachable-step report on a cyclic graph would be the less useful of the two
  // messages, and the walk has to be cycle-safe anyway.
  const reachable = walkGraph(moduleId, workflowId, definition.startStepId, outgoing);

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      throw workflowError(
        moduleId,
        workflowId,
        "unreachable-step",
        `step "${step.id}" cannot be reached from "${definition.startStepId}"`
      );
    }
  }

  for (const step of steps) {
    validateStep(moduleId, workflowId, step, (outgoing.get(step.id) ?? []).length);
  }
}

/**
 * Throws on the first broken rule across every module's declared workflows. Call this before
 * anything registers routes or workers -- a bad definition should stop boot, not a running job.
 */
export function validateModuleWorkflows(registrations: readonly WorkflowRegistrationInput[]): void {
  const seenWorkflowIds = new Map<string, string>();
  for (const registration of registrations) {
    const moduleId = registration.manifest.id;
    for (const definition of registration.manifest.workflows ?? []) {
      validateDefinition(moduleId, definition, seenWorkflowIds);
    }
  }
}

/**
 * Validates, then returns the lookup keyed by workflow id. There is deliberately no partial
 * result: if any definition is invalid this throws rather than returning a registry missing it.
 */
export function buildWorkflowRegistry(
  registrations: readonly WorkflowRegistrationInput[]
): WorkflowRegistry {
  validateModuleWorkflows(registrations);

  const registry = new Map<string, WorkflowRegistryEntry>();
  for (const registration of registrations) {
    const moduleId = registration.manifest.id;
    for (const definition of registration.manifest.workflows ?? []) {
      registry.set(definition.id, { moduleId, definition });
    }
  }
  return registry;
}
