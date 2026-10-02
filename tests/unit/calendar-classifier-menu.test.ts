import { describe, expect, it } from "vitest";

import { calendarModuleManifest } from "@moss/calendar";

import {
  gateEligibilityProblem,
  planArguments,
  renderReplyTemplate,
  type GateTool
} from "../../packages/chat/src/live/classifier-gate-arguments.js";

// Classifier gate plan 2.3 (#2883). This proves the declaration survives the loaded-menu path the
// gate consumes, without the production wiring that slice 3.5 owns: the real manifest tool becomes
// an eligible menu entry for a choice-only classifier and its reply renders from the result.

function calendarGateTool(): GateTool {
  const tool = calendarModuleManifest.assistantTools?.find(
    (t) => t.name === "calendar.listVisibleEvents"
  );
  if (!tool) throw new Error("calendar.listVisibleEvents is not declared");
  return {
    moduleId: calendarModuleManifest.id,
    moduleDescription: calendarModuleManifest.name,
    name: tool.name,
    risk: tool.risk,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    classifier: tool.classifier
  };
}

describe("calendar.listVisibleEvents on the classifier menu", () => {
  it("is eligible for a choice-only classifier (no typed extraction needed)", () => {
    // Returns null (eligible) rather than "not_declared" or "needs_typed_extraction".
    expect(gateEligibilityProblem(calendarGateTool(), "choice_only")).toBeNull();
  });

  it("asks for exactly one optional enum argument, the window", () => {
    const plan = planArguments(calendarGateTool());
    expect(plan).toEqual([{ name: "window", kind: "enum", required: false }]);
  });

  it("renders its reply from the code-written summary the handler returns", () => {
    const tool = calendarGateTool();
    expect(
      renderReplyTemplate(tool.classifier!.replyTemplate, { summary: "2 events today." })
    ).toBe("2 events today.");
  });

  it("declines (null reply) when a truncated result omits the summary", () => {
    const tool = calendarGateTool();
    // The gate turns a null reply into a decline, so the message falls back to the main model.
    expect(
      renderReplyTemplate(tool.classifier!.replyTemplate, { events: [], accounts: [], gaps: [] })
    ).toBeNull();
  });
});
