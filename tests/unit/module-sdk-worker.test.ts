import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

const workerImport = JSON.stringify(
  pathToFileURL(join(process.cwd(), "packages/module-sdk/src/worker.ts")).href
);

async function spawnWorker(body: string): Promise<{
  child: ChildProcess;
  next: () => Promise<Record<string, unknown>>;
}> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-module-worker-"));
  dirs.push(dir);
  const entry = join(dir, "worker.mjs");
  await writeFile(entry, `import { defineModuleWorker } from ${workerImport};\n${body}`);
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const messages: unknown[] = [];
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const next = async () => {
    // #1667: bounded by wall-clock deadline, not attempt count -- a fixed
    // 200*5ms (~1s) budget was shorter than this sandbox's real child-process/tsx
    // cold start (measured ~1.3-1.5s), so the first message never arrived in time.
    const deadline = Date.now() + 5_000;
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (messages.length === 0) throw new Error("worker produced no protocol message");
    return messages.shift() as Record<string, unknown>;
  };
  return { child, next };
}

it("serves handlers and parent RPC through the worker contract", async () => {
  const { child, next } = await spawnWorker(
    `defineModuleWorker({ handlers: { lookup: async (ctx) => ({
  input: ctx.input,
  token: await ctx.auth.getCredential("acme.key"),
  fetched: await ctx.fetch({ url: "https://api.example.com/data" })
}) } });`
  );

  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "host:1", method: "module.invoke", params: { handler: "lookup", input: { q: 1 } } })}\n`
  );
  const credential = await next();
  expect(credential).toMatchObject({
    method: "auth.getCredential",
    params: { authId: "acme.key" }
  });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: credential.id, result: "secret" })}\n`
  );
  const fetchRequest = await next();
  expect(fetchRequest).toMatchObject({
    method: "fetch.request",
    params: { url: "https://api.example.com/data" }
  });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: fetchRequest.id, result: { status: 200, headers: { "content-type": "application/json" }, bodyBase64: "e30=" } })}\n`
  );
  expect(await next()).toMatchObject({
    id: "host:1",
    result: {
      input: { q: 1 },
      token: "secret",
      fetched: {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: "e30="
      }
    }
  });
  child.kill();
});

it("bridges ctx.ai.generateStructured over parent RPC and returns the result verbatim", async () => {
  const { child, next } = await spawnWorker(
    `defineModuleWorker({ handlers: { critique: async (ctx) => ({
  ai: await ctx.ai.generateStructured({ schema: { type: "object" }, prompt: "p" })
}) } });`
  );

  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "host:2", method: "module.invoke", params: { handler: "critique", input: {} } })}\n`
  );
  const aiCall = await next();
  expect(aiCall).toMatchObject({
    method: "ai.generateStructured",
    params: { schema: { type: "object" }, prompt: "p" }
  });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: aiCall.id, result: { ok: true, object: { summary: "s" } } })}\n`
  );
  expect(await next()).toMatchObject({
    id: "host:2",
    result: { ai: { ok: true, object: { summary: "s" } } }
  });
  child.kill();
});

it("exposes ctx.db.query as a db.query rpc round-trip", async () => {
  const { child, next } = await spawnWorker(
    `defineModuleWorker({
      handlers: {
        report: async (ctx) => ({
          withParams: await ctx.db.query("SELECT 1", [2]),
          withoutParams: await ctx.db.query("SELECT 2")
        })
      }
    });`
  );
  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "host:1",
      method: "module.invoke",
      params: { handler: "report", input: {} }
    })}\n`
  );
  const first = await next();
  // params omitted from the wire entirely when the caller passes none —
  // the host treats undefined and absent identically, but absent is smaller.
  expect(first).toMatchObject({ method: "db.query", params: { text: "SELECT 1", params: [2] } });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { rows: [{ one: 1 }] } })}\n`
  );
  const second = await next();
  expect(second).toMatchObject({ method: "db.query", params: { text: "SELECT 2" } });
  expect((second.params as { params?: unknown }).params).toBeUndefined();
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { rows: [{ two: 2 }] } })}\n`
  );
  expect(await next()).toMatchObject({
    id: "host:1",
    result: {
      withParams: { rows: [{ one: 1 }] },
      withoutParams: { rows: [{ two: 2 }] }
    }
  });
  child.kill();
});

it("exposes ctx.attachments.readText as an attachments.readText rpc round-trip (#1194)", async () => {
  const { child, next } = await spawnWorker(
    `defineModuleWorker({ handlers: { importResume: async (ctx) => ({
      attachment: await ctx.attachments.readText("11111111-1111-4111-8111-111111111111")
    }) } });`
  );

  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: "host:3", method: "module.invoke", params: { handler: "importResume", input: {} } })}\n`
  );
  const call = await next();
  expect(call).toMatchObject({
    method: "attachments.readText",
    params: { attachmentId: "11111111-1111-4111-8111-111111111111" }
  });
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { fileName: "resume.txt", mimeType: "text/plain", text: "hello" } })}\n`
  );
  expect(await next()).toMatchObject({
    id: "host:3",
    result: {
      attachment: { fileName: "resume.txt", mimeType: "text/plain", text: "hello" }
    }
  });
  child.kill();
});

it("surfaces host db.query errors as a generic handler_failed without leaking internals", async () => {
  const marker = `rpc-error-marker-${randomUUID()}`;
  const { child, next } = await spawnWorker(
    `defineModuleWorker({
      handlers: {
        leak: async (ctx) => ctx.db.query("SELECT secret FROM t")
      }
    });`
  );
  expect(await next()).toMatchObject({ method: "worker.ready", params: { version: 1 } });
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "host:1",
      method: "module.invoke",
      params: { handler: "leak", input: {} }
    })}\n`
  );
  const dbCall = await next();
  expect(dbCall).toMatchObject({ method: "db.query", params: { text: "SELECT secret FROM t" } });
  // Simulates a host-side query failure OR an older host that lacks db.query
  // (method-not-found) — either way the worker must not leak the error text
  // or the query text back to the module/host response.
  child.stdin?.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: dbCall.id,
      error: { code: -32601, message: marker }
    })}\n`
  );
  const final = await next();
  expect(final).toMatchObject({
    id: "host:1",
    error: { code: -32000, message: "handler_failed" }
  });
  const serialized = JSON.stringify(final);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("SELECT secret FROM t");
  child.kill();
});
