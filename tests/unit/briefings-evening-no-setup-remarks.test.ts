import { describe, expect, it } from "vitest";

import { SYNTHESIS_INSTRUCTIONS_EVENING } from "../../packages/briefings/src/compose-evening.js";

describe("evening synthesis instructions", () => {
  it("forbids setup, account and data-quality remarks in the review", () => {
    expect(SYNTHESIS_INSTRUCTIONS_EVENING).toMatch(
      /never comment on the user's accounts, settings, setup or data quality/i
    );
  });

  it("keeps the reflection questions about today's items only", () => {
    expect(SYNTHESIS_INSTRUCTIONS_EVENING).toMatch(
      /reflection questions[^.]*never about setup or settings/i
    );
  });
});
