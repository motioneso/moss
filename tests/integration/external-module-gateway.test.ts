import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createExternalToolManifests } from "@moss/module-registry/node";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";
import type { Kysely } from "kysely";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("external module AssistantToolGateway", () => {
  let appDb: Kysely<MossDatabase>;
  let bootstrap: pg.Client;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterAll(async () => Promise.allSettled([appDb?.destroy(), bootstrap?.end()]));

  it("creates a pending request and audit before/after external write execution", async () => {
    const discovery: ExternalModuleDiscovery = {
      id: "acme",
      dir: "/unused",
      manifest: {
        schemaVersion: 1,
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        publisher: "Acme",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme.write",
            description: "Write",
            permissionId: "acme.write",
            risk: "write",
            handler: "write"
          }
        ]
      },
      manifestHash: "sha256:a",
      packageHash: "sha256:a"
    };
    const calls: unknown[] = [];
    const manifests = createExternalToolManifests([discovery], async (...args) => {
      calls.push(args);
      return { data: { written: true } };
    });
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => manifests,
      repository: new AiRepository(),
      runner: new DataContextRunner(appDb),
      tokens,
      confirmations,
      notifier: { emit: (_session, record) => emitted.push(record) },
      confirmTimeoutMs: 5_000
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "external",
      allowedToolNames: null
    });
    const pending = gateway.callTool(token, "acme.write", { value: 1 });
    while (emitted.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const request = emitted[0];
    if (!request || request.kind !== "action_request") throw new Error("expected action request");
    expect(calls).toHaveLength(0);
    const row = await bootstrap.query(
      "SELECT status, tool_module_id, tool_name FROM app.ai_assistant_action_requests WHERE id = $1",
      [request.actionRequestId]
    );
    expect(row.rows[0]).toMatchObject({
      status: "pending",
      tool_module_id: "acme",
      tool_name: "acme.write"
    });
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const audit = await bootstrap.query(
        "SELECT outcome, tool_module_id, tool_name FROM app.moss_action_audit_log WHERE tool_module_id = 'acme'"
      );
      if (audit.rowCount) {
        expect(audit.rows[0]).toMatchObject({
          outcome: "success",
          tool_module_id: "acme",
          tool_name: "acme.write"
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("audit row not written");
  });

  it("threads a declared actionLabel from the external manifest to the action_request summary", async () => {
    const discovery: ExternalModuleDiscovery = {
      id: "acme",
      dir: "/unused",
      manifest: {
        schemaVersion: 1,
        id: "acme",
        name: "Acme",
        version: "1.0.0",
        publisher: "Acme",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.0.0" },
        runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme.write",
            description: "acme.write (1 field(s))",
            actionLabel: "Send the write",
            permissionId: "acme.write",
            risk: "write",
            handler: "write"
          }
        ]
      },
      manifestHash: "sha256:b",
      packageHash: "sha256:b"
    };
    const manifests = createExternalToolManifests([discovery], async () => ({
      data: { written: true }
    }));
    const tokens = new SessionTokenRegistry();
    const confirmations = new ConfirmationRegistry();
    const emitted: GatewaySessionRecord[] = [];
    const gateway = new AssistantToolGateway({
      resolveActiveModules: async () => manifests,
      repository: new AiRepository(),
      runner: new DataContextRunner(appDb),
      tokens,
      confirmations,
      notifier: { emit: (_session, record) => emitted.push(record) },
      confirmTimeoutMs: 5_000
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "external",
      allowedToolNames: null
    });
    const pending = gateway.callTool(token, "acme.write", { value: 1 });
    while (emitted.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const request = emitted[0];
    if (!request || request.kind !== "action_request") throw new Error("expected action request");
    expect(request.summary).toBe("Send the write");
    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
    await pending;
  });
});
