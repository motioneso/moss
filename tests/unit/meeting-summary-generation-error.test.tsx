import { expect, it } from "vitest";
import { meetingsModuleManifest } from "@moss/meetings";
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

it.each([
  [
    "meeting_output_isolation_failed",
    "Moss couldn’t write this summary because Claude didn’t accept the settings that keep your meeting private. Your transcript and notes are kept; try Rewrite summary later."
  ],
  [
    "meeting_output_runner_offline",
    "Moss couldn’t write this summary because it couldn’t reach Claude. Your transcript and notes are kept; try Rewrite summary once it’s back."
  ],
  [
    "meeting_output_route_unavailable",
    "Moss couldn’t write this summary because no AI is chosen for summaries yet. Your transcript and notes are kept; try Rewrite summary after one is chosen."
  ]
])("shows the exact wording for %s and nothing else", (code, message) => {
  expect(summaryGenerationFailure(code)).toEqual({
    status: "failed",
    message,
    remediation: "ai-settings"
  });
});

it.each([undefined, "meeting_output_generation_failed", "private-provider-answer"])(
  "keeps catch-all guidance plain and independent of the failure text: %s",
  (code) => {
    expect(summaryGenerationFailure(code)).toEqual({
      status: "failed",
      message:
        "The summary could not be generated. Try again when you’re ready. No other model was used."
    });
  }
);

it("keeps the catch-all screen message aligned with the app map", () => {
  const error = meetingsModuleManifest.features
    .map((feature) => feature.errors ?? [])
    .flat()
    .find((error) => error.code === "meeting_output_generation_failed");
  expect(error?.description).toBe(summaryGenerationFailure().message);
});
