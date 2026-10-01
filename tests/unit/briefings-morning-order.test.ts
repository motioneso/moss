import { describe, expect, it } from "vitest";

import { tidyMorningSections } from "../../packages/briefings/src/morning-order.js";

const TITLES = ["Dentist", "Project review"];

function text(...parts: string[]): string {
  return parts.join("\n\n");
}

describe("tidyMorningSections (#2775)", () => {
  it("moves a timed section ahead of an untimed one", () => {
    const input = text(
      "A busy day.",
      "Dentist at ten and errands.",
      "## Pick up the parcel",
      "Collect the parcel from the depot whenever you pass.",
      "## Get to the dentist for 10:00 AM",
      "Bring your insurance card."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out.indexOf("## Get to the dentist")).toBeLessThan(out.indexOf("## Pick up the parcel"));
    expect(out.startsWith("A busy day.\n\nDentist at ten and errands.\n\n")).toBe(true);
  });

  it("orders timed sections by clock time", () => {
    const input = text(
      "Headline.",
      "## Prepare for the 1:00 PM review",
      "Print the slides.",
      "## Leave for the 8:30 AM dentist",
      "Take the card."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out.indexOf("8:30 AM")).toBeLessThan(out.indexOf("1:00 PM"));
  });

  it("keeps News and Sports last", () => {
    const input = text(
      "Headline.",
      "## Sports: the Rovers won",
      "Rovers won 2-1.",
      "## Bring the slides to the 1:00 PM review",
      "Print them."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out.indexOf("## Bring")).toBeLessThan(out.indexOf("## Sports"));
  });

  it("drops a section that only restates an event title", () => {
    const input = text(
      "Headline.",
      "## Dentist at 10:00 AM",
      "The Dentist is scheduled at 10:00 AM.",
      "## Pack the bag",
      "Bring the gym kit."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out).not.toContain("## Dentist");
    expect(out).toContain("## Pack the bag");
  });

  it("keeps a section that says more than the title", () => {
    const input = text(
      "Headline.",
      "## Dentist at 10:00 AM",
      "The Dentist is scheduled, so bring your insurance card."
    );
    expect(tidyMorningSections(input, TITLES)).toBe(input);
  });

  it("leaves text without section headings alone", () => {
    expect(tidyMorningSections("synth narrative", TITLES)).toBe("synth narrative");
  });

  it("reads the start of a time range, and the times a real model wrote", () => {
    const input = text(
      "Headline.",
      "## Choose a time for the remaining tasks",
      "Water the plants.",
      "## Get ready for the review",
      "The review runs 5:22-6:22 PM in Room 4.",
      "## Cook dinner",
      "Dinner is at 6:00 PM."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out.indexOf("## Get ready")).toBeLessThan(out.indexOf("## Cook dinner"));
    expect(out.indexOf("## Cook dinner")).toBeLessThan(out.indexOf("## Choose a time"));
  });

  it("reads a range ending at noon as starting in the morning", () => {
    const input = text(
      "Headline.",
      "## Prepare lunch",
      "Lunch is at 11:30 AM.",
      "## Attend the workshop",
      "The workshop runs 11-12 PM."
    );
    const out = tidyMorningSections(input, TITLES);
    expect(out.indexOf("## Attend the workshop")).toBeLessThan(out.indexOf("## Prepare lunch"));
  });
});
