import { createServer, type Server } from "node:http";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SportsBrowserBroker } from "../../packages/sports/src/source/browser-broker.js";
import { SportsBrowserClient } from "../../packages/sports/src/source/browser-client.js";
import { parseBrowserRenderBody } from "../../packages/sports/src/source/browser-protocol.js";

const servers: Server[] = [];
const brokers: SportsBrowserBroker[] = [];

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
  for (const broker of brokers) broker.dispose();
  brokers.length = 0;
});

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

describe("SportsBrowserClient", () => {
  it("completes the API-owned job and fails soft when the renderer disconnects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moss-sports-browser-"));
    const socketPath = join(directory, "renderer.sock");
    let disconnect = false;
    let receivedJobId: string | undefined;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const parsed = parseBrowserRenderBody(Buffer.concat(chunks));
      if (!parsed.ok) throw new Error(parsed.reason);
      receivedJobId = parsed.value.jobId;
      if (disconnect) {
        request.socket.destroy();
        return;
      }
      const body = Buffer.from(
        JSON.stringify({
          ok: true,
          jobId: parsed.value.jobId,
          finalUrl: parsed.value.url,
          domHtml: "<main>News</main>"
        })
      );
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": body.byteLength
      });
      response.end(body);
    });
    servers.push(server);
    await listen(server, socketPath);

    const broker = new SportsBrowserBroker({
      fetch: async () => ({ ok: false, reason: "network" })
    });
    brokers.push(broker);
    const client = new SportsBrowserClient({ broker, socketPath });
    await expect(
      client.render({
        url: "https://publisher.example/news",
        allowedHosts: ["publisher.example"]
      })
    ).resolves.toEqual({
      ok: true,
      finalUrl: "https://publisher.example/news",
      domHtml: "<main>News</main>",
      evidence: []
    });
    expect(receivedJobId).toBeDefined();
    expect(broker.hasJob(receivedJobId!)).toBe(false);

    disconnect = true;
    await expect(
      client.render({
        url: "https://publisher.example/news",
        allowedHosts: ["publisher.example"]
      })
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
    expect(receivedJobId).toBeDefined();
    expect(broker.hasJob(receivedJobId!)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.length = 0;
    await unlink(socketPath).catch(() => undefined);
    await expect(
      client.render({
        url: "https://publisher.example/news",
        allowedHosts: ["publisher.example"]
      })
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
  });
});
