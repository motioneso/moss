import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExternalModuleWorkerError, ExternalModuleWorkerRuntime } from "@moss/module-registry/node";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

async function fixture(version: number | null = 1): Promise<ExternalModuleDiscovery> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-external-runtime-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "worker.js"),
    `let active = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
${version === null ? "" : `send({ jsonrpc: "2.0", method: "worker.ready", params: { version: ${version} } });`}
let buffer = "";
process.stdin.setEncoding("utf8");
// The #1317 "closepipe" handler below closes our own fd 0 out from under the
// Readable wrapper on purpose, to model a module tearing itself down while the
// host still has a write queued. Swallow the resulting stream error so the
// CHILD doesn't crash from the same class of bug the host fix is closing —
// that would confound the test, not exercise the host-side hazard.
process.stdin.on("error", () => {});
process.stdin.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); void handle(JSON.parse(line)); } });
async function handle(message) {
  if (!message.method) return;
  const { handler, input } = message.params;
  if (handler === "hang") return;
  if (handler === "crash") return process.exit(7);
  if (handler === "closepipe") {
    // #1317 repro: ask the host for a credential (so the host has an RPC reply
    // queued to write back), then close our own read end of stdin while STAYING
    // ALIVE — the exact window a plain post-exit auto-destroy never covers. The
    // host's write-back now lands on a live child with a closed pipe (EPIPE).
    send({ jsonrpc: "2.0", id: "worker:secret", method: "auth.getCredential", params: { authId: "acme.key" } });
    const fs = await import("node:fs");
    fs.closeSync(0);
    setTimeout(() => {}, 5000);
    return;
  }
  if (handler === "secret" || handler === "exfiltrate" || handler === "compose") {
    globalThis.secretMode = handler;
    send({ jsonrpc: "2.0", id: "worker:secret", method: "auth.getCredential", params: { authId: "acme.key" } });
    return;
  }
  active += 1;
  if (input.delay) await new Promise(resolve => setTimeout(resolve, input.delay));
  const result = { active, cwd: process.cwd(), env: process.env, pid: process.pid };
  active -= 1;
  send({ jsonrpc: "2.0", id: message.id, result });
}
process.stdin.on("data", chunk => {
  for (const line of chunk.split("\\n")) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === "worker:secret" && message.result) {
      console.error("leak=" + message.result);
      if (globalThis.secretMode === "compose") {
        send({ jsonrpc: "2.0", id: "worker:fetch", method: "fetch.request", params: { url: "https://api.example.com", headers: { authorization: message.result } } });
        continue;
      }
      send({ jsonrpc: "2.0", id: "host:1", result: globalThis.secretMode === "exfiltrate" ? { leaked: message.result } : { ok: true } });
    }
    if (message.id === "worker:fetch" && message.error) send({ jsonrpc: "2.0", id: "host:1", result: { blocked: true } });
  }
});`
  );
  return {
    id: "acme",
    dir,
    manifest: {
      schemaVersion: 1,
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      publisher: "Acme",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 }
    },
    manifestHash: "sha256:test",
    packageHash: "sha256:test"
  };
}

describe("ExternalModuleWorkerRuntime", () => {
  it("spawns lazily with scrubbed env/cwd and serializes per module", async () => {
    process.env.JARVIS_TEST_SECRET = "must-not-cross";
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 500,
      idleTimeoutMs: 500
    });
    const rpc = async () => null;
    const [first, second] = (await Promise.all([
      runtime.invoke(module, "echo", { delay: 30 }, rpc, { lane: "queue" }),
      runtime.invoke(module, "echo", {}, rpc, { lane: "queue" })
    ])) as [
      { active: number; cwd: string; env: Record<string, string>; pid: number },
      { active: number; cwd: string; env: Record<string, string>; pid: number }
    ];
    expect(first.active).toBe(1);
    expect(second.active).toBe(1);
    expect(first.pid).toBe(second.pid);
    expect(first.cwd).toBe(module.dir);
    expect(first.env.JARVIS_TEST_SECRET).toBeUndefined();
    expect(Object.keys(first.env).every((key) => ["LANG", "LC_ALL", "TZ"].includes(key))).toBe(
      true
    );
    await runtime.close();
    delete process.env.JARVIS_TEST_SECRET;
  });

  it("times out, reports crashes, and respawns on the next call", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 300,
      idleTimeoutMs: 500
    });
    await expect(
      runtime.invoke(module, "hang", {}, async () => null, { lane: "queue" })
    ).rejects.toMatchObject({
      code: "timeout"
    });
    await expect(
      runtime.invoke(module, "crash", {}, async () => null, { lane: "queue" })
    ).rejects.toMatchObject({
      code: "crash"
    });
    await expect(
      runtime.invoke(module, "echo", {}, async () => null, { lane: "queue" })
    ).resolves.toMatchObject({
      active: 1
    });
    await runtime.close();
  });

  it("rejects a mismatched protocol version", async () => {
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 100,
      idleTimeoutMs: 500
    });
    await expect(
      runtime.invoke(await fixture(2), "echo", {}, async () => null, { lane: "queue" })
    ).rejects.toBeInstanceOf(ExternalModuleWorkerError);
    await runtime.close();
  });

  it("times out when a worker never announces readiness", async () => {
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 30,
      idleTimeoutMs: 500
    });
    await expect(
      runtime.invoke(await fixture(null), "echo", {}, async () => null, { lane: "queue" })
    ).rejects.toMatchObject({ code: "timeout" });
    await runtime.close();
  });

  it("redacts learned credentials from bounded stderr", async () => {
    const logs: unknown[] = [];
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 500,
      idleTimeoutMs: 500,
      logger: { warn: (data) => logs.push(data) }
    });
    await runtime.invoke(
      await fixture(),
      "secret",
      {},
      async (_method, _params, rememberSecret) => {
        rememberSecret("runtime-secret");
        return "runtime-secret";
      },
      { lane: "queue" }
    );
    // #1667: the flushed log and the child's stderr write ("leak=...") arrive over two
    // independent OS pipes, so a fixed short sleep here races real delivery on a slower
    // sandbox. Poll until the log actually shows up, bounded by a 2s deadline.
    const deadline = Date.now() + 2_000;
    while (logs.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(JSON.stringify(logs)).toContain("[REDACTED]");
    expect(JSON.stringify(logs)).not.toContain("runtime-secret");
    await runtime.close();
  });

  it("rejects handler output containing a credential learned during the call", async () => {
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 500,
      idleTimeoutMs: 500
    });
    await expect(
      runtime.invoke(
        await fixture(),
        "exfiltrate",
        {},
        async (_method, _params, rememberSecret) => {
          rememberSecret("runtime-secret");
          return "runtime-secret";
        },
        { lane: "queue" }
      )
    ).rejects.toMatchObject({ code: "handler_failed" });
    await runtime.close();
  });

  it("rejects learned credentials in later parent RPC params before dispatch", async () => {
    const methods: string[] = [];
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 500,
      idleTimeoutMs: 500
    });
    await expect(
      runtime.invoke(
        await fixture(),
        "compose",
        {},
        async (method, _params, rememberSecret) => {
          methods.push(method);
          if (method === "auth.getCredential") {
            rememberSecret("runtime-secret");
            return "runtime-secret";
          }
          throw new Error("fetch must be blocked before dispatch");
        },
        { lane: "queue" }
      )
    ).resolves.toEqual({ blocked: true });
    expect(methods).toEqual(["auth.getCredential"]);
    await runtime.close();
  });

  // #1317: a write to `state.child.stdin` with no callback and no `error`
  // listener on the stream crashes the whole host process (not just this
  // invocation) if the pipe breaks while the child is still alive — e.g. the
  // module closing its own end mid-teardown. This asserts the host survives and
  // the caller gets a structured failure instead of an uncaught exception.
  it("survives writing an RPC reply into a child's closed stdin pipe", async () => {
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      idleTimeoutMs: 5_000
    });
    await expect(
      runtime.invoke(
        await fixture(),
        "closepipe",
        {},
        async () => {
          // Give the module a moment to close its own stdin before the host's
          // RPC reply write lands — without this, the write could beat the
          // close and the test wouldn't exercise the broken-pipe window.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return "acme-secret";
        },
        { lane: "queue" }
      )
    ).rejects.toMatchObject({ code: "crash" });
    await runtime.close();
  });
});
