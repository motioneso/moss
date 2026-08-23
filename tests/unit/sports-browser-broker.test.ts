import { afterEach, describe, expect, it, vi } from "vitest";

import { SportsBrowserBroker } from "../../packages/sports/src/source/browser-broker.js";

const brokers: SportsBrowserBroker[] = [];

afterEach(() => {
  for (const broker of brokers) broker.dispose();
  brokers.length = 0;
  vi.useRealTimers();
});

describe("SportsBrowserBroker", () => {
  it("keeps authority in the API job and revokes duplicate or mismatched capabilities", async () => {
    const fetches: Array<{ url: string; allowedHosts: readonly string[] | undefined }> = [];
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        fetches.push({ url, allowedHosts: options.allowedHosts });
        await options.beforeRequest?.({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method ?? "GET",
          redirectCount: 0
        });
        return {
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: new TextEncoder().encode('{"items":[]}'),
          truncated: false,
          bytesRead: 12
        };
      }
    });
    brokers.push(broker);
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example", "static.publisher.example"]
    });

    await expect(
      broker.fetch({
        ...control,
        requestId: "request_1",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toMatchObject({ ok: true, bytesRead: 12 });
    expect(fetches).toEqual([
      {
        url: "https://publisher.example/news",
        allowedHosts: ["publisher.example", "static.publisher.example"]
      }
    ]);
    expect(broker.hasJob(control.jobId)).toBe(true);

    await expect(
      broker.fetch({
        ...control,
        requestId: "request_1",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "protocol_violation" });
    expect(broker.hasJob(control.jobId)).toBe(false);

    const second = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });
    await expect(
      broker.fetch({
        ...second,
        capability: "zzzzzzzzzzzzzzzzzzzzzz",
        requestId: "request_2",
        method: "GET",
        resourceType: "fetch"
      })
    ).resolves.toEqual({ ok: false, reason: "unauthorized" });
    expect(broker.hasJob(second.jobId)).toBe(false);
  });
});
