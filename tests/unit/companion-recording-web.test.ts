import { afterEach, describe, expect, it, vi } from "vitest";
import { decideRecordingCapability } from "../../apps/web/src/companion/recording-capability-client.js";
const decision = { attemptId: "specific-attempt", decision: "approve", policyVersion: 1 } as const;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("one-time recording approval retry", () => {
  it("honors Retry-After and sends exactly the same decision once the device lock clears", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(new Response('{"status":"approved","revision":2}'));
    vi.stubGlobal("fetch", fetch);
    const result = decideRecordingCapability(decision, () => true);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ status: "approved", revision: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[0]![1].body);
  });
  it("does not retry under a replaced signed-in owner", async () => {
    vi.useFakeTimers();
    let current = true;
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }));
    vi.stubGlobal("fetch", fetch);
    const result = decideRecordingCapability(decision, () => current).catch(
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(500);
    current = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toContain("session changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never shortens backoff that exceeds the bounded approval deadline", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 429, headers: { "Retry-After": "60" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(decideRecordingCapability(decision, () => true)).rejects.toMatchObject({
      status: 429
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("aborts a hanging approval at the deadline without reporting success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          )
      )
    );
    const result = decideRecordingCapability(decision, () => true).catch(
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toBe("aborted");
  });
});
