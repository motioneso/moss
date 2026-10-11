import { describe, expect, it } from "vitest";
import { buildAppMap } from "../../scripts/build-app-map.js";
import { newsModuleManifest } from "../../packages/news/src/manifest.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";

describe("audit feeds: truthful app map", () => {
  it("includes read/write recovery and carousel controls in the built map", () => {
    const map = buildAppMap({
      manifests: [newsModuleManifest, sportsModuleManifest],
      coreScreens: [],
      coreSettings: [],
      version: "test",
      buildId: "test",
      narrative: ""
    });
    expect(map.features.map((feature) => feature.id)).toEqual(
      expect.arrayContaining([
        "news.preference_recovery",
        "news.story_feedback_receipts",
        "sports.rotation_controls"
      ])
    );
    const errors = map.errors.filter(
      (error) =>
        error.code.startsWith("news.preference_recovery.") ||
        error.code.startsWith("news.story_feedback_receipts.")
    );
    expect(errors).toHaveLength(3);
    expect(
      errors.every((error) => error.class === "transient" && error.remediationRef === undefined)
    ).toBe(true);
    for (const id of [
      "news.preference_recovery.retry_reads",
      "news.preference_recovery.review_choices",
      "news.story_feedback_receipts.retry"
    ]) {
      expect(map.remediations.find((remediation) => remediation.id === id)?.path).toBe(
        "/settings?section=modules&module=news"
      );
    }
    expect(
      map.features.find((feature) => feature.id === "news.filtered_front_page")?.description
    ).toContain("Show all stories");
    expect(
      map.features.find((feature) => feature.id === "sports.rotation_controls")?.description
    ).toContain("without stopping score updates");
    expect(
      map.features.find((feature) => feature.id === "sports.refresh_trouble_notice")?.description
    ).toContain("Sports information is unavailable");
  });
});
