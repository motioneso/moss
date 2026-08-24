import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SportsBrowserBroker,
  SportsBrowserBrokerServer
} from "../../packages/sports/src/source/browser-broker.js";
import { SportsBrowserClient } from "../../packages/sports/src/source/browser-client.js";
import { SportsBrowserSidecar } from "../../packages/sports/src/source/browser-sidecar.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("SportsBrowserSidecar", () => {
  it("renders a FotMob-shaped page using only brokered document and XHR requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-sports-browser-"));
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    const brokerSocketPath = join(directory, "broker.sock");
    const rendererSocketPath = join(directory, "renderer.sock");
    const fixture = await readFile(
      new URL("../fixtures/sports/fotmob-shaped.html", import.meta.url),
      "utf8"
    );
    const fetched: Array<{ method: string; resourceType: string; url: string }> = [];
    const broker = new SportsBrowserBroker({
      fetch: async (url, options) => {
        await options.beforeRequest({
          url: new URL(url),
          address: "93.184.216.34",
          family: 4,
          method: options.method,
          redirectCount: 0
        });
        const resourceType = url.includes("/api/team-news") ? "fetch" : "document";
        fetched.push({ method: options.method, resourceType, url });
        const body = Buffer.from(
          url.includes("/api/team-news") ? '{"title":"Liverpool team news"}' : fixture
        );
        return {
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: resourceType === "document" ? "text/html" : "application/json",
          body,
          truncated: false,
          bytesRead: body.byteLength
        };
      }
    });
    const brokerServer = new SportsBrowserBrokerServer({ broker, socketPath: brokerSocketPath });
    await brokerServer.start();
    cleanup.push(async () => brokerServer.stop());

    const sidecar = new SportsBrowserSidecar({ brokerSocketPath, socketPath: rendererSocketPath });
    await sidecar.start();
    cleanup.push(async () => sidecar.stop());

    const client = new SportsBrowserClient({ broker, socketPath: rendererSocketPath });
    const result = await client.render({
      url: "https://publisher.example/teams/8650/liverpool",
      allowedHosts: ["publisher.example"]
    });

    expect(result).toMatchObject({
      ok: true,
      finalUrl: "https://publisher.example/teams/8650/liverpool"
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.domHtml).toContain("Liverpool team news");
    expect(result.domHtml).toContain('data-webrtc="undefined"');
    expect(fetched).toEqual([
      {
        method: "GET",
        resourceType: "document",
        url: "https://publisher.example/teams/8650/liverpool"
      },
      {
        method: "GET",
        resourceType: "fetch",
        url: "https://publisher.example/api/team-news?id=8650"
      }
    ]);
    expect(result.evidence.map(({ resourceType }) => resourceType)).toEqual(["document", "fetch"]);
  }, 30_000);
});
