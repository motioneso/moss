import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type AccessContext, type MossDatabase } from "@moss/db";
import { IntegrationsRepository } from "@moss/integrations";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("integrations connection repository", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: IntegrationsRepository;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new IntegrationsRepository();
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("keeps the credential out of every list/get row and enforces owner-only RLS", async () => {
    const fakeEnvelope = { keyId: "test", iv: "abc", ciphertext: "def", authTag: "ghi" };

    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createConnection(scopedDb, {
        name: "Weather MCP",
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: fakeEnvelope,
        credentialPlacement: { kind: "bearer" }
      })
    );

    expect(created.hasCredential).toBe(true);
    expect(created).not.toHaveProperty("credential");
    expect(JSON.stringify(created)).not.toContain("ciphertext");

    const listedByA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.listConnections(scopedDb)
    );
    const gottenByA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    );

    expect(listedByA).toHaveLength(1);
    expect(listedByA[0]).not.toHaveProperty("credential");
    expect(listedByA[0]?.hasCredential).toBe(true);
    expect(gottenByA).not.toBeNull();
    expect(gottenByA).not.toHaveProperty("credential");
    expect(gottenByA?.hasCredential).toBe(true);

    const listedByB = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.listConnections(scopedDb)
    );
    const gottenByB = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    );

    expect(listedByB).toHaveLength(0);
    expect(gottenByB).toBeNull();

    const updated = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.updateConnection(scopedDb, created.id, {
        enabled: false,
        enabledGroups: ["group-a"],
        enabledTools: ["tool-a"],
        mutedTools: ["tool-b"]
      })
    );

    expect(updated?.enabled).toBe(false);
    expect(updated?.enabledGroups).toEqual(["group-a"]);
    expect(updated?.enabledTools).toEqual(["tool-a"]);
    expect(updated?.mutedTools).toEqual(["tool-b"]);
    expect(updated).not.toHaveProperty("credential");

    const envelopeForA = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.loadCredentialEnvelope(scopedDb, created.id)
    );
    const envelopeForB = await dataContext.withDataContext(userBContext(), (scopedDb) =>
      repository.loadCredentialEnvelope(scopedDb, created.id)
    );

    expect(envelopeForA).toEqual(fakeEnvelope);
    expect(envelopeForB).toBeNull();

    const deleted = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.deleteConnection(scopedDb, created.id)
    );
    const afterDelete = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    );

    expect(deleted).toBe(true);
    expect(afterDelete).toBeNull();
  });

  it("saves discovered tools on success and preserves them on a failed refresh", async () => {
    const created = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createConnection(scopedDb, {
        name: "Support OpenAPI",
        kind: "openapi",
        url: "https://api.example.com/openapi.json",
        baseUrl: "https://api.example.com",
        specPasted: true,
        credentialEnvelope: null,
        credentialPlacement: null
      })
    );

    const tools = [
      { name: "list_tickets", description: "List tickets", group: "tickets", inputSchema: null }
    ];

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDiscovery(scopedDb, created.id, tools, null)
    );
    const afterSuccess = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    );

    expect(afterSuccess?.discoveredTools).toEqual(tools);
    expect(afterSuccess?.lastDiscoveryAt).not.toBeNull();
    expect(afterSuccess?.lastError).toBeNull();

    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.saveDiscovery(scopedDb, created.id, null, "fetch failed")
    );
    const afterFailure = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.getConnection(scopedDb, created.id)
    );

    expect(afterFailure?.discoveredTools).toEqual(tools);
    expect(afterFailure?.lastError).toBe("fetch failed");
  });

  it("rejects a duplicate (owner, name) connection", async () => {
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      repository.createConnection(scopedDb, {
        name: "Duplicate Name",
        kind: "mcp",
        url: "https://mcp.example.com/one",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: null,
        credentialPlacement: null
      })
    );

    await expect(
      dataContext.withDataContext(userAContext(), (scopedDb) =>
        repository.createConnection(scopedDb, {
          name: "Duplicate Name",
          kind: "mcp",
          url: "https://mcp.example.com/two",
          baseUrl: null,
          specPasted: false,
          credentialEnvelope: null,
          credentialPlacement: null
        })
      )
    ).rejects.toThrow();
  });
});

function userAContext(): AccessContext {
  return {
    actorUserId: ids.userA,
    requestId: "request:user-a-integrations"
  };
}

function userBContext(): AccessContext {
  return {
    actorUserId: ids.userB,
    requestId: "request:user-b-integrations"
  };
}
