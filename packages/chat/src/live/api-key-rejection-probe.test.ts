import { describe, expect, it, vi } from "vitest";

import { apiKeyRejectionProbe } from "./api-key-rejection-probe.js";

const credential = { baseUrl: "http://127.0.0.1:5190", apiKey: "test-key", model: "m" };

function fetchAnswering(status: number) {
  return vi.fn(async () => new Response("{}", { status }));
}

describe("apiKeyRejectionProbe", () => {
  it.each([401, 403])("reports a refused key when the provider answers %i", async (status) => {
    const fetcher = fetchAnswering(status);
    await expect(apiKeyRejectionProbe("anthropic", credential, fetcher)()).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([200, 500])("does not blame the key when the provider answers %i", async (status) => {
    const probe = apiKeyRejectionProbe("openai-compatible", credential, fetchAnswering(status));
    await expect(probe()).resolves.toBe(false);
  });

  it("does not blame the key when the provider cannot be reached", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(apiKeyRejectionProbe("anthropic", credential, fetcher)()).resolves.toBe(false);
  });

  it("asks the stored address with a time limit", async () => {
    const fetcher = fetchAnswering(401);
    await apiKeyRejectionProbe("anthropic", credential, fetcher)();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:5190/v1/models");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never asks for a provider kind that has no API-key chat", async () => {
    const fetcher = fetchAnswering(401);
    await expect(apiKeyRejectionProbe("google", credential, fetcher)()).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
