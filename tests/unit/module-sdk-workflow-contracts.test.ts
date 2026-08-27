// #2012 (slice 819-A). Slice 819-A ships no runtime behaviour in the SDK itself — only the shape a
// module author writes a workflow in. So what is worth asserting is that the shape is actually
// usable: a definition exercising both step kinds and all four edge conditions has to compile
// against the exported types, and the retry cap the validator polices has to be reachable from the
// public barrel. A missing or misnamed field fails this file at type-check time; a dropped cap
// constant fails it at run time.
import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_STEP_ATTEMPTS,
  type ModuleWorkflowDefinition,
  type WorkflowApprovalSpec,
  type WorkflowEdgeCondition,
  type WorkflowStepDefinition,
  type WorkflowStepHandler,
  type WorkflowStepRetryPolicy
} from "@moss/module-sdk";

const noopHandler: WorkflowStepHandler = async () => ({ status: "ok" });

const retry: WorkflowStepRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1_000,
  backoff: "exponential"
};

const approval: WorkflowApprovalSpec = {
  summary: "Send the drafted follow-up?",
  details: { recipientCount: 2, urgent: false, note: null }
};

const allConditions: readonly WorkflowEdgeCondition[] = [
  { type: "always" },
  { type: "onSuccess" },
  { type: "onFailure" },
  { type: "resultEquals", field: "status", equals: "approved" }
];

const steps: readonly WorkflowStepDefinition[] = [
  { id: "draft", kind: "task", handler: noopHandler, retry, timeoutMs: 30_000 },
  { id: "review", kind: "approval", approval },
  { id: "send", kind: "task", handler: noopHandler },
  { id: "log-denial", kind: "task", handler: noopHandler }
];

const definition: ModuleWorkflowDefinition = {
  id: "wellness.checkin-followup",
  displayName: "Check-in follow-up",
  version: 1,
  startStepId: "draft",
  trigger: "manual",
  steps,
  edges: [
    { from: "draft", to: "review", condition: { type: "onSuccess" } },
    {
      from: "review",
      to: "send",
      condition: { type: "resultEquals", field: "status", equals: "approved" }
    },
    {
      from: "review",
      to: "log-denial",
      condition: { type: "resultEquals", field: "status", equals: "denied" }
    }
  ]
};

describe("workflow definition contracts", () => {
  it("describes a real two-branch workflow with both step kinds", () => {
    expect(definition.steps.map((step) => step.kind)).toEqual(["task", "approval", "task", "task"]);
    // The approval branch is the reason `resultEquals` exists; without both edges a denial has
    // nowhere to go.
    expect(definition.edges.filter((edge) => edge.from === "review")).toHaveLength(2);
  });

  it("allows every routing condition the spec defines, and no bare condition loses its type tag", () => {
    expect(allConditions.map((condition) => condition.type)).toEqual([
      "always",
      "onSuccess",
      "onFailure",
      "resultEquals"
    ]);
  });

  it("lets a resultEquals edge match each allowed scalar, including null", () => {
    const scalars: readonly WorkflowEdgeCondition[] = [
      { type: "resultEquals", field: "status", equals: "denied" },
      { type: "resultEquals", field: "count", equals: 0 },
      { type: "resultEquals", field: "ok", equals: false },
      { type: "resultEquals", field: "reason", equals: null }
    ];
    expect(scalars).toHaveLength(4);
  });

  it("publishes the retry cap as a positive integer so the validator and callers agree on one number", () => {
    // The validator rejects maxAttempts above this. If the constant vanished or went to zero,
    // nothing would bound a retrying step.
    expect(Number.isInteger(MAX_WORKFLOW_STEP_ATTEMPTS)).toBe(true);
    expect(MAX_WORKFLOW_STEP_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });

  it("keeps a task step's handler resolving to a bounded result object", async () => {
    await expect(
      noopHandler({
        actorUserId: "user-1",
        requestId: "req-1",
        workflowRunId: "run-1",
        stepRunId: "step-run-1",
        runInput: {},
        stepInput: {},
        getStepResult: async () => null,
        artifacts: {
          write: async () => ({ artifactRef: "ref", sha256: "sha", sizeBytes: 0 }),
          read: async () => ({ bytes: new Uint8Array(), contentType: "text/plain" })
        }
      })
    ).resolves.toEqual({ status: "ok" });
  });
});
