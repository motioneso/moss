import { describe, it, expect } from "vitest";
import {
  resolveModuleBuildsDir,
  resolveBuildSourceDir
} from "../../packages/module-registry/src/external/resolve-build-dir.js";

describe("resolveModuleBuildsDir", () => {
  it("resolves the module builds directory beside, not inside, the modules directory", () => {
    const dir = resolveModuleBuildsDir({});
    expect(dir.endsWith("/data/module-builds")).toBe(true);
  });
});

describe("resolveBuildSourceDir", () => {
  it("rejects a build id that would escape the builds directory", () => {
    expect(() => resolveBuildSourceDir("/data/module-builds", "../../etc")).toThrow();
  });

  it("resolves a well-formed build id to a subdirectory", () => {
    expect(resolveBuildSourceDir("/data/module-builds", "videos-a1b2")).toBe(
      "/data/module-builds/videos-a1b2"
    );
  });
});
