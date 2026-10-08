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

it("offers the same settings recovery for provider failure and unavailable models", () => {
  expect(summaryGenerationFailure("meeting_output_provider_failed")).toEqual({
    status: "failed",
    message:
      "Your model couldn’t complete the summary. Check its connection and try again. No other model was used.",
    remediation: summaryGenerationFailure("meeting_output_route_unavailable").remediation
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
