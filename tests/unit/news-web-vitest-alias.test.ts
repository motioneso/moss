import { describe, expect, it } from "vitest";

import newsWebContribution from "@moss/news/web";

describe("News web Vitest alias", () => {
  it("resolves the package web entry without a per-test mock", () => {
    expect(newsWebContribution.moduleId).toBe("news");
    expect(newsWebContribution.routes?.[0]?.path).toBe("/news");
  });
});
