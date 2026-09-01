import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { fetchOpenApiSpec, invokeOpenApiTool } from "@moss/integrations";
import type { OpenApiInvocation } from "@moss/integrations";

const SECRET = "sk-super-secret-value";

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

describe("invokeOpenApiTool", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("substitutes path params, sends query and header params, and applies the credential placement", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const started = await startServer((req, res) => {
      seenUrl = req.url ?? "";
      seenHeaders = req.headers as Record<string, string>;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: "Movie 7" }));
    });
    close = started.close;

    const invoke: OpenApiInvocation = {
      method: "GET",
      path: "/api/v3/movie/{id}",
      params: [
        { name: "id", in: "path" },
        { name: "page", in: "query" },
        { name: "X-Trace", in: "header" }
      ],
      hasBody: false
    };

    const result = await invokeOpenApiTool(
      started.baseUrl,
      invoke,
      { id: 7, page: 2, "X-Trace": "abc" },
      SECRET,
      { kind: "header", name: "X-Api-Key" }
    );

    expect(seenUrl).toBe("/api/v3/movie/7?page=2");
    expect(seenHeaders["x-trace"]).toBe("abc");
    expect(seenHeaders["x-api-key"]).toBe(SECRET);
    expect(result.ok).toBe(true);
    expect(result.data.result).toEqual({ title: "Movie 7" });
  });

  it("sends input.body as a JSON body with a JSON content-type", async () => {
    let seenBody = "";
    let seenContentType = "";
    const started = await startServer((req, res) => {
      seenContentType = req.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ created: true }));
      });
    });
    close = started.close;

    const invoke: OpenApiInvocation = {
      method: "POST",
      path: "/api/v3/movie",
      params: [],
      hasBody: true
    };

    const result = await invokeOpenApiTool(
      started.baseUrl,
      invoke,
      { body: { title: "New Movie" } },
      null,
      null
    );

    expect(seenContentType).toBe("application/json");
    expect(JSON.parse(seenBody)).toEqual({ title: "New Movie" });
    expect(result.data.result).toEqual({ created: true });
  });

  it("returns ok:false with the status on an HTTP error, without throwing", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    close = started.close;

    const invoke: OpenApiInvocation = {
      method: "GET",
      path: "/secret",
      params: [],
      hasBody: false
    };
    const result = await invokeOpenApiTool(started.baseUrl, invoke, {}, null, null);

    expect(result.ok).toBe(false);
    expect(result.data.status).toBe(401);
  });

  it("retries once and succeeds when the first attempt's socket is destroyed", async () => {
    let attempts = 0;
    const sockets = new Set<Socket>();
    const server = createServer((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.on("connection", (s) => sockets.add(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const invoke: OpenApiInvocation = { method: "GET", path: "/flaky", params: [], hasBody: false };
    const result = await invokeOpenApiTool(`http://127.0.0.1:${port}`, invoke, {}, null, null);

    expect(attempts).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.data.result).toEqual({ ok: true });
  });

  it("does not retry a POST that fails once, so a write is never run twice", async () => {
    let attempts = 0;
    const server = createServer((_req, res) => {
      attempts += 1;
      res.socket?.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const invoke: OpenApiInvocation = {
      method: "POST",
      path: "/create",
      params: [],
      hasBody: false
    };
    await expect(
      invokeOpenApiTool(`http://127.0.0.1:${port}`, invoke, {}, null, null)
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("throws when every attempt drops the connection", async () => {
    const server = createServer((_req, res) => {
      res.socket?.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const invoke: OpenApiInvocation = {
      method: "GET",
      path: "/always-drops",
      params: [],
      hasBody: false
    };
    await expect(
      invokeOpenApiTool(`http://127.0.0.1:${port}`, invoke, {}, null, null)
    ).rejects.toThrow();
  });

  it("never leaks the credential value into a thrown error message", async () => {
    const server = createServer((_req, res) => {
      res.socket?.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const invoke: OpenApiInvocation = {
      method: "GET",
      path: "/always-drops",
      params: [],
      hasBody: false
    };
    try {
      await invokeOpenApiTool(`http://127.0.0.1:${port}`, invoke, {}, SECRET, { kind: "bearer" });
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message ?? err)).not.toContain(SECRET);
      expect(String(err)).not.toContain(SECRET);
    }
  });
});

describe("fetchOpenApiSpec", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("throws a plain user error when the spec URL does not return JSON", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not json</html>");
    });
    close = started.close;

    await expect(fetchOpenApiSpec(started.baseUrl, null, null)).rejects.toThrow(
      "The spec URL must return JSON."
    );
  });

  it("returns the parsed JSON document and applies the credential", async () => {
    let seenAuth = "";
    const started = await startServer((req, res) => {
      seenAuth = req.headers.authorization ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ openapi: "3.0.0" }));
    });
    close = started.close;

    const doc = await fetchOpenApiSpec(started.baseUrl, SECRET, { kind: "bearer" });
    expect(doc).toEqual({ openapi: "3.0.0" });
    expect(seenAuth).toBe(`Bearer ${SECRET}`);
  });
});
