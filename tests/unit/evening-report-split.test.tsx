import { describe, expect, it } from "vitest";

import { splitEveningReport } from "../../apps/web/src/today/evening-report.js";

const AI_REPORT = `The proposal is out. **Tomorrow** has room for the rest.

## What got done
You protected the morning for the proposal, and it paid off.

- Partnership proposal sent to Alex
- Project scope agreed

## What slipped
The dentist call moved again.

## Carrying forward
One decision for you. One thing Moss is watching.
- Reply to Sam

## Needs your attention
Nothing urgent.

## Tomorrow
One morning appointment.

## News & sports
A quiet day.

What was the win today?
What matters tomorrow?`;

describe("splitEveningReport", () => {
  it("gives each Today slot a different part of the report", () => {
    const parts = splitEveningReport(AI_REPORT);
    expect(parts).toEqual({
      verdict: "The proposal is out. **Tomorrow** has room for the rest.",
      recap: "You protected the morning for the proposal, and it paid off.",
      openLoops: "One decision for you. One thing Moss is watching."
    });
  });

  it("reads bold section lines the way it reads markdown headings", () => {
    const parts = splitEveningReport(
      "A good day.\n\n**What got done:**\nThe **review** landed.\n\n**Carrying forward**\nTwo small things."
    );
    expect(parts).toEqual({
      verdict: "A good day.",
      recap: "The review landed.",
      openLoops: "Two small things."
    });
  });

  it("leaves the recap and open-loops slots empty when a section is only a list", () => {
    const fallback = [
      "Evening wrap-up (sources listed without narrative — AI synthesis unavailable).",
      "What got done\n- Sent the proposal",
      "What slipped\n- (none today)",
      "Carrying forward\n- Reply to Sam"
    ].join("\n\n");
    expect(splitEveningReport(fallback)).toEqual({
      verdict: "Evening wrap-up (sources listed without narrative — AI synthesis unavailable).",
      recap: "",
      openLoops: ""
    });
  });

  it("keeps a report without sections as the verdict only", () => {
    expect(splitEveningReport("Done today. Carrying one thing forward.")).toEqual({
      verdict: "Done today. Carrying one thing forward.",
      recap: "",
      openLoops: ""
    });
  });

  it("keeps a section name that sits alone inside a paragraph as prose", () => {
    const parts = splitEveningReport(
      "A long day. The planning session moved to\nTomorrow\nafter lunch.\n\nWhat got done\nThe draft went out."
    );
    expect(parts.verdict).toBe("A long day. The planning session moved to\nTomorrow\nafter lunch.");
    expect(parts.recap).toBe("The draft went out.");
  });

  it("reads a bold heading with the colon after the bold marks", () => {
    const parts = splitEveningReport(
      "A good day.\n\n**What got done**:\nThe review landed.\n\n__Carrying forward__:\nTwo small things."
    );
    expect(parts.recap).toBe("The review landed.");
    expect(parts.openLoops).toBe("Two small things.");
  });
});
