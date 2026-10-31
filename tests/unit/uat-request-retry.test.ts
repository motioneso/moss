import { afterEach, describe, expect, it, vi } from "vitest";
import { postWithRateLimitRetry } from "../uat/specs/uat-request-retry.js";
import { isModuleLoadFailure } from "../uat/specs/uat-page-load.js";

type RetryPage = Parameters<typeof postWithRateLimitRetry>[0];

const response = (status: number, headers: Record<string, string> = {}) => ({
  status: () => status,
  headers: () => headers
});

/** The helper only reads page.request.post, so no browser is involved. */
function fakePage(...responses: ReturnType<typeof response>[]) {
  const post = vi.fn(async () => responses.shift() ?? response(500));
  return { calls: post, page: { request: { post } } as unknown as RetryPage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("rate-limit retry on an idempotent UAT request", () => {
  it("returns the first response when it is not throttled", async () => {
    const fake = fakePage(response(204));
    const result = await postWithRateLimitRetry(
      fake.page,
      "/api/companion/recording-capability/revoke",
      { data: { deviceId: "d" } }
    );
    expect(result.status()).toBe(204);
    expect(fake.calls).toHaveBeenCalledTimes(1);
  });

  it("waits out the product's own throttle and returns the retried answer", async () => {
    vi.useFakeTimers();
    const fake = fakePage(response(429, { "retry-after": "2" }), response(204));
    const pending = postWithRateLimitRetry(
      fake.page,
      "/api/companion/recording-capability/revoke",
      {
        data: { deviceId: "d" }
      }
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.status()).toBe(204);
    expect(fake.calls).toHaveBeenCalledTimes(2);
  });

  it("sends the same request again, so the calling spec's status assertion still decides", async () => {
    vi.useFakeTimers();
    const fake = fakePage(response(429), response(429), response(429));
    const pending = postWithRateLimitRetry(fake.page, "/api/x", { data: { deviceId: "d" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status()).toBe(429);
    expect(fake.calls).toHaveBeenCalledTimes(3);
  });

  it("keeps its wait bounded when the throttle asks for longer than a minute", async () => {
    vi.useFakeTimers();
    const fake = fakePage(response(429, { "retry-after": "3600" }), response(204));
    const pending = postWithRateLimitRetry(fake.page, "/api/x", {});
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.calls).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status()).toBe(204);
  });
});

describe("module-load failure signature", () => {
  it.each([
    "Failed to fetch dynamically imported module: http://stack/assets/meetings.js",
    "Importing a module script failed."
  ])("recognises a bundle that failed to arrive: %s", (message) => {
    expect(isModuleLoadFailure([message])).toBe(true);
  });

  it.each([
    "TypeError: cannot read properties of undefined",
    "Error: 500 Internal Server Error",
    ""
  ])("does not treat a product error as a transport failure: %s", (message) => {
    expect(isModuleLoadFailure([message])).toBe(false);
  });
});
