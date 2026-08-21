import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  createDatabase,
  DataContextRunner,
  ensureModuleRoles,
  generateModuleTableRlsSql,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  type MossDatabase
} from "@moss/db";
import { HostPinningViolationError } from "@moss/host-fetch";
import { StubEmbeddingProvider } from "@moss/memory";
import {
  AI_CALLS_PER_INVOCATION_CAP,
  createExternalModuleRpcHandler,
  ExternalModuleRpcError
} from "@moss/module-registry/node";
import { createModuleCredentialSecretCipher } from "@moss/settings";
import type { Kysely } from "kysely";

import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  ids,
  laneScopedModuleId,
  resetFoundationDatabase,
  revokeModuleMembershipAtTeardown
} from "./test-database.js";

const { Client } = pg;
let bootstrap: pg.Client;
let workerDb: Kysely<MossDatabase>;

beforeAll(async () => {
  await resetFoundationDatabase();
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
  await bootstrap.query(`
    INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, enabled_at, enabled_by)
    VALUES
      ('acme-a', 'enabled', 'sha256:a', 'sha256:a', now(), '${ids.adminUser}'),
      ('acme-b', 'enabled', 'sha256:b', 'sha256:b', now(), '${ids.adminUser}'),
      ('acme-off', 'disabled', 'sha256:c', 'sha256:c', NULL, NULL);
    INSERT INTO app.module_credentials
      (module_id, credential_id, scope, owner_user_id, display_name, encrypted_secret, created_by)
    VALUES
      ('acme-a', 'acme-a.shared', 'instance', NULL, 'A', '{"ciphertext":"a"}', '${ids.adminUser}'),
      ('acme-b', 'acme-b.shared', 'instance', NULL, 'B', '{"ciphertext":"b"}', '${ids.adminUser}'),
      ('acme-a', 'acme-a.user', 'user', '${ids.userA}', 'A user', '{"ciphertext":"u"}', '${ids.userA}');
    INSERT INTO app.module_kv (module_id, namespace, scope, owner_user_id, key, value)
    VALUES
      ('acme-a', 'acme-a.state', 'instance', NULL, 'shared', '{"v":1}'),
      ('acme-b', 'acme-b.state', 'instance', NULL, 'shared', '{"v":2}'),
      ('acme-a', 'acme-a.state', 'user', '${ids.userA}', 'mine', '{"v":3}');
  `);
  const envelope = createModuleCredentialSecretCipher().encryptJson({ value: "runtime-secret" });
  await bootstrap.query(
    `UPDATE app.module_credentials SET encrypted_secret = $1::jsonb
     WHERE module_id = 'acme-a' AND credential_id = 'acme-a.shared'`,
    [JSON.stringify(envelope)]
  );
});

afterAll(async () => Promise.allSettled([bootstrap?.end(), workerDb?.destroy()]));

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
      },
      // FIN-00 #1145: user-scope slot for auth.setCredential coverage — matches
      // the seeded acme-a.user row so getCredential can read the write back.
      {
        id: "acme-a.user",
        displayName: "User token",
        kind: "api-key" as const,
        scope: "user" as const
      }
    ],
    storage: [{ namespace: "acme-a.state", scopes: ["instance", "user"] as const }],
    fetchHosts: ["api.example.com"]
  },
  manifestHash: "sha256:a",
  packageHash: "sha256:a"
};

async function workerQuery<T>(actorUserId: string, moduleId: string, query: string): Promise<T[]> {
  const client = new Client({ connectionString: connectionStrings.worker });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    await client.query("SELECT set_config('app.current_module_id', $1, true)", [moduleId]);
    const result = await client.query(query);
    await client.query("ROLLBACK");
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

describe("external module worker RLS", () => {
  it("binds credential and KV reads to enabled module plus invoking actor", async () => {
    const credentials = await workerQuery<{ module_id: string; credential_id: string }>(
      ids.userA,
      "acme-a",
      "SELECT module_id, credential_id FROM app.module_credentials ORDER BY credential_id"
    );
    expect(credentials).toEqual([
      { module_id: "acme-a", credential_id: "acme-a.shared" },
      { module_id: "acme-a", credential_id: "acme-a.user" }
    ]);
    const kv = await workerQuery<{ module_id: string; key: string }>(
      ids.userA,
      "acme-a",
      "SELECT module_id, key FROM app.module_kv ORDER BY key"
    );
    expect(kv).toEqual([
      { module_id: "acme-a", key: "mine" },
      { module_id: "acme-a", key: "shared" }
    ]);
  });

  it("denies userB access to userA credential and KV rows", async () => {
    expect(
      await workerQuery<{ credential_id: string }>(
        ids.userB,
        "acme-a",
        "SELECT credential_id FROM app.module_credentials ORDER BY credential_id"
      )
    ).toEqual([{ credential_id: "acme-a.shared" }]);
    expect(
      await workerQuery<{ key: string }>(
        ids.userB,
        "acme-a",
        "SELECT key FROM app.module_kv ORDER BY key"
      )
    ).toEqual([{ key: "shared" }]);
  });

  it("returns no rows for a disabled or missing module context", async () => {
    expect(
      await workerQuery(ids.userA, "acme-off", "SELECT module_id FROM app.module_credentials")
    ).toEqual([]);
    expect(await workerQuery(ids.userA, "", "SELECT module_id FROM app.module_kv")).toEqual([]);
  });

  it("proxies declared credentials without retaining plaintext", async () => {
    const remembered: string[] = [];
    const rpc = createExternalModuleRpcHandler({
      module: moduleA,
      toolRisk: "read",
      actorUserId: ids.userA,
      requestId: "rpc-auth",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });
    await expect(
      rpc("auth.getCredential", { authId: "acme-a.shared" }, (value) => remembered.push(value))
    ).resolves.toBe("runtime-secret");
    expect(remembered).toEqual(["runtime-secret"]);
    await expect(
      rpc("auth.getCredential", { authId: "acme-b.shared" }, () => undefined)
    ).rejects.toMatchObject({ code: "undeclared_auth" });

    await bootstrap.query(
      `UPDATE app.module_credentials SET encrypted_secret = NULL, revoked_at = now()
       WHERE module_id = 'acme-a' AND credential_id = 'acme-a.shared'`
    );
    await expect(
      rpc("auth.getCredential", { authId: "acme-a.shared" }, () => undefined)
    ).rejects.toMatchObject({ code: "credential_missing" });
  });

  it("persists a declared user-scope credential via auth.setCredential", async () => {
    const base = {
      module: moduleA,
      actorUserId: ids.userA,
      requestId: "rpc-setcred",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    };
    const write = createExternalModuleRpcHandler({ ...base, toolRisk: "write" });

    // guards: undeclared slot, instance-scope slot, read-risk tool, bad values
    await expect(
      write("auth.setCredential", { authId: "acme-a.nope", value: "x" }, () => undefined)
    ).rejects.toMatchObject({ code: "undeclared_auth" });
    await expect(
      write("auth.setCredential", { authId: "acme-a.shared", value: "x" }, () => undefined)
    ).rejects.toMatchObject({ code: "forbidden_instance_credential_write" });
    const read = createExternalModuleRpcHandler({ ...base, toolRisk: "read" });
    await expect(
      read("auth.setCredential", { authId: "acme-a.user", value: "x" }, () => undefined)
    ).rejects.toMatchObject({ code: "forbidden_credential_write" });
    await expect(
      write("auth.setCredential", { authId: "acme-a.user", value: "" }, () => undefined)
    ).rejects.toMatchObject({ code: "credential_value_invalid" });
    await expect(
      write(
        "auth.setCredential",
        { authId: "acme-a.user", value: "x".repeat(32 * 1024 + 1) },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "credential_value_invalid" });

    // happy path: persists, redacts, reads back in a second invocation
    const remembered: string[] = [];
    await expect(
      write("auth.setCredential", { authId: "acme-a.user", value: "minted-token-1" }, (value) =>
        remembered.push(value)
      )
    ).resolves.toBeUndefined();
    expect(remembered).toEqual(["minted-token-1"]);
    const second = createExternalModuleRpcHandler({ ...base, toolRisk: "read" });
    await expect(
      second("auth.getCredential", { authId: "acme-a.user" }, () => undefined)
    ).resolves.toBe("minted-token-1");

    // audit: metadata-only worker-set event, never the value
    const audit = await bootstrap.query(
      `SELECT metadata::text AS metadata FROM app.admin_audit_events
       WHERE action = 'module.credential.worker-set'`
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).not.toContain("minted-token-1");
  });

  it("allows non-admin instance kv writes when the namespace declares instanceWritePolicy module", async () => {
    const optedIn = {
      ...moduleA,
      manifest: {
        ...moduleA.manifest,
        storage: [
          {
            namespace: "acme-a.state",
            scopes: ["instance", "user"] as const,
            instanceWritePolicy: "module" as const
          }
        ]
      }
    };
    const write = createExternalModuleRpcHandler({
      module: optedIn,
      toolRisk: "write",
      actorUserId: ids.userA,
      requestId: "rpc-kv-policy",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });
    await expect(
      write(
        "kv.set",
        { scope: "instance", namespace: "acme-a.state", key: "pooled", value: { v: 9 } },
        () => undefined
      )
    ).resolves.toBeUndefined();
    // read-risk tools still cannot mutate, policy or not
    const read = createExternalModuleRpcHandler({
      module: optedIn,
      toolRisk: "read",
      actorUserId: ids.userA,
      requestId: "rpc-kv-policy-read",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });
    await expect(
      read(
        "kv.set",
        { scope: "instance", namespace: "acme-a.state", key: "pooled", value: { v: 9 } },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_kv_mutation" });
  });

  it("allows declared KV reads but denies read-tool and non-admin instance mutations", async () => {
    const base = {
      module: moduleA,
      actorUserId: ids.userA,
      requestId: "rpc-kv",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    };
    const read = createExternalModuleRpcHandler({ ...base, toolRisk: "read" });
    await expect(
      read("kv.get", { scope: "user", namespace: "acme-a.state", key: "mine" }, () => undefined)
    ).resolves.toEqual({ v: 3 });
    await expect(
      read(
        "kv.set",
        { scope: "user", namespace: "acme-a.state", key: "new", value: { v: 4 } },
        () => undefined
      )
    ).rejects.toBeInstanceOf(ExternalModuleRpcError);

    const write = createExternalModuleRpcHandler({ ...base, toolRisk: "write" });
    await expect(
      write(
        "kv.set",
        { scope: "instance", namespace: "acme-a.state", key: "new", value: { v: 4 } },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_instance_kv_write" });
    await expect(
      write(
        "kv.set",
        { scope: "user", namespace: "acme-a.state", key: "new", value: { v: 4 } },
        () => undefined
      )
    ).resolves.toBeUndefined();
  });

  it("projects host-pinned fetch responses onto the bounded wire DTO", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const rpc = createExternalModuleRpcHandler({
      module: moduleA,
      toolRisk: "write",
      actorUserId: ids.userA,
      requestId: "rpc-fetch",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider(),
      createFetch: () => async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "x-private": "drop" }
        });
      }
    });

    await expect(
      rpc("fetch.request", { url: "https://api.example.com/data" }, () => undefined)
    ).resolves.toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      bodyBase64: "e30="
    });
    expect(requests).toEqual([{ input: "https://api.example.com/data", init: { method: "GET" } }]);
  });
});

// #1309 (Task 24): fetch.request's runtime host-grant merge (worker-rpc-host.ts) is the one
// piece of that task that lives in shared, non-job-search-owned code — every other Task 24 case
// belongs in job-search's own unit test files (job-search-adapter-custom.test.ts,
// job-search-source-handler.test.ts). This describe block is the only place that proves the
// merge against a real Postgres-backed app.module_kv table and the real createHostPinnedFetch
// pinning check, rather than against a fake.
describe("external module fetch.request runtime host grants (#1309)", () => {
  const GRANTS_NAMESPACE = "acme-a.fetch-host-grants";
  const moduleWithGrants = {
    ...moduleA,
    manifest: {
      ...moduleA.manifest,
      storage: [
        { namespace: "acme-a.state", scopes: ["instance", "user"] as const },
        { namespace: GRANTS_NAMESPACE, scopes: ["user"] as const }
      ],
      fetchHostGrantsNamespace: GRANTS_NAMESPACE
    }
  };

  function buildRpc(actorUserId: string, createFetch?: (hosts: readonly string[]) => typeof fetch) {
    return createExternalModuleRpcHandler({
      module: moduleWithGrants,
      toolRisk: "write",
      actorUserId,
      requestId: `rpc-fetch-grants-${actorUserId}`,
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider(),
      ...(createFetch ? { createFetch } : {})
    });
  }

  function stubFetch(requests: string[]): (hosts: readonly string[]) => typeof fetch {
    return () =>
      (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
  }

  it("merges a runtime-granted host into fetch.request, alongside the manifest's static hosts", async () => {
    const rpc = buildRpc(ids.userA);
    await rpc(
      "kv.set",
      { scope: "user", namespace: GRANTS_NAMESPACE, key: "boards.granted.example", value: {} },
      () => undefined
    );

    const requests: string[] = [];
    const rpcWithFetch = buildRpc(ids.userA, stubFetch(requests));
    await expect(
      rpcWithFetch("fetch.request", { url: "https://boards.granted.example/jobs" }, () => undefined)
    ).resolves.toMatchObject({ status: 200 });
    // The pre-existing static host (moduleA's own "api.example.com") still resolves through the
    // same merged list — granting one host is additive, never a replacement of the static list.
    await expect(
      rpcWithFetch("fetch.request", { url: "https://api.example.com/data" }, () => undefined)
    ).resolves.toMatchObject({ status: 200 });
    expect(requests).toEqual([
      "https://boards.granted.example/jobs",
      "https://api.example.com/data"
    ]);
  });

  it("still rejects a host that is in neither the static list nor the actor's granted namespace", async () => {
    const rpc = buildRpc(ids.userA);
    await rpc(
      "kv.set",
      { scope: "user", namespace: GRANTS_NAMESPACE, key: "boards.granted.example", value: {} },
      () => undefined
    );

    // No createFetch override here — the real createHostPinnedFetch runs, and its hostname
    // check throws before any network call is attempted, so this never reaches the network.
    await expect(
      rpc("fetch.request", { url: "https://not-granted.example/jobs" }, () => undefined)
    ).rejects.toBeInstanceOf(HostPinningViolationError);
  });

  it("scopes a granted host to the actor who registered it — a different actor's fetch.request for the same host is still rejected", async () => {
    await buildRpc(ids.userA)(
      "kv.set",
      { scope: "user", namespace: GRANTS_NAMESPACE, key: "boards.userA-only.example", value: {} },
      () => undefined
    );

    await expect(
      buildRpc(ids.userB)(
        "fetch.request",
        { url: "https://boards.userA-only.example/jobs" },
        () => undefined
      )
    ).rejects.toBeInstanceOf(HostPinningViolationError);
    // The grant owner's own fetch.request for the same host is unaffected by userB's rejection.
    const requests: string[] = [];
    await expect(
      buildRpc(ids.userA, stubFetch(requests))(
        "fetch.request",
        { url: "https://boards.userA-only.example/jobs" },
        () => undefined
      )
    ).resolves.toMatchObject({ status: 200 });
  });

  it("an actor with no rows yet in the grants namespace still gets the static hosts, with no crash from an empty grant list", async () => {
    // ids.adminUser has never called source.add in this describe block, so listModuleKvKeys
    // resolves to an empty array for this actor+namespace — the merge must treat that the same
    // as "no grants", not throw or short-circuit past the static hosts.
    const requests: string[] = [];
    await expect(
      buildRpc(ids.adminUser, stubFetch(requests))(
        "fetch.request",
        { url: "https://api.example.com/data" },
        () => undefined
      )
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      buildRpc(ids.adminUser)(
        "fetch.request",
        { url: "https://still-not-granted.example/jobs" },
        () => undefined
      )
    ).rejects.toBeInstanceOf(HostPinningViolationError);
  });

  it("revoking a grant (kv.delete) is honored on the very next fetch.request — the merge reads live state, not a cached list", async () => {
    const rpc = buildRpc(ids.userA);
    await rpc(
      "kv.set",
      { scope: "user", namespace: GRANTS_NAMESPACE, key: "boards.revocable.example", value: {} },
      () => undefined
    );
    const requests: string[] = [];
    await expect(
      buildRpc(ids.userA, stubFetch(requests))(
        "fetch.request",
        { url: "https://boards.revocable.example/jobs" },
        () => undefined
      )
    ).resolves.toMatchObject({ status: 200 });

    // Mirrors source.remove's own sequence (kv.delete before the store row is dropped).
    await rpc(
      "kv.delete",
      { scope: "user", namespace: GRANTS_NAMESPACE, key: "boards.revocable.example" },
      () => undefined
    );

    await expect(
      rpc("fetch.request", { url: "https://boards.revocable.example/jobs" }, () => undefined)
    ).rejects.toBeInstanceOf(HostPinningViolationError);
  });
});

describe("ai.generateStructured", () => {
  // The credential-proxy test above revokes acme-a.shared; restore it with a fresh
  // secret so the composition-guard test can resolve it via auth.getCredential.
  const aiSecret = "ai-bridge-runtime-secret";
  beforeAll(async () => {
    const envelope = createModuleCredentialSecretCipher().encryptJson({ value: aiSecret });
    await bootstrap.query(
      `UPDATE app.module_credentials
         SET encrypted_secret = $1::jsonb, revoked_at = NULL
       WHERE module_id = 'acme-a' AND credential_id = 'acme-a.shared'`,
      [JSON.stringify(envelope)]
    );
  });

  // workerDb is assigned in the file-level beforeAll, so build the config lazily.
  const base = () => ({
    module: moduleA,
    actorUserId: ids.userA,
    requestId: "req-ai",
    workerDataContext: new DataContextRunner(workerDb),
    cipher: createModuleCredentialSecretCipher(),
    isActorAdmin: async () => false,
    // Required dep (#1281); these tests never reach an embed.* method.
    embeddingProvider: async () => new StubEmbeddingProvider()
  });
  const noSecret = () => undefined;

  it("returns a sanitized result from the injected callback", async () => {
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async (_scopedDb, request) => ({ ok: true, object: { echoed: request.prompt } })
    });
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, noSecret)
    ).resolves.toEqual({ ok: true, object: { echoed: "hi" } });
  });

  it("rebuilds the success envelope so host extras (usage/model/provider) never cross", async () => {
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () =>
        ({
          ok: true,
          object: { fine: true },
          usage: { inputTokens: 10, outputTokens: 20 },
          model: "some-model-id",
          provider: "some-provider"
        }) as never
    });
    // toEqual is exact: any leaked usage/model/provider key fails this assertion.
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, noSecret)
    ).resolves.toEqual({ ok: true, object: { fine: true } });
  });

  it("fails closed when the host has no ai dependency (jobs-path handlers)", async () => {
    const rpc = createExternalModuleRpcHandler({ ...base(), toolRisk: "write" });
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, noSecret)
    ).rejects.toMatchObject({ code: "invalid_rpc" });
  });

  it("read-risk tools cannot call ai", async () => {
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "read",
      ai: async () => ({ ok: true, object: {} })
    });
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, noSecret)
    ).rejects.toMatchObject({ code: "forbidden_ai_call" });
  });

  it("rejects malformed requests before the callback runs", async () => {
    let calls = 0;
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () => {
        calls += 1;
        return { ok: true, object: {} };
      }
    });
    for (const params of [
      { schema: { type: "object" }, prompt: "p", extra: 1 },
      { schema: { type: "object" }, prompt: "" },
      { schema: [], prompt: "p" },
      { schema: { type: "object" }, prompt: "p", tierHint: "opus" },
      { schema: { type: "object" }, prompt: "p", maxOutputTokens: -1 },
      { schema: { type: "object" }, prompt: "p", maxOutputTokens: 1.5 },
      { schema: { type: "object" }, prompt: "p", maxOutputTokens: 1_000_000 }
    ]) {
      await expect(rpc("ai.generateStructured", params, noSecret)).rejects.toMatchObject({
        code: "invalid_rpc"
      });
    }
    expect(calls).toBe(0);
  });

  it("coerces unexpected error labels to provider_error (no leak channel)", async () => {
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () => ({ ok: false, error: "anthropic exploded" as never })
    });
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "hi" }, noSecret)
    ).resolves.toEqual({ ok: false, error: "provider_error" });
  });

  it("rejects prompts or schemas containing a credential resolved in this invocation", async () => {
    let calls = 0;
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () => {
        calls += 1;
        return { ok: true, object: {} };
      }
    });
    await expect(rpc("auth.getCredential", { authId: "acme-a.shared" }, noSecret)).resolves.toBe(
      aiSecret
    );
    await expect(
      rpc(
        "ai.generateStructured",
        { schema: { type: "object" }, prompt: `please summarize ${aiSecret}` },
        noSecret
      )
    ).rejects.toMatchObject({ code: "forbidden_secret_in_ai_input" });
    await expect(
      rpc(
        "ai.generateStructured",
        { schema: { type: "object", description: aiSecret }, prompt: "hi" },
        noSecret
      )
    ).rejects.toMatchObject({ code: "forbidden_secret_in_ai_input" });
    expect(calls).toBe(0);
    // A clean request on the same handler still goes through.
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "clean" }, noSecret)
    ).resolves.toEqual({ ok: true, object: {} });
    expect(calls).toBe(1);
  });

  it("rejects ai prompts containing a credential written via auth.setCredential this invocation", async () => {
    // FIN-00 #1145: a value the worker just WROTE is as secret as one it read —
    // the composition guard must cover both directions.
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () => ({ ok: true, object: {} })
    });
    await rpc("auth.setCredential", { authId: "acme-a.user", value: "freshly-minted" }, noSecret);
    await expect(
      rpc(
        "ai.generateStructured",
        { schema: { type: "object" }, prompt: "token is freshly-minted" },
        noSecret
      )
    ).rejects.toMatchObject({ code: "forbidden_secret_in_ai_input" });
  });

  it("caps calls per invocation with a typed usage_limited error", async () => {
    let calls = 0;
    const rpc = createExternalModuleRpcHandler({
      ...base(),
      toolRisk: "write",
      ai: async () => {
        calls += 1;
        return { ok: true, object: { call: calls } };
      }
    });
    for (let i = 1; i <= AI_CALLS_PER_INVOCATION_CAP; i += 1) {
      await expect(
        rpc("ai.generateStructured", { schema: { type: "object" }, prompt: `call ${i}` }, noSecret)
      ).resolves.toEqual({ ok: true, object: { call: i } });
    }
    await expect(
      rpc("ai.generateStructured", { schema: { type: "object" }, prompt: "over cap" }, noSecret)
    ).resolves.toEqual({ ok: false, error: "usage_limited" });
    expect(calls).toBe(AI_CALLS_PER_INVOCATION_CAP);
  });
});

describe("db.query (#1167)", () => {
  const dbModuleId = laneScopedModuleId("acme-db");
  const moduleDb = {
    id: dbModuleId,
    dir: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      id: dbModuleId,
      name: "Acme DB",
      version: "1.0.0",
      publisher: "Acme",
      lifecycle: "optional" as const,
      compatibility: { jarv1s: ">=0.0.0" },
      auth: [],
      storage: [],
      fetchHosts: [],
      database: { ownedTables: ["app.acme_db_items"] }
    },
    manifestHash: "sha256:db",
    packageHash: "sha256:db"
  };

  beforeAll(async () => {
    await ensureModuleRoles(connectionStrings.bootstrap, dbModuleId);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        "CREATE TABLE app.acme_db_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid NOT NULL, label text)"
      );
      for (const statement of generateModuleTableRlsSql(dbModuleId, ["app.acme_db_items"])) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }

    // The rpc handler runs on the worker pool; the broker grants the runtime role to
    // jarvis_worker_runtime at ensureModuleRoles time — this explicit grant is idempotent and
    // keeps the test self-documenting. Membership is cluster-global, so it is locked (#1013).
    await grantModuleMembershipAtSetup([
      `GRANT ${moduleRuntimeRoleName(dbModuleId)} TO jarvis_worker_runtime WITH INHERIT FALSE`
    ]);
  });

  afterAll(async () => {
    // Revoke order matters: downstream runtime grants before the install role's grant-option
    // privileges, mirroring module-storage-rpc.test.ts. DROP ROLE fails while a role still holds
    // any privileges, so every privilege ensureModuleRoles granted must be revoked first (Postgres
    // does not implicitly strip these on DROP TABLE/DROP ROLE). Membership is cluster-global and
    // goes first, under the lock (#1013); the per-database revokes below stay on this connection.
    await revokeModuleMembershipAtTeardown([
      `REVOKE ${moduleRuntimeRoleName(dbModuleId)} FROM jarvis_worker_runtime`
    ]);

    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS app.acme_db_items");
      await client.query(
        `REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleRuntimeRoleName(dbModuleId)}`
      );
      await client.query(
        `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${moduleRuntimeRoleName(dbModuleId)}`
      );
      await client.query(
        `REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${moduleInstallRoleName(dbModuleId)}`
      );
      await client.query(
        `REVOKE ALL PRIVILEGES ON app.users FROM ${moduleInstallRoleName(dbModuleId)}`
      );
      await client.query(
        `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${moduleInstallRoleName(dbModuleId)}`
      );
      await dropModuleRolesAtTeardown([
        moduleInstallRoleName(dbModuleId),
        moduleRuntimeRoleName(dbModuleId)
      ]);
    } finally {
      await client.end();
    }
  });

  const dbRpc = (toolRisk: "read" | "write", module = moduleDb) =>
    createExternalModuleRpcHandler({
      module,
      toolRisk,
      actorUserId: ids.userA,
      requestId: "rpc-db-1",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });

  it("rejects modules without a database declaration", async () => {
    const rpc = createExternalModuleRpcHandler({
      module: moduleA,
      toolRisk: "write",
      actorUserId: ids.userA,
      requestId: "rpc-db-2",
      workerDataContext: new DataContextRunner(workerDb),
      cipher: createModuleCredentialSecretCipher(),
      isActorAdmin: async () => false,
      // Required dep (#1281); these tests never reach an embed.* method.
      embeddingProvider: async () => new StubEmbeddingProvider()
    });
    await expect(rpc("db.query", { text: "SELECT 1" }, () => undefined)).rejects.toMatchObject({
      code: "undeclared_database"
    });
  });

  it("writes and reads the module's own table under RLS", async () => {
    const rpc = dbRpc("write");
    await rpc(
      "db.query",
      {
        text: "INSERT INTO app.acme_db_items (owner_user_id, label) VALUES ($1, $2)",
        params: [ids.userA, "from-module"]
      },
      () => undefined
    );
    const result = (await rpc(
      "db.query",
      { text: "SELECT label FROM app.acme_db_items WHERE owner_user_id = $1", params: [ids.userA] },
      () => undefined
    )) as { rows: Array<{ label: string }> };
    expect(result.rows).toEqual([{ label: "from-module" }]);
  });

  it("maps read-risk mutations to forbidden_db_mutation", async () => {
    const rpc = dbRpc("read");
    await expect(
      rpc(
        "db.query",
        {
          text: "INSERT INTO app.acme_db_items (owner_user_id, label) VALUES ($1, $2)",
          params: [ids.userA, "blocked"]
        },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_db_mutation" });
  });

  it("maps allowlist rejections to forbidden_db_statement", async () => {
    const rpc = dbRpc("write");
    await expect(
      rpc("db.query", { text: "TRUNCATE app.acme_db_items" }, () => undefined)
    ).rejects.toMatchObject({ code: "forbidden_db_statement" });
  });

  it("rejects malformed params", async () => {
    const rpc = dbRpc("write");
    await expect(
      rpc("db.query", { text: "SELECT 1", params: "nope" }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc" });
    await expect(rpc("db.query", { params: [] }, () => undefined)).rejects.toMatchObject({
      code: "invalid_rpc"
    });
  });
});
