import { describe, expect, it } from "vitest";

import type { WorkshopFeedEntry } from "@moss/shared";
import { workshopTranscript } from "../../packages/workshop/src/web/project-pages.js";

const opening = "Save the ideas I want to revisit";

function entry(overrides: Partial<WorkshopFeedEntry> & { readonly messageId: string }): WorkshopFeedEntry {
  return {
    projectId: "a0000000-0000-4000-8000-000000000001",
    sequence: "1",
    kind: "user_message",
    delivery: "delivered",
    text: "A saved message",
    createdAt: "2026-09-05T12:00:00.000Z",
    ...overrides
  };
}

describe("workshop transcript mapping", () => {
  it("turns the opening request plus two entries into three records in order", () => {
    const records = workshopTranscript({ initialRequest: opening }, [
      entry({ messageId: "m1", text: "Keep this requirement" }),
      entry({ messageId: "m2", kind: "assistant_message", text: "Saved it." })
    ]);
    expect(records).toEqual([
      { kind: "user", text: opening },
      { kind: "user", text: "Keep this requirement", messageId: "m1" },
      { kind: "reply", text: "Saved it.", messageId: "m2" }
    ]);
  });

  it("renders the opening request alone when no messages are saved yet", () => {
    expect(workshopTranscript({ initialRequest: opening }, [])).toEqual([
      { kind: "user", text: opening }
    ]);
  });
});
