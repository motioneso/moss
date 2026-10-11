process.env.TZ = "UTC";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beaconEndPrivateChat,
  endPrivateChat,
  listActionAuditLog,
  requestJson
} from "../../apps/web/src/api/client.js";
import { resolveRequestTimeZoneForRoute } from "../../packages/module-registry/src/index.js";

describe("web API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not send the browser timezone on central JSON requests (#3395)", async () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: vi.fn(() => ({
        resolvedOptions: () => ({ timeZone: "America/New_York" })
      }))
    });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await requestJson("/api/example");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("X-Timezone")).toBeNull();
  });

  it("posts the private chat end endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await endPrivateChat();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/private/end",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("uses sendBeacon for best-effort private chat unload cleanup", () => {
    const sendBeacon = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon });

    beaconEndPrivateChat();

    expect(sendBeacon).toHaveBeenCalledWith("/api/chat/private/end", "");
  });

  it("bounds action audit requests", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn<typeof fetch>((_input, init) => {
        requestSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const request = listActionAuditLog();
      const outcome = request.then(
        () => null,
        (error: unknown) => error
      );
      await Promise.resolve();
      expect(requestSignal).toBeInstanceOf(AbortSignal);

      await vi.advanceTimersByTimeAsync(3001);
      await expect(outcome).resolves.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("route timezone resolution (#3395)", () => {
  const accessContext = {
    actorUserId: "00000000-0000-4000-8000-000000000123",
    requestId: "req:test"
  };

  function runnerReturning(stored: unknown) {
    return {
      runner: { withDataContext: vi.fn(async (_ctx, work) => work("scoped")) },
      preferences: { get: vi.fn(async () => stored) }
    };
  }

  it("returns the person's saved zone", async () => {
    const { runner, preferences } = runnerReturning({ timezone: "Europe/London" });

    await expect(resolveRequestTimeZoneForRoute(accessContext, runner, preferences)).resolves.toBe(
      "Europe/London"
    );
    expect(preferences.get).toHaveBeenCalledWith("scoped", "locale");
  });

  it("returns the shared default zone, not UTC, when nothing is saved", async () => {
    const { runner, preferences } = runnerReturning(null);

    await expect(resolveRequestTimeZoneForRoute(accessContext, runner, preferences)).resolves.toBe(
      "America/Los_Angeles"
    );
  });

  it("returns the shared default zone when the saved zone is invalid", async () => {
    const { runner, preferences } = runnerReturning({ timezone: "Not/AZone" });

    await expect(resolveRequestTimeZoneForRoute(accessContext, runner, preferences)).resolves.toBe(
      "America/Los_Angeles"
    );
  });
});
