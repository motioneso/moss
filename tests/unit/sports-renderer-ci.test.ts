import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Sports renderer image release", () => {
  it("ships the renderer in the multi-architecture Moss image", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).not.toContain("moss-sports-renderer");
    expect(workflow).not.toContain("Dockerfile.sports-renderer");
    expect(workflow).toMatch(
      /name: Build and push Moss image[\s\S]*?file: \.\/Dockerfile[\s\S]*?platforms: \$\{\{ matrix\.platform \}\}[\s\S]*?push: true[\s\S]*?tags: ghcr\.io\/motioneso\/moss:edge-\$\{\{ matrix\.arch \}\}/
    );
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain("docker buildx imagetools create");
    expect(workflow).toContain("$IMAGE:edge-amd64");
    expect(workflow).toContain("$IMAGE:edge-arm64");
  });

  it("promotes only the provenance-verified Moss digest", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/release-image.yml", import.meta.url),
      "utf8"
    );

    expect(workflow).not.toContain("moss-sports-renderer");
    expect(workflow).not.toContain("RENDERER_IMAGE");
    expect(workflow.match(/promote "\$IMAGE" "\$EDGE_DIGEST" "\$VERSION_EXISTS"/g)).toHaveLength(1);
  });
});
