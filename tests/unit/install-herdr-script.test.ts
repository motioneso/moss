import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("scripts/install-herdr.sh", () => {
  it("pins both per-arch release artifacts with their SHA-256 and uses set -euo pipefail", async () => {
    const script = await readFile(
      new URL("../../scripts/install-herdr.sh", import.meta.url),
      "utf8"
    );

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("herdr-linux-x86_64");
    expect(script).toContain("976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4");
    expect(script).toContain("herdr-linux-aarch64");
    expect(script).toContain("f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d");
    expect(script).toContain("v0.8.2");
    expect(script).toContain("herdrdev/herdr");
    expect(script).not.toMatch(/curl\s.*\|\s*sh/);
    expect(script).not.toMatch(/wget\s.*\|\s*sh/);
  });

  it("installs into the CLI tools prefix and is idempotent on a matching existing binary", async () => {
    const script = await readFile(
      new URL("../../scripts/install-herdr.sh", import.meta.url),
      "utf8"
    );

    expect(script).toContain("JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools");
    expect(script).toMatch(/sha256sum|shasum/);
    expect(script).toContain("chmod +x");
  });
});
