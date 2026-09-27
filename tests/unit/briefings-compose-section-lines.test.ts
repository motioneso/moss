import { describe, expect, it } from "vitest";

import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

describe("composeBriefing — section line counts", () => {
  it("saves the lines each section gave the prompt for the reader", async () => {
    const deps = makeFakeDeps();
    const result = await composeBriefing(fakeScopedDb, definition(), runInput, deps);
    const sectionLines = result.sourceMetadata.sectionLines as Record<string, number>;
    expect(sectionLines.tasks).toBeGreaterThan(0);
    expect(sectionLines.calendar).toBeGreaterThan(0);
    expect(sectionLines.email).toBeGreaterThan(0);
  });
});
