import { describe, expect, it } from "vitest";

import { composeBriefing } from "../../packages/briefings/src/compose.js";
import { definition, fakeScopedDb, makeFakeDeps, runInput } from "./briefings-compose.harness.js";

describe("composeBriefing — goals provenance", () => {
  it("saves the goals count so the reader can name the goals contribution", async () => {
    const deps = makeFakeDeps();
    const result = await composeBriefing(
      fakeScopedDb,
      definition({
        selected_tool_names: [
          "commitments.listVisible",
          "tasks.list",
          "calendar.listVisibleEvents",
          "email.listVisibleMessages",
          "vault",
          "chat.listTodaysTurns",
          "goals.list"
        ]
      }),
      runInput,
      deps
    );
    expect(result.sourceMetadata.goalsCount).toBe(2);
  });
});
