import { describe, expect, it } from "vitest";
import { driveControls } from "./n3-worker-drive-controls.js";

describe("worker join", () => {
  it("passes every fake control", async () => {
    expect(await driveControls()).toBeGreaterThanOrEqual(10);
  });
});
