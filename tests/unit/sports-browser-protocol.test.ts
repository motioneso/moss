import { describe, expect, it } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseBrowserFetchBody,
  parseBrowserRenderBody,
  parseBrowserRenderResultBody,
  SPORTS_BROWSER_LIMITS
} from "../../packages/sports/src/source/browser-protocol.js";
import {
  SportsBrowserBroker,
  SportsBrowserBrokerServer
} from "../../packages/sports/src/source/browser-broker.js";

async function postJson(
  socketPath: string,
  body: Uint8Array
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/v1/fetch",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.byteLength
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

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

  it("accepts only bounded render results that echo the API job", () => {
    const valid = {
      ok: true,
      jobId: "018f47f0-4a64-7d31-a8f7-8d10c03a55bd",
      finalUrl: "https://publisher.example/news",
      domHtml: "<main>News</main>"
    } as const;
    expect(parseBrowserRenderResultBody(Buffer.from(JSON.stringify(valid)))).toEqual({
      ok: true,
      value: valid
    });
    expect(
      parseBrowserRenderResultBody(
        Buffer.from(JSON.stringify({ ...valid, capability: "abcdefghijklmnopqrstuv" }))
      )
    ).toEqual({ ok: false, reason: "invalid_message" });
    expect(
      parseBrowserRenderResultBody(new Uint8Array(SPORTS_BROWSER_LIMITS.maxRenderResultBytes + 1))
    ).toEqual({ ok: false, reason: "body_too_large" });
  });

  it("serves bounded binary fetches over HTTP/UDS and removes its socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-sports-broker-"));
    const socketPath = join(directory, "broker.sock");
    let fetchCalls = 0;
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        fetchCalls += 1;
        options.beforeRequest({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method,
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
    const server = new SportsBrowserBrokerServer({ broker, socketPath });
    await server.start();
    const control = broker.createJob({
      url: "https://publisher.example/news",
      allowedHosts: ["publisher.example"]
    });

    const response = await postJson(
      socketPath,
      Buffer.from(
        JSON.stringify({
          ...control,
          requestId: "request_1",
          method: "GET",
          resourceType: "fetch"
        })
      )
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["x-moss-sports-final-url"]).toBe(
      encodeURIComponent("https://publisher.example/news")
    );
    expect(response.body.toString("utf8")).toBe('{"items":[]}');
    expect(broker.hasJob(control.jobId)).toBe(true);

    const oversized = await postJson(
      socketPath,
      new Uint8Array(SPORTS_BROWSER_LIMITS.maxJsonBodyBytes + 1)
    );
    expect(oversized.status).toBe(413);
    expect(fetchCalls).toBe(1);

    await server.stop();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    broker.dispose();
  });
});
