import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Sports renderer image release", () => {
  it("builds both architectures and only publishes the renderer from main", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).toContain("renderer_tags=ghcr.io/motioneso/moss-sports-renderer:edge");
    expect(workflow).toContain("renderer_tags=ghcr.io/motioneso/moss-sports-renderer:pr-");
    expect(workflow).toMatch(
      /name: Build \(and push on main\) Sports renderer image[\s\S]*?file: \.\/Dockerfile\.sports-renderer[\s\S]*?platforms: linux\/amd64,linux\/arm64[\s\S]*?push: \$\{\{ steps\.tags\.outputs\.push == 'true' \}\}[\s\S]*?tags: \$\{\{ steps\.tags\.outputs\.renderer_tags \}\}/
    );
  });
});
