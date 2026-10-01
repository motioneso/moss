import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIEFING_RUN_DEADLINE_LABEL,
  BriefingRunDeadlineError,
  withRunDeadline
} from "../../packages/briefings/src/run-deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRunDeadline (#2671)", () => {
  it("fails with a fixed label when the work never finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = withRunDeadline(() => new Promise<string>(() => undefined), 1_000);
    const caught = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await caught;
    expect(error).toBeInstanceOf(BriefingRunDeadlineError);
    expect((error as Error).message).toBe(BRIEFING_RUN_DEADLINE_LABEL);
  });

  it("returns the work's value and leaves no timer behind when it finishes in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await expect(withRunDeadline(async () => "done", 1_000)).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the work's own failure through unchanged", async () => {
    const failure = new Error("model said no");
    await expect(
      withRunDeadline(async () => {
        throw failure;
      }, 1_000)
    ).rejects.toBe(failure);
  });

  it("swallows a failure that arrives after the deadline instead of leaving it unhandled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rejectLate: (reason: Error) => void = () => undefined;
    const outcome = withRunDeadline(
      () =>
        new Promise<string>((_, reject) => {
          rejectLate = reject;
        }),
      1_000
    );
    const caught = outcome.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await caught;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    rejectLate(new Error("late private detail"));
    await vi.advanceTimersByTimeAsync(10);
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
