import { describe, expect, it } from "vitest";

import { buildModuleBuildNotification } from "../../apps/worker/src/worker.js";

describe("buildModuleBuildNotification", () => {
  it("notifies the owner when a build finishes, pointing at the Workshop page", () => {
    const input = buildModuleBuildNotification("b-1", "finished");
    expect(input.title).toBe("Your module is ready for a look");
    expect(input.href).toBe("/workshop");
    expect(input.eventKey).toBe("module-build:b-1:finished");
  });

  it("notifies the owner with a different title when a build fails", () => {
    const input = buildModuleBuildNotification("b-1", "failed");
    expect(input.title).toBe("Your module build failed");
    expect(input.href).toBe("/workshop");
    expect(input.eventKey).toBe("module-build:b-1:failed");
  });

  it("uses a distinct event key per build so retries update the same notification, not a duplicate", () => {
    const first = buildModuleBuildNotification("b-1", "failed");
    const second = buildModuleBuildNotification("b-2", "failed");
    expect(first.eventKey).not.toBe(second.eventKey);
  });
});
