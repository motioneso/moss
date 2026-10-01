import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyCliVersionTooOld,
  setCliVersionTooOldListener
} from "../../packages/chat/src/live/cli-version-errors.js";

afterEach(() => setCliVersionTooOldListener(undefined));

describe("too-old listener", () => {
  it("runs the registered listener when a turn is refused", () => {
    const run = vi.fn();
    setCliVersionTooOldListener(run);
    notifyCliVersionTooOld();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no listener is registered", () => {
    expect(() => notifyCliVersionTooOld()).not.toThrow();
  });

  it("never lets a failing listener mask the refusal", () => {
    setCliVersionTooOldListener(() => {
      throw new Error("boom");
    });
    expect(() => notifyCliVersionTooOld()).not.toThrow();
  });
});
