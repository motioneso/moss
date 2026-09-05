// Queue-path ctx.ai acceptance tests (JS-07 Step 0, spec D6 fold).
//
// tests/integration/module-worker-rpc.test.ts proves the rpc-host invariants
// with STUB ai callbacks; this suite proves them end-to-end on the queued-jobs
// path: the extracted worker job handler + the REAL worker ai bridge
// (@moss/ai generateStructured), exactly as composed in apps/worker.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Job } from "pg-boss";

import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { ExternalModuleJobPayload } from "@moss/jobs";
import { AI_CALLS_PER_INVOCATION_CAP } from "@moss/module-registry/node";
import { createModuleCredentialSecretCipher } from "@moss/settings";
import type { Kysely } from "kysely";

import { createModuleWorkerAiBridge } from "../../apps/worker/src/external-module-ai-bridge.js";
import { createExternalBriefingInvoker } from "../../apps/worker/src/external-module-invoke.js";
import {
  createExternalModuleJobHandler,
  type ExternalModuleJobHandlerDeps
} from "../../apps/worker/src/external-module-job-handler.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
// assertModuleJobPayload requires sha256:<64 hex>; the DB state row must carry
// the same value so the handler's enabled/hash gate passes.
const HASH = `sha256:${"a".repeat(64)}`;
const CREDENTIAL_SECRET = "queue-ai-runtime-secret";

let bootstrap: pg.Client;
let workerDb: Kysely<MossDatabase>;
let previousAiSecretKey: string | undefined;

const moduleA = {
  id: "acme-a",
  dir: "/unused",
  manifest: {
    schemaVersion: 1 as const,
    id: "acme-a",
    name: "Acme A",
    version: "1.0.0",
    publisher: "Acme",
    lifecycle: "optional" as const,
    compatibility: { jarv1s: ">=0.0.0" },
    auth: [
      {
        id: "acme-a.shared",
        displayName: "Shared",
        kind: "api-key" as const,
        scope: "instance" as const
      }
    ],
    storage: [{ namespace: "acme-a.state", scopes: ["user"] as const }]
  },
  manifestHash: HASH,
  packageHash: HASH
};
const queueA = { name: "acme-a.sync", handler: "runSync" };

beforeAll(async () => {
  previousAiSecretKey = process.env.JARVIS_AI_SECRET_KEY;
  process.env.JARVIS_AI_SECRET_KEY = "test-queue-ai-bridge-secret";
  await resetFoundationDatabase();
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  await bootstrap.query(
    `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, enabled_at, enabled_by)
     VALUES ('acme-a', 'enabled', $1, $1, now(), $2)`,
    [HASH, ids.adminUser]
  );
  const envelope = createModuleCredentialSecretCipher().encryptJson({ value: CREDENTIAL_SECRET });
  await bootstrap.query(
    `INSERT INTO app.module_credentials
       (module_id, credential_id, scope, owner_user_id, display_name, encrypted_secret, created_by)
     VALUES ('acme-a', 'acme-a.shared', 'instance', NULL, 'A', $1::jsonb, $2)`,
    [JSON.stringify(envelope), ids.adminUser]
  );
});

afterAll(async () => {
  if (previousAiSecretKey === undefined) delete process.env.JARVIS_AI_SECRET_KEY;
  else process.env.JARVIS_AI_SECRET_KEY = previousAiSecretKey;
  await Promise.allSettled([bootstrap?.end(), workerDb?.destroy()]);
});

type RpcHandler = (
  method: string,
  params: unknown,
  rememberSecret: (value: string) => void
) => Promise<unknown>;

interface Captured {
  readonly module: unknown;
  readonly handler: string;
  readonly input: unknown;
  readonly rpc: RpcHandler;
}

// Builds the handler exactly as apps/worker composes it: real DataContextRunner,
// real credential cipher, real ai bridge over a shared AiRepository. Only
// runtime.invoke is stubbed so the test can drive the rpc the module would see.
function buildHandler(overrides: Partial<ExternalModuleJobHandlerDeps> = {}): {
  handler: (job: Job<ExternalModuleJobPayload>) => Promise<unknown>;
  briefing: ReturnType<typeof createExternalBriefingInvoker>;
  invocations: Captured[];
} {
  const invocations: Captured[] = [];
  const silentLogger = { info: () => undefined, warn: () => undefined };
  const deps: ExternalModuleJobHandlerDeps = {
    module: moduleA,
    queue: queueA,
    runtime: {
      invoke: async (module, handler, input, rpc) => {
        invocations.push({ module, handler, input, rpc: rpc as RpcHandler });
        return { ok: true };
      }
    },
    workerDb,
    dataContext: new DataContextRunner(workerDb),
    cipher: createModuleCredentialSecretCipher(),
    getDiscoveryById: (id: string) => (id === moduleA.id ? moduleA : undefined),
    listDiscoveredModuleIds: () => [moduleA.id],
    listActiveUserIds: async () => [ids.userA],
    ai: createModuleWorkerAiBridge({
      aiRepository: new AiRepository(),
      logger: silentLogger
    }),
    ...overrides
  };
  return {
    handler: createExternalModuleJobHandler(deps),
    briefing: createExternalBriefingInvoker(deps),
    invocations
  };
}

function jobOf(data: unknown, id = "job-1"): Job<ExternalModuleJobPayload> {
  return { id, name: queueA.name, data } as Job<ExternalModuleJobPayload>;
}

const validPayload: ExternalModuleJobPayload = {
  actorUserId: ids.userA,
  moduleId: "acme-a",
  jobKind: "sync",
  manifestHash: HASH
};

async function capturedRpc(): Promise<RpcHandler> {
  const { handler, invocations } = buildHandler();
  await handler(jobOf(validPayload));
  expect(invocations).toHaveLength(1);
  return invocations[0]!.rpc;
}

describe("external module queue job handler", () => {
  it("invokes an active owner's draft with matching hashes", async () => {
    await bootstrap.query(
      `UPDATE app.external_modules
       SET status = 'draft', owner_user_id = $1, enabled_at = NULL, enabled_by = NULL
       WHERE id = 'acme-a'`,
      [ids.userA]
    );
    try {
      const { handler, invocations } = buildHandler();
      await handler(jobOf(validPayload));
      expect(invocations).toHaveLength(1);
    } finally {
      await bootstrap.query(
        `UPDATE app.external_modules
         SET status = 'enabled', owner_user_id = NULL, enabled_at = now(), enabled_by = $1
         WHERE id = 'acme-a'`,
        [ids.adminUser]
      );
    }
  });

  it("invokes the runtime with metadata-only input and a live rpc", async () => {
    const { handler, invocations } = buildHandler();
    await handler(jobOf(validPayload));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.module).toBe(moduleA);
    expect(invocations[0]!.handler).toBe("runSync");
    // toEqual is exact: nothing beyond actor/kind/idempotency/params crosses.
    expect(invocations[0]!.input).toEqual({
      actorUserId: ids.userA,
      jobKind: "sync",
      idempotencyKey: "acme-a:sync:job-1",
      params: {}
    });
  });

  it("rejects payloads with undeclared keys (metadata-only invariant intact)", async () => {
    const { handler, invocations } = buildHandler();
    await expect(handler(jobOf({ ...validPayload, providerApiKey: "sk-leaked" }))).rejects.toThrow(
      /undeclared key/
    );
    expect(invocations).toHaveLength(0);
  });

  it("refuses inactive users and disabled modules without invoking the runtime", async () => {
    // The refusal must REJECT, not resolve. A resolved refusal is recorded by pg-boss as a
    // `completed` job with NULL output in ~20ms, which is indistinguishable from a job that
    // really ran — a warm module child answers a full invocation including its DB write in
    // 7-10ms. That ambiguity cost a live debugging session on 2026-07-30.
    const inactive = buildHandler({ listActiveUserIds: async () => [] });
    await expect(inactive.handler(jobOf(validPayload))).rejects.toThrow(/declined: not-active/);
    expect(inactive.invocations).toHaveLength(0);

    // Discovery hash drift (stale on-disk module vs DB state) must also refuse.
    const driftedModule = { ...moduleA, manifestHash: `sha256:${"b".repeat(64)}` };
    const drifted = buildHandler({
      getDiscoveryById: (id: string) => (id === moduleA.id ? driftedModule : undefined),
      listDiscoveredModuleIds: () => [moduleA.id]
    });
    await expect(drifted.handler(jobOf(validPayload))).rejects.toThrow(/declined: hash-mismatch/);
    expect(drifted.invocations).toHaveLength(0);
  });

  it("allows write-risk scheduled jobs to persist declared user storage", async () => {
    const { handler, invocations } = buildHandler();
    await handler(jobOf(validPayload));
    const rpc = invocations[0]!.rpc;
    const params = { namespace: "acme-a.state", scope: "user", key: "scheduled" };
    try {
      await expect(
        rpc("kv.set", { ...params, value: { word: "saved" } }, () => {})
      ).resolves.toBeUndefined();
      await expect(rpc("kv.get", params, () => {})).resolves.toEqual({ word: "saved" });
    } finally {
      await rpc("kv.delete", params, () => {});
    }
  });

  it("keeps read-risk briefing invocations from mutating declared user storage", async () => {
    const { briefing, invocations } = buildHandler();
    await briefing({
      moduleId: moduleA.id,
      handler: "briefing",
      actorUserId: ids.userA,
      requestId: "read-risk-proof",
      section: "morning"
    });
    expect(invocations).toHaveLength(1);
    await expect(
      invocations[0]!.rpc(
        "kv.set",
        {
          namespace: "acme-a.state",
          scope: "user",
          key: "saved",
          value: { word: "immutable" }
        },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_kv_mutation" });
  });
});

describe("queue-path ctx.ai (real bridge)", () => {
  it("fails closed with typed needs_config when no provider is configured", async () => {
    const rpc = await capturedRpc();
    // No ai provider/model/binding rows exist: the real bridge resolves through
    // @moss/ai and must surface the typed error, never throw.
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, () => undefined)
    ).resolves.toEqual({ ok: false, error: "needs_config" });
  });

  it("enforces the composition guard end-to-end on a queue invocation", async () => {
    const rpc = await capturedRpc();
    await expect(
      rpc("auth.getCredential", { authId: "acme-a.shared" }, () => undefined)
    ).resolves.toBe(CREDENTIAL_SECRET);
    await expect(
      rpc(
        "ai.generateStructured",
        { schema: { type: "object" }, prompt: `summarize ${CREDENTIAL_SECRET}` },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_secret_in_ai_input" });
  });

  it("caps ai calls per queue invocation with usage_limited", async () => {
    const rpc = await capturedRpc();
    for (let i = 1; i <= AI_CALLS_PER_INVOCATION_CAP; i += 1) {
      // Unconfigured provider: every in-cap call yields needs_config, and the
      // result carries no usage/model/provider keys (exact toEqual).
      await expect(
        rpc(
          "ai.generateStructured",
          { schema: { type: "object" }, prompt: `call ${i}` },
          () => undefined
        )
      ).resolves.toEqual({ ok: false, error: "needs_config" });
    }
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "over" }, () => undefined)
    ).resolves.toEqual({ ok: false, error: "usage_limited" });
  });

  it("stays fail-closed when the handler is built without the ai dependency", async () => {
    const { handler, invocations } = buildHandler({ ai: undefined });
    await handler(jobOf(validPayload));
    await expect(
      invocations[0]!.rpc(
        "ai.generateStructured",
        { schema: { type: "object" }, prompt: "hi" },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "invalid_rpc" });
  });
});
