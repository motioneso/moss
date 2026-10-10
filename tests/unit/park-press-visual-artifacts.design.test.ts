import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureVisualArtifact } from "../e2e/visual-artifacts.js";

afterEach(() => vi.unstubAllEnvs());

describe("optional Park Press visual artifacts", () => {
  it.each([undefined, ""])("does not capture without an output directory: %s", async (value) => {
    vi.stubEnv("MOSS_VISUAL_ARTIFACT_DIR", value);
    const screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
    await captureVisualArtifact({ screenshot }, "finance-settings.png");
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("retains the exact filename and full-page capture in review mode", async () => {
    vi.stubEnv("MOSS_VISUAL_ARTIFACT_DIR", "test-results/park-press");
    const screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
    await captureVisualArtifact({ screenshot }, "finance-settings-390-light.png");
    expect(screenshot).toHaveBeenCalledExactlyOnceWith({
      path: join("test-results/park-press", "finance-settings-390-light.png"),
      fullPage: true
    });
  });

  it("surfaces an opted-in capture failure instead of claiming an artifact exists", async () => {
    vi.stubEnv("MOSS_VISUAL_ARTIFACT_DIR", "test-results/park-press");
    const failure = new Error("Synthetic artifact write failure");
    const screenshot = vi.fn().mockRejectedValue(failure);
    await expect(captureVisualArtifact({ screenshot }, "meeting.png")).rejects.toBe(failure);
  });
});
