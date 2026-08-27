// #2012 (slice 819-A). These rules are the whole point of the slice: a workflow definition is
// developer-written TypeScript that the platform will later hand to a worker, so a graph with a
// cycle, a dangling edge or an unbounded retry has to stop the API and worker from starting rather
// than fail halfway through someone's run. Every negative case below is a definition that a
// *missing* rule would happily accept, so dropping a rule turns "throws" into "returns" and fails
// here directly. The happy path guards the opposite mistake -- a rule so strict nothing valid
// survives it.
//
// Fake registrations are built in this file on purpose. Asserting against the real BUILT_IN_MODULES
// list would make these tests pass or fail for reasons that have nothing to do with the validator.
import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_STEP_ATTEMPTS,
  type ModuleWorkflowDefinition,
  type MossModuleManifest,
  type WorkflowStepDefinition,
  type WorkflowStepHandler
} from "@moss/module-sdk";
import {
  buildWorkflowRegistry,
  validateModuleWorkflows
} from "../../packages/module-registry/src/workflow-registry.js";

const handler: WorkflowStepHandler = async () => ({ status: "ok" });

function task(id: string, extra: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return { id, kind: "task", handler, ...extra };
}

function approvalStep(id: string): WorkflowStepDefinition {
  return { id, kind: "approval", approval: { summary: `Approve ${id}?` } };
}

/** A minimal workflow that passes every rule, so each case can break exactly one thing. */
function validDefinition(
  overrides: Partial<ModuleWorkflowDefinition> = {}
): ModuleWorkflowDefinition {
  return {
    id: "wellness.checkin",
    displayName: "Check-in",
    version: 1,
    startStepId: "draft",
    trigger: "manual",
    steps: [task("draft"), task("send")],
    edges: [{ from: "draft", to: "send", condition: { type: "onSuccess" } }],
    ...overrides
  };
}

function registration(moduleId: string, ...workflows: readonly ModuleWorkflowDefinition[]) {
  return { manifest: { id: moduleId, workflows } as unknown as MossModuleManifest };
}

/** Every rule failure has to name the module, the workflow and the rule, so tests can act on it. */
function expectRuleFailure(
  run: () => void,
  expected: { readonly moduleId: string; readonly workflowId: string; readonly rule: string }
): void {
  let message: string | undefined;
  try {
    run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, "expected the validator to throw, but it accepted the definition").toBeDefined();
  expect(message).toContain(`"${expected.moduleId}"`);
  expect(message).toContain(`"${expected.workflowId}"`);
  expect(message).toContain(`"${expected.rule}"`);
}

describe("validateModuleWorkflows — identity rules", () => {
  it("rejects the same workflow id declared by two different modules", () => {
    // A workflow id is a global name. Two modules owning one id means a later worker cannot tell
    // whose code to run.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", validDefinition({ id: "wellness.shared" })),
          registration("food", validDefinition({ id: "wellness.shared" }))
        ]),
      { moduleId: "food", workflowId: "wellness.shared", rule: "duplicate-workflow-id" }
    );
  });

  it("rejects the same workflow id declared twice inside one module", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({ id: "wellness.checkin" }),
            validDefinition({ id: "wellness.checkin" })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "duplicate-workflow-id" }
    );
  });

  it("rejects a workflow id that is not prefixed with its own module id", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", validDefinition({ id: "food.checkin" }))
        ]),
      { moduleId: "wellness", workflowId: "food.checkin", rule: "workflow-id-prefix" }
    );
  });

  it("rejects an id that merely starts with the module id but has no dot after it", () => {
    // "wellnessy.thing" starts with "wellness" as a string, which a naive prefix check accepts.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", validDefinition({ id: "wellnessy.thing" }))
        ]),
      { moduleId: "wellness", workflowId: "wellnessy.thing", rule: "workflow-id-prefix" }
    );
  });

  it("rejects a version of zero", () => {
    expectRuleFailure(
      () => validateModuleWorkflows([registration("wellness", validDefinition({ version: 0 }))]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "workflow-version" }
    );
  });

  it("rejects a fractional version", () => {
    expectRuleFailure(
      () => validateModuleWorkflows([registration("wellness", validDefinition({ version: 1.5 }))]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "workflow-version" }
    );
  });
});

describe("validateModuleWorkflows — graph rules", () => {
  it("rejects a workflow with no steps at all", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", validDefinition({ steps: [], edges: [] }))
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "steps-empty" }
    );
  });

  it("rejects two steps sharing an id", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({ steps: [task("draft"), task("draft")], edges: [] })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "duplicate-step-id" }
    );
  });

  it("rejects a startStepId that names no step", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", validDefinition({ startStepId: "nowhere" }))
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "start-step" }
    );
  });

  it("rejects an edge pointing at a step that does not exist", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              edges: [{ from: "draft", to: "ghost", condition: { type: "always" } }]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "edge-endpoint" }
    );
  });

  it("rejects an edge coming from a step that does not exist", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              edges: [
                { from: "draft", to: "send", condition: { type: "always" } },
                { from: "ghost", to: "send", condition: { type: "always" } }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "edge-endpoint" }
    );
  });

  it("rejects a step that cannot be reached from the start", () => {
    // Dead code in a graph is worse than dead code in a file: it looks live in the definition and
    // silently never runs.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft"), task("send"), task("orphan")],
              edges: [{ from: "draft", to: "send", condition: { type: "onSuccess" } }]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "unreachable-step" }
    );
  });

  it("rejects a two-step cycle", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft"), task("send")],
              edges: [
                { from: "draft", to: "send", condition: { type: "onSuccess" } },
                { from: "send", to: "draft", condition: { type: "onFailure" } }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "cycle" }
    );
  });

  it("rejects a three-step cycle", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft"), task("check"), task("send")],
              edges: [
                { from: "draft", to: "check", condition: { type: "onSuccess" } },
                { from: "check", to: "send", condition: { type: "onSuccess" } },
                { from: "send", to: "check", condition: { type: "onFailure" } }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "cycle" }
    );
  });

  it("accepts a diamond where two branches rejoin at one step", () => {
    // A rejoin is not a cycle. A cycle check that flags any second visit would reject every
    // workflow with a common ending, which is most of them.
    expect(() =>
      validateModuleWorkflows([
        registration(
          "wellness",
          validDefinition({
            steps: [task("draft"), task("left"), task("right"), task("finish")],
            edges: [
              { from: "draft", to: "left", condition: { type: "onSuccess" } },
              { from: "draft", to: "right", condition: { type: "onFailure" } },
              { from: "left", to: "finish", condition: { type: "always" } },
              { from: "right", to: "finish", condition: { type: "always" } }
            ]
          })
        )
      ])
    ).not.toThrow();
  });

  it("rejects a step that loops straight back to itself", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft")],
              startStepId: "draft",
              edges: [{ from: "draft", to: "draft", condition: { type: "onFailure" } }]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "cycle" }
    );
  });
});

describe("validateModuleWorkflows — step rules", () => {
  it("rejects a retry policy allowing zero attempts", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft", { retry: { maxAttempts: 0 } }), task("send")]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "retry-policy" }
    );
  });

  it("rejects a retry policy above the published cap", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [
                task("draft", { retry: { maxAttempts: MAX_WORKFLOW_STEP_ATTEMPTS + 1 } }),
                task("send")
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "retry-policy" }
    );
  });

  it("rejects a backoff delay that is not a positive number", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft", { retry: { maxAttempts: 2, backoffMs: 0 } }), task("send")]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "retry-policy" }
    );
  });

  it("accepts a retry policy exactly at the cap", () => {
    // The off-by-one that would otherwise make the published cap unusable.
    expect(() =>
      validateModuleWorkflows([
        registration(
          "wellness",
          validDefinition({
            steps: [
              task("draft", { retry: { maxAttempts: MAX_WORKFLOW_STEP_ATTEMPTS } }),
              task("send")
            ]
          })
        )
      ])
    ).not.toThrow();
  });

  it("rejects a task step with no handler", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [{ id: "draft", kind: "task" }, task("send")]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "step-handler" }
    );
  });

  it("rejects an approval step that also carries a handler", () => {
    // An approval waits for a person. Code attached to it would run behind their back.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [
                task("draft"),
                { id: "review", kind: "approval", approval: { summary: "ok?" }, handler },
                task("send")
              ],
              edges: [
                { from: "draft", to: "review", condition: { type: "onSuccess" } },
                { from: "review", to: "send", condition: { type: "always" } }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "step-handler" }
    );
  });

  it("rejects an approval step with no approval spec", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft"), { id: "review", kind: "approval" }, task("send")],
              edges: [
                { from: "draft", to: "review", condition: { type: "onSuccess" } },
                { from: "review", to: "send", condition: { type: "always" } }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "step-approval" }
    );
  });

  it("rejects an approval step with nowhere to go afterwards", () => {
    // The whole point of asking is that the answer routes somewhere. A task step may end a
    // workflow; an approval that ends one has asked a question nobody acts on.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [task("draft"), approvalStep("review")],
              edges: [{ from: "draft", to: "review", condition: { type: "onSuccess" } }]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "approval-terminal" }
    );
  });

  it("accepts a task step that ends the workflow", () => {
    expect(() =>
      validateModuleWorkflows([registration("wellness", validDefinition())])
    ).not.toThrow();
  });
});

describe("validateModuleWorkflows — condition and queue rules", () => {
  it("rejects an edge condition that is not one of the four allowed shapes", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              edges: [
                {
                  from: "draft",
                  to: "send",
                  condition: { type: "whenever" }
                } as unknown as ModuleWorkflowDefinition["edges"][number]
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "edge-condition" }
    );
  });

  it("rejects a resultEquals edge with no field to compare", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              edges: [
                {
                  from: "draft",
                  to: "send",
                  condition: { type: "resultEquals", field: "", equals: "ok" }
                }
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "edge-condition" }
    );
  });

  it("rejects a resultEquals edge matching against a non-scalar value", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              edges: [
                {
                  from: "draft",
                  to: "send",
                  condition: { type: "resultEquals", field: "status", equals: { deep: true } }
                } as unknown as ModuleWorkflowDefinition["edges"][number]
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "edge-condition" }
    );
  });

  it("rejects a workflow that tries to name its own queue", () => {
    // The types have no such field, but a plain JavaScript module can still pass one, and queue
    // naming belongs to the host -- assertModuleRegistryConsistency already polices that namespace.
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration("wellness", {
            ...validDefinition(),
            queue: "wellness.workflow"
          } as unknown as ModuleWorkflowDefinition)
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "queue-name" }
    );
  });

  it("rejects a step that tries to name its own queue", () => {
    expectRuleFailure(
      () =>
        validateModuleWorkflows([
          registration(
            "wellness",
            validDefinition({
              steps: [
                {
                  ...task("draft"),
                  queueName: "wellness.step"
                } as unknown as WorkflowStepDefinition,
                task("send")
              ]
            })
          )
        ]),
      { moduleId: "wellness", workflowId: "wellness.checkin", rule: "queue-name" }
    );
  });
});

describe("buildWorkflowRegistry", () => {
  /** A genuinely non-trivial valid workflow: both step kinds, a failure branch and two answers. */
  const realistic: ModuleWorkflowDefinition = {
    id: "wellness.checkin-followup",
    displayName: "Check-in follow-up",
    version: 2,
    startStepId: "draft",
    trigger: "manual",
    steps: [
      task("draft", { retry: { maxAttempts: 3, backoffMs: 500, backoff: "exponential" } }),
      task("recover"),
      approvalStep("review"),
      task("send"),
      task("log-denial")
    ],
    edges: [
      { from: "draft", to: "review", condition: { type: "onSuccess" } },
      { from: "draft", to: "recover", condition: { type: "onFailure" } },
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

  it("accepts a realistic workflow with an approval, a failure branch and two answers", () => {
    expect(() => validateModuleWorkflows([registration("wellness", realistic)])).not.toThrow();
  });

  it("keys each validated workflow by its id and remembers which module owns it", () => {
    const registry = buildWorkflowRegistry([registration("wellness", realistic)]);
    expect(registry.get("wellness.checkin-followup")).toMatchObject({
      moduleId: "wellness",
      definition: { id: "wellness.checkin-followup", version: 2 }
    });
  });

  it("returns an empty lookup when no module declares a workflow", () => {
    // Expected after this slice: nothing declares one yet.
    expect(buildWorkflowRegistry([registration("wellness")]).size).toBe(0);
    expect(
      buildWorkflowRegistry([{ manifest: { id: "wellness" } as MossModuleManifest }]).size
    ).toBe(0);
  });

  it("refuses to build a registry at all when any definition is invalid", () => {
    // The spec's "invalid definitions must never silently disappear from the registry": a broken
    // definition takes the process down rather than quietly going missing.
    expect(() =>
      buildWorkflowRegistry([
        registration("wellness", realistic),
        registration("food", validDefinition({ id: "food.broken", startStepId: "nowhere" }))
      ])
    ).toThrow(/"start-step"/);
  });
});
