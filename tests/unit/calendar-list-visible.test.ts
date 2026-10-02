import { describe, expect, it } from "vitest";

import { checkClassifierEligibility } from "@moss/module-sdk";
import { calendarModuleManifest } from "@moss/calendar";

describe("calendar.listVisibleEvents manifest", () => {
  it("inputSchema includes optional startsAfter, startsBefore, limit", () => {
    const tool = calendarModuleManifest.assistantTools?.find(
      (t) => t.name === "calendar.listVisibleEvents"
    );
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("startsAfter");
    expect(props).toHaveProperty("startsBefore");
    expect(props).toHaveProperty("limit");
  });

  it("declares a choice-only classifier window and a complete reply contract", () => {
    const tool = calendarModuleManifest.assistantTools?.find(
      (t) => t.name === "calendar.listVisibleEvents"
    );
    expect(tool).toBeDefined();

    // The declaration is complete: no missing required argument, no unknown template field.
    expect(
      checkClassifierEligibility({
        name: tool!.name,
        inputSchema: tool!.inputSchema,
        outputSchema: tool!.outputSchema,
        classifier: tool!.classifier
      })
    ).toEqual({ eligible: true });

    const schema = tool!.inputSchema as unknown as {
      properties: Record<string, { enum?: unknown }>;
      required?: readonly string[];
    };
    // The classifier may pick today/tomorrow and nothing else; ISO instants and the limit stay out.
    expect(schema.properties.window?.enum).toEqual(["today", "tomorrow"]);
    expect(schema.required ?? []).not.toContain("window");
    const classifier = tool!.classifier as
      | { arguments?: unknown; replyTemplate?: unknown }
      | undefined;
    expect(classifier?.arguments).toEqual({ window: { kind: "enum" } });
    expect(classifier?.replyTemplate).toBe("{summary}");
  });
});
