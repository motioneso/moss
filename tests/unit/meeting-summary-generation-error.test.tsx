import { expect, it } from "vitest";
import { summaryGenerationFailure } from "../../packages/meetings/src/web/summary-generation-error.js";

it("names an unsupported Claude subscription without suggesting a silent replacement", () => {
  expect(summaryGenerationFailure("meeting_output_claude_subscription_unsupported")).toEqual({
    status: "failed",
    message: "Summaries on this Claude subscription aren’t supported yet. No other model was used."
  });
});

it("explains a stopped deadline without exposing implementation details", () => {
  expect(summaryGenerationFailure("meeting_output_timed_out")).toEqual({
    status: "failed",
    message: "The summary took too long and was stopped. Try again when you’re ready."
  });
});
