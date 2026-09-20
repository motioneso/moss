import { describe, expect, it } from "vitest";

import { assertEveningRenderedContract } from "../../tests/uat/visual-parity/evening-readiness.js";

describe("visual parity evening readiness", () => {
  it("requires the split headline in h1 and the remaining prose in the body", async () => {
    await expect(
      assertEveningRenderedContract("Done today. Carrying one thing forward.", {
        heading: "Done today.",
        body: "Carrying one thing forward."
      })
    ).resolves.toEqual({ headline: "Done today.", body: "Carrying one thing forward." });
    await expect(
      assertEveningRenderedContract("Done today. Carrying one thing forward.", {
        heading: "Done today.",
        body: "Unrelated visible summary."
      })
    ).rejects.toThrow("body does not match");
  });

  it("keeps the complete summary when splitHeadline has no remainder", async () => {
    await expect(
      assertEveningRenderedContract("A single evening sentence", {
        heading: "A single evening sentence",
        body: "A single evening sentence"
      })
    ).resolves.toEqual({
      headline: "A single evening sentence",
      body: "A single evening sentence"
    });
  });
});
