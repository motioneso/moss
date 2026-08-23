import { describe, expect, it } from "vitest";

import {
  parseBrowserFetchBody,
  parseBrowserRenderBody,
  SPORTS_BROWSER_LIMITS
} from "../../packages/sports/src/source/browser-protocol.js";

describe("Sports browser protocol", () => {
  it("accepts only the fixed bounded renderer fetch schema", () => {
    const valid = {
      jobId: "018f47f0-4a64-7d31-a8f7-8d10c03a55bd",
      requestId: "request_1",
      capability: "abcdefghijklmnopqrstuv",
      url: "https://publisher.example/news",
      method: "GET",
      resourceType: "fetch"
    } as const;

    expect(parseBrowserFetchBody(Buffer.from(JSON.stringify(valid)))).toEqual({
      ok: true,
      value: valid
    });

    const invalid = [
      { ...valid, capability: "shared-secret" },
      { ...valid, method: "POST" },
      { ...valid, url: "http://publisher.example/news" },
      { ...valid, resourceType: "websocket" },
      { ...valid, headers: { authorization: "secret" } },
      { ...valid, requestId: "x".repeat(SPORTS_BROWSER_LIMITS.maxRequestIdChars + 1) }
    ];
    for (const candidate of invalid) {
      expect(parseBrowserFetchBody(Buffer.from(JSON.stringify(candidate)))).toEqual({
        ok: false,
        reason: "invalid_message"
      });
    }

    expect(
      parseBrowserFetchBody(new Uint8Array(SPORTS_BROWSER_LIMITS.maxJsonBodyBytes + 1))
    ).toEqual({ ok: false, reason: "body_too_large" });
    expect(parseBrowserFetchBody(Buffer.from("not json"))).toEqual({
      ok: false,
      reason: "invalid_json"
    });
  });

  it("keeps host and budget authority out of the render control message", () => {
    const valid = {
      jobId: "018f47f0-4a64-7d31-a8f7-8d10c03a55bd",
      capability: "abcdefghijklmnopqrstuv",
      url: "https://publisher.example/news"
    } as const;

    expect(parseBrowserRenderBody(Buffer.from(JSON.stringify(valid)))).toEqual({
      ok: true,
      value: valid
    });
    for (const candidate of [
      { ...valid, hosts: ["attacker.example"] },
      { ...valid, maxRequests: 100 },
      { ...valid, deadlineMs: 60_000 },
      { ...valid, url: "http://publisher.example/news" }
    ]) {
      expect(parseBrowserRenderBody(Buffer.from(JSON.stringify(candidate)))).toEqual({
        ok: false,
        reason: "invalid_message"
      });
    }
  });
});
