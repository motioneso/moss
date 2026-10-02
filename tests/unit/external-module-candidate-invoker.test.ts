// tests/unit/external-module-candidate-invoker.test.ts
//
// QA follow-up on PR 2898 (#2882): drives the REAL candidate invoker in
// apps/api/src/external-module-tools.ts and asserts the hook is built at read risk. The
// production code picks "read" for candidate hooks on purpose; if that literal is changed to a
// tool's own risk, this test fails.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalModuleDiscovery } from "@moss/module-registry";
import type * as ModuleRegistryNode from "@moss/module-registry/node";
import { validateExternalModuleManifest } from "@moss/module-registry/node";

// Intercept the RPC handler factory so the test can read the risk the real invoker passes it.
vi.mock("@moss/module-registry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof ModuleRegistryNode>();
  return {
    ...actual,
    createExternalModuleRpcHandler: vi.fn(() => async () => null)
  };
});

import { createExternalModuleRpcHandler } from "@moss/module-registry/node";
import { createExternalModuleTools } from "../../apps/api/src/external-module-tools.js";

const ACTOR = "00000000-0000-4000-8000-00000000000a";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

beforeEach(() => vi.mocked(createExternalModuleRpcHandler).mockClear());

function rawManifest() {
  return {
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    assistantTools: [
      {
        name: "demo.switch",
        permissionId: "demo.switch",
        description: "Switch a demo device.",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: { device: { type: "string" } },
          required: ["device"]
        },
        outputSchema: { type: "object", properties: { name: { type: "string" } } },
        handler: "demo.run",
        classifier: {
          description: "Switch a demo device",
          arguments: { device: { kind: "candidates" } },
          candidatesHandler: "demo.candidates",
          replyTemplate: "Switched {name}."
        }
      }
    ]
  };
}

/** A worker whose candidate hook answers directly; it makes no host RPC, so the stub rpc is unused. */
async function fixture(): Promise<ExternalModuleDiscovery> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-candidate-invoker-"));
  dirs.push(dir);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "dist", "worker.js"),
    `let buffer = "";
process.stdin.setEncoding("utf8");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ jsonrpc: "2.0", method: "worker.ready", params: { version: 1 } });
process.stdin.on("data", chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method !== "module.invoke") continue;
    const { handler, input } = m.params;
    if (handler === "demo.candidates") {
      send({ jsonrpc: "2.0", id: m.id, result: [{ id: input.actorUserId, label: "seen" }] });
    }
  }
});`
  );
  const validated = validateExternalModuleManifest(rawManifest(), "demo", "0.1.0");
  if (!validated.ok) throw new Error(validated.errors.join(", "));
  return {
    id: "demo",
    dir,
    manifest: validated.manifest,
    manifestHash: "sha256:demo",
    packageHash: "sha256:demo"
  };
}

describe("external candidate invoker read-only setting (#2882)", () => {
  it("builds the candidate hook's RPC handler at read risk, scoped to the actor", async () => {
    const discovery = await fixture();
    const tools = createExternalModuleTools({
      discoveries: () => [discovery],
      workerDataContext: {} as never,
      appDataContext: {
        withDataContext: async (_a: unknown, fn: (db: never) => unknown) => fn({} as never)
      } as never,
      settingsRepository: { getUserById: async () => null } as never,
      logger: { warn: () => {} }
    });

    const [manifest] = tools.getManifests();
    const provider = manifest?.assistantTools?.[0]?.classifier?.candidates;
    expect(provider).toBeDefined();

    const raw = await provider!(null, { actorUserId: ACTOR, requestId: "req-qa" } as never, {
      signal: new AbortController().signal
    });
    // The real invoker ran the worker and returned its answer.
    expect(raw).toEqual([{ id: ACTOR, label: "seen" }]);

    // And it built the RPC handler at read risk for this actor, not at the tool's own risk.
    const rpcInput = vi.mocked(createExternalModuleRpcHandler).mock.calls.at(-1)?.[0];
    expect(rpcInput).toMatchObject({
      toolRisk: "read",
      actorUserId: ACTOR,
      requestId: "req-qa"
    });

    await tools.runtime?.close();
  });
});
