import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import {
  registerNativePermissionRoute,
  registerVaultReadReportRoute
} from "../../packages/chat/src/mcp-transport.js";
import {
  CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE,
  CLAUDE_PERMISSION_HOOK_SOURCE
} from "../../packages/chat/src/live/persistent-claude-permission-hook.js";
import { runClaudeNativeHook } from "../fixtures/claude-native-hook.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

// Hosted integration only: isolated PostgreSQL, a loopback API and generated hook scripts.
// The synthetic temporary vault contains no user files and no provider process is launched.
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let store: ConversationProvenanceStore;
beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app });
  runner = new DataContextRunner(db);
  store = new ConversationProvenanceStore(runner);
});
afterAll(async () => {
  await db?.destroy();
});

async function harness() {
  const thread = await runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
    new ChatRepository().openNewThread(scoped, { title: "Native read integration" })
  );
  const untouched = await runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
    new ChatRepository().openNewThread(scoped, { title: "Untouched conversation" })
  );
  const tokens = new SessionTokenRegistry();
  const token = tokens.mint({
    actorUserId: ids.userA,
    threadId: thread.id,
    chatSessionId: randomUUID(),
    allowedToolNames: null
  });
  const confirmations = new ConfirmationRegistry();
  const records: GatewaySessionRecord[] = [];
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    repository: new AiRepository(),
    runner,
    tokens,
    confirmations,
    notifier: { emit: (_session, record) => records.push(record) },
    provenance: store,
    yoloMode: async () => true,
    confirmTimeoutMs: 2000
  });
  const app = Fastify({ logger: false });
  registerVaultReadReportRoute(app, { gateway, tokens });
  registerNativePermissionRoute(app, { gateway, tokens });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const root = await mkdtemp(join(tmpdir(), "moss-synthetic-vault-integration-"));
  await writeFile(join(root, "fixture.md"), "Synthetic integration fixture.");
  return {
    app,
    gateway,
    token,
    tokens,
    thread,
    untouched,
    confirmations,
    records,
    root,
    baseUrl,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

const hooks = [
  ["persistent", CLAUDE_PERMISSION_HOOK_SOURCE],
  ["one-shot", CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE]
] as const;
describe.each(hooks)("hosted %s native admission", (_name, source) => {
  it("records the bound thread before allow and requires approval for the following YOLO write", async () => {
    const h = await harness();
    try {
      expect(await store.isTainted(ids.userA, h.thread.id)).toBe(false);
      const result = await runClaudeNativeHook(
        source,
        { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
        h
      );
      expect(result).toMatchObject({ code: 0, permissionDecision: "allow", stderr: "" });
      expect(await store.isTainted(ids.userA, h.thread.id)).toBe(true);
      expect(await store.isTainted(ids.userA, h.untouched.id)).toBe(false);
      const rows = await runner.withDataContext({ actorUserId: ids.userA }, (scoped) =>
        scoped.db
          .selectFrom("app.chat_conversation_provenance")
          .select(["owner_user_id", "first_admission_path"])
          .where("thread_id", "=", h.thread.id)
          .execute()
      );
      expect(rows).toEqual([
        { owner_user_id: ids.userA, first_admission_path: "native_vault_read" }
      ]);
      const write = runClaudeNativeHook(
        source,
        { tool_name: "Write", tool_input: { file_path: join(h.root, "output.md") }, cwd: h.root },
        h
      );
      await vi.waitFor(() =>
        expect(h.records).toContainEqual(
          expect.objectContaining({ kind: "action_request", outsideContentNotice: true })
        )
      );
      const card = h.records.find((record) => record.kind === "action_request");
      if (!card || card.kind !== "action_request") throw new Error("Missing approval card");
      h.confirmations.resolve(card.actionRequestId, "rejected");
      expect((await write).permissionDecision).toBe("deny");
    } finally {
      await h.close();
    }
  });

  it.each(["missing token file", "report failure"])(
    "denies on %s and leaves the thread clean",
    async (mode) => {
      const h = await harness();
      const reporter =
        mode === "report failure"
          ? vi
              .spyOn(h.gateway, "recordNativeVaultReadForSession")
              .mockRejectedValueOnce(new Error("Private failure detail"))
          : undefined;
      try {
        const options = {
          baseUrl: h.baseUrl,
          root: h.root,
          ...(mode === "report failure" ? { token: h.token } : {})
        };
        const result = await runClaudeNativeHook(
          source,
          { tool_name: "Read", tool_input: { file_path: join(h.root, "fixture.md") }, cwd: h.root },
          options
        );
        expect(result).toMatchObject({ code: 0, permissionDecision: "deny", stderr: "" });
        expect(result.stdout).not.toContain("Private failure detail");
        expect(await store.isTainted(ids.userA, h.thread.id)).toBe(false);
      } finally {
        reporter?.mockRestore();
        await h.close();
      }
    }
  );
});

it("a forged report identity cannot choose another conversation", async () => {
  const h = await harness();
  try {
    const response = await h.app.inject({
      method: "POST",
      url: "/internal/vault-read-report",
      headers: { authorization: `Bearer ${h.token}` },
      body: {
        toolName: "Read",
        toolInput: { file_path: join(h.root, "fixture.md") },
        cwd: h.root,
        threadId: h.untouched.id,
        actorUserId: ids.userB
      }
    });
    expect(response.statusCode).toBe(204);
    expect(await store.isTainted(ids.userA, h.thread.id)).toBe(true);
    expect(await store.isTainted(ids.userA, h.untouched.id)).toBe(false);
  } finally {
    await h.close();
  }
});
