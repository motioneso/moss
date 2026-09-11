import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAppMap, writeAppMap } from "../../scripts/build-app-map.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("buildAppMap", () => {
  it("harvests declarations, preserves narrative separation, and stamps the build", () => {
    const artifact = buildAppMap({
      manifests: [
        {
          id: "fixture",
          name: "Fixture",
          version: "1.0.0",
          publisher: "jarv1s",
          lifecycle: "required",
          compatibility: { jarv1s: ">=0.0.0" },
          navigation: [
            { id: "fixture", label: "Fixture", description: "Fixture screen.", path: "/fixture" }
          ]
        }
      ],
      coreErrors: [
        {
          code: "core.test.denied",
          class: "permission",
          remediationRef: "core.test.ask",
          description: "The test action was not approved."
        }
      ],
      coreRemediations: [
        {
          id: "core.test.ask",
          description: "Ask the user to approve the test action.",
          path: "/",
          scope: "user"
        }
      ],
      coreScreens: [],
      coreSettings: [],
      version: "2.3.4",
      buildId: "abcdef123456",
      narrative: "human-written release note"
    });
    expect(artifact.build).toEqual({ version: "2.3.4", buildId: "abcdef123456" });
    expect(artifact.screens[0]).toMatchObject({ moduleId: "fixture", id: "fixture" });
    expect(artifact.errors[0]).toMatchObject({ moduleId: "core", code: "core.test.denied" });
    expect(artifact.remediations[0]).toMatchObject({ moduleId: "core", id: "core.test.ask" });
    expect(artifact.narrative).toEqual({
      authoritative: false,
      markdown: "human-written release note"
    });
  });

  it("writes data outside the source tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-map-"));
    dirs.push(dir);
    const output = join(dir, "app-map.json");
    writeAppMap(output, {
      manifests: [],
      coreScreens: [],
      coreSettings: [],
      version: "development",
      buildId: "development",
      narrative: ""
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });
});
