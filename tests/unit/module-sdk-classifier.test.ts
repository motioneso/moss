// Classifier gate plan task 2.1. A tool joins the classifier menu only through an explicit,
// complete declaration. The two guards that matter most are "absent means ineligible" and "an
// incomplete contract is rejected before listing", so each is asserted directly.
import { describe, expect, it } from "vitest";

import {
  CLASSIFIER_LIMITS,
  checkClassifierEligibility,
  normalizeClassifierCandidates,
  type ModuleAssistantToolClassifier,
  type ModuleAssistantToolManifest
} from "@moss/module-sdk";

function tool(
  overrides: Partial<ModuleAssistantToolManifest> & { classifier?: ModuleAssistantToolClassifier }
): ModuleAssistantToolManifest {
  return {
    name: "demo.setScene",
    description: "Set a scene",
    permissionId: "demo.use",
    risk: "write",
    inputSchema: {
      type: "object",
      properties: { scene: { type: "string", enum: ["movie", "reading"] } },
      required: ["scene"]
    },
    outputSchema: {
      type: "object",
      properties: { scene: { type: "string" }, count: { type: "integer" } }
    },
    ...overrides
  };
}

const enumDecl: ModuleAssistantToolClassifier = {
  description: "Switch the lights to a named scene.",
  replyTemplate: "Scene {scene} is on."
};

describe("checkClassifierEligibility", () => {
  it("treats a tool with no declaration as ineligible", () => {
    // Existing tools never declared one, so none may change behavior.
    expect(checkClassifierEligibility(tool({}))).toEqual({ eligible: false, problems: [] });
  });

  it("accepts an enum-only tool with no candidate hook", () => {
    expect(checkClassifierEligibility(tool({ classifier: enumDecl }))).toEqual({ eligible: true });
  });

  it("accepts a tool with a template that has no placeholders", () => {
    const t = tool({
      classifier: { ...enumDecl, replyTemplate: "Done." },
      outputSchema: undefined
    });
    expect(checkClassifierEligibility(t)).toEqual({ eligible: true });
  });

  it("accepts a typed-only argument declared as extract", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      },
      classifier: {
        ...enumDecl,
        replyTemplate: "Added {scene}.",
        arguments: { title: { kind: "extract" } }
      }
    });
    expect(checkClassifierEligibility(t)).toEqual({ eligible: true });
  });

  it("rejects a required argument that is neither an enum nor declared", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"]
      },
      classifier: enumDecl
    });
    const result = checkClassifierEligibility(t);
    expect(result.eligible).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining("title")] });
  });

  it("rejects a candidate argument with no candidate hook", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { light: { type: "string" } },
        required: ["light"]
      },
      classifier: { ...enumDecl, arguments: { light: { kind: "candidates" } } }
    });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });

  it("accepts a candidate argument that has a hook", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { light: { type: "string" } },
        required: ["light"]
      },
      classifier: {
        ...enumDecl,
        arguments: { light: { kind: "candidates" } },
        candidates: async () => [{ id: "a", label: "Kitchen" }]
      }
    });
    expect(checkClassifierEligibility(t)).toEqual({ eligible: true });
  });

  it("rejects an enum declaration for an argument whose schema has no enum", () => {
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { light: { type: "string" } },
        required: ["light"]
      },
      classifier: { ...enumDecl, arguments: { light: { kind: "enum" } } }
    });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });

  it("rejects a declaration for an argument the input schema does not have", () => {
    const t = tool({ classifier: { ...enumDecl, arguments: { ghost: { kind: "extract" } } } });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });

  it("rejects a template that names a field the result does not have", () => {
    const t = tool({ classifier: { ...enumDecl, replyTemplate: "Scene {nope} is on." } });
    const result = checkClassifierEligibility(t);
    expect(result.eligible).toBe(false);
    expect(result).toMatchObject({ problems: [expect.stringContaining("nope")] });
  });

  it("rejects a placeholder when the tool declares no output schema", () => {
    const t = tool({ classifier: enumDecl, outputSchema: undefined });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });

  it("rejects a placeholder that points at an object rather than a plain value", () => {
    const t = tool({
      outputSchema: { type: "object", properties: { item: { type: "object" } } },
      classifier: { ...enumDecl, replyTemplate: "Got {item}." }
    });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });

  it("resolves a dotted placeholder through nested result properties", () => {
    const t = tool({
      outputSchema: {
        type: "object",
        properties: { task: { type: "object", properties: { title: { type: "string" } } } }
      },
      classifier: { ...enumDecl, replyTemplate: "Added {task.title}." }
    });
    expect(checkClassifierEligibility(t)).toEqual({ eligible: true });
  });

  it("rejects empty, multi-line and over-long descriptions and templates", () => {
    for (const patch of [
      { description: "" },
      { description: "two\nlines" },
      { description: "x".repeat(CLASSIFIER_LIMITS.descriptionChars + 1) },
      { replyTemplate: "" },
      { replyTemplate: "x".repeat(CLASSIFIER_LIMITS.templateChars + 1) }
    ]) {
      expect(
        checkClassifierEligibility(tool({ classifier: { ...enumDecl, ...patch } })).eligible
      ).toBe(false);
    }
  });

  it("rejects an enum with more values than the menu bound", () => {
    const values = Array.from({ length: CLASSIFIER_LIMITS.candidates + 1 }, (_, i) => `v${i}`);
    const t = tool({
      inputSchema: {
        type: "object",
        properties: { scene: { type: "string", enum: values } },
        required: ["scene"]
      },
      classifier: enumDecl
    });
    expect(checkClassifierEligibility(t).eligible).toBe(false);
  });
});

describe("normalizeClassifierCandidates", () => {
  it("passes a bounded, well-formed list through", () => {
    expect(normalizeClassifierCandidates([{ id: "a", label: "Kitchen" }])).toEqual({
      ok: true,
      candidates: [{ id: "a", label: "Kitchen" }]
    });
  });

  it("rejects output over the candidate bound instead of truncating it", () => {
    // Truncating would silently hide devices from the menu.
    const many = Array.from({ length: CLASSIFIER_LIMITS.candidates + 1 }, (_, i) => ({
      id: `id${i}`,
      label: `L${i}`
    }));
    expect(normalizeClassifierCandidates(many).ok).toBe(false);
  });

  it("rejects a label over the length bound", () => {
    const long = { id: "a", label: "x".repeat(CLASSIFIER_LIMITS.labelChars + 1) };
    expect(normalizeClassifierCandidates([long]).ok).toBe(false);
  });

  it("rejects duplicate ids, empty ids and non-object entries", () => {
    expect(
      normalizeClassifierCandidates([
        { id: "a", label: "One" },
        { id: "a", label: "Two" }
      ]).ok
    ).toBe(false);
    expect(normalizeClassifierCandidates([{ id: "", label: "One" }]).ok).toBe(false);
    expect(normalizeClassifierCandidates(["nope"]).ok).toBe(false);
    expect(normalizeClassifierCandidates("nope").ok).toBe(false);
  });
});
