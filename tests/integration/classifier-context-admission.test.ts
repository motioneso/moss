import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";
import { settingsModuleManifest } from "@moss/settings";

import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

// Hosted gate only: durable actor-scoped provenance and a one-connection pool. No provider calls.
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let store: ConversationProvenanceStore;
const threads = new ChatRepository();
const scoped = <T>(actorUserId: string, work: (db: DataContextDb) => Promise<T>) =>
  runner.withDataContext({ actorUserId }, work);
const createThread = (actorUserId: string = ids.userA) =>
  scoped(actorUserId, (db) => threads.openNewThread(db, { title: `Stored ${randomUUID()}` }));

beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  runner = new DataContextRunner(db);
  store = new ConversationProvenanceStore(runner);
});
afterAll(async () => {
  await db?.destroy();
});

async function harness(
  options: {
    isExternal?: boolean;
    unstamped?: boolean;
    descriptorOwnerUserId?: string;
    mixedOwners?: boolean;
    raw?: unknown;
    foreignThread?: boolean;
    factoryActorUserId?: string;
  } = {}
) {
  const bound = await createThread();
  const source = await createThread(); // Current selection differs from the token-bound thread.
  const foreign = options.foreignThread ? await createThread(ids.userB) : null;
  const tool: ModuleAssistantToolManifest = {
    name: "example.choose",
    description: "Outside tool description",
    permissionId: "example.use",
    risk: "read",
    ...(options.unstamped ? {} : { isExternal: options.isExternal ?? false }),
    ...(options.descriptorOwnerUserId === undefined
      ? {}
      : { descriptorOwnerUserId: options.descriptorOwnerUserId }),
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "Outside schema description" } },
      required: ["thread"]
    },
    outputSchema: { type: "object", properties: { summary: { type: "string" } } },
    classifier: {
      description: "Outside classifier description",
      arguments: { thread: { kind: "candidates" } },
      replyTemplate: "{summary}",
      candidates: async (db) => {
        if (options.raw !== undefined) return options.raw as never;
        return (db as DataContextDb).db
          .selectFrom("app.chat_threads")
          .select(["id", "title as label"])
          .where("id", "=", source.id)
          .execute();
      }
    },
    execute: async () => ({ data: {} })
  };
  const manifest: MossModuleManifest = {
    id: "example",
    name: "Outside module label",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [
      tool,
      ...(options.mixedOwners
        ? [{ ...tool, name: "example.foreign", descriptorOwnerUserId: ids.userB }]
        : [])
    ]
  };
  const tokens = new SessionTokenRegistry();
  const token = tokens.mint({
    actorUserId: ids.userA,
    threadId: foreign?.id ?? bound.id,
    chatSessionId: randomUUID(),
    allowedToolNames: null
  });
  const records: GatewaySessionRecord[] = [];
  const policy: { tier: "trusted_auto" | "ask_each_time" } = { tier: "trusted_auto" };
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [manifest, settingsModuleManifest],
    repository: new AiRepository(),
    runner,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: (_session, record) => records.push(record) },
    provenance: store,
    confirmTimeoutMs: 5000,
    // Keep YOLO explicitly off so the clean baseline is exactly approvalMode=auto.
    yoloMode: async () => false,
    actionPolicy: () => ({
      getFamilyTier: async () => policy.tier,
      getFamilyManifest: async (_moduleId, familyId) =>
        settingsModuleManifest.assistantActionFamilies?.find((family) => family.id === familyId) ??
        null
    })
  });
  const ports = createClassifierGatePortsFactory({
    resolveActiveModules: async () => [manifest],
    dataContext: runner,
    gateway,
    classifierDeps: {} as never
  })(options.factoryActorUserId ?? ids.userA, token);
  return { ports, gateway, token, bound, source, foreign, records, policy };
}

async function provenance(threadId: string) {
  return scoped(ids.userA, (db) =>
    db.db
      .selectFrom("app.chat_conversation_provenance")
      .selectAll()
      .where("thread_id", "=", threadId)
      .executeTakeFirstOrThrow()
  );
}

// The user's own trust runs writes after outside content (#3338). The thread carries a durable
// mark, and a write the user has not trusted asks.
async function expectThemeApproval(h: Awaited<ReturnType<typeof harness>>) {
  expect(await store.isMarked(ids.userA, h.bound.id)).toBe(true);
  h.policy.tier = "ask_each_time";
  const pending = h.gateway.callTool(h.token, "settings.themeMode.set", { mode: "dark" });
  await vi.waitFor(() =>
    expect(h.records.some((record) => record.kind === "action_request")).toBe(true)
  );
  const card = h.records.find((record) => record.kind === "action_request")!;
  // ask_each_time asks in a clean thread too, so outside content is not the reason.
  expect(card.outsideContentNotice).toBe(false);
  await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "rejected");
  expect(await pending).toMatchObject({ ok: false, denied: true });
}

async function expectCleanThemeAuto(h: Awaited<ReturnType<typeof harness>>) {
  expect(
    await h.gateway.callToolForGate(h.token, "settings.themeMode.set", { mode: "dark" }, "dry-run")
  ).toEqual({ kind: "would_run", approvalMode: "auto" });
}

describe("classifier context admission through the token-bound gateway", () => {
  it("keeps owned classifier descriptors durably clean and preserves the existing automatic policy", async () => {
    const h = await harness({ isExternal: true, descriptorOwnerUserId: ids.userA });
    const [tool] = await h.ports.listTools();
    expect(tool).not.toHaveProperty("descriptorOwnerUserId");
    expect(await store.isTainted(ids.userA, h.bound.id)).toBe(false);
    expect((await provenance(h.bound.id)).first_admission_path).toBeNull();
    await expectCleanThemeAuto(h);
    // Stored candidates remain outside, even though the same tool's descriptors are trusted.
    expect(await h.ports.loadCandidates(tool!, new AbortController().signal)).toHaveLength(1);
    expect((await provenance(h.bound.id)).first_admission_path).toBe("classifier_candidates");
    await expectThemeApproval(h);
  });

  it.each([
    ["another owner", { isExternal: true, descriptorOwnerUserId: ids.userB }],
    ["missing owner", { isExternal: true }],
    ["unknown origin", { unstamped: true, descriptorOwnerUserId: ids.userA }],
    ["mixed owners", { isExternal: true, descriptorOwnerUserId: ids.userA, mixedOwners: true }]
  ] as const)("taints %s classifier descriptors durably", async (_label, options) => {
    const h = await harness(options);
    expect(await h.ports.listTools()).not.toHaveLength(0);
    expect((await provenance(h.bound.id)).first_admission_path).toBe("tool_external_descriptors");
    expect(await store.isTainted(ids.userA, h.bound.id)).toBe(true);
    expect(await store.isTainted(ids.userA, h.source.id)).toBe(false);
    await expectThemeApproval(h);
  });

  it("refuses token/factory actor mismatch before exposing owned classifier descriptors", async () => {
    const h = await harness({
      isExternal: true,
      descriptorOwnerUserId: ids.userA,
      factoryActorUserId: ids.userB
    });
    await expect(h.ports.listTools()).rejects.toThrow("context_admission_unavailable");
    expect(await store.isTainted(ids.userA, h.bound.id)).toBe(false);
  });

  it("records external descriptions before listing and asks before the next write on that thread", async () => {
    const h = await harness({ isExternal: true });
    await expectCleanThemeAuto(h);
    expect(await h.ports.listTools()).toHaveLength(1);
    const row = await provenance(h.bound.id);
    expect(row.first_admission_path).toBe("tool_external_descriptors");
    expect(row.tainted_at).not.toBeNull();
    expect(await store.isTainted(ids.userA, h.source.id)).toBe(false);
    await expectThemeApproval(h);
    expect(JSON.stringify(row)).not.toContain("Outside");
  });

  it("loads stored candidate IDs and labels with pool size one, then taints only the bound thread", async () => {
    const h = await harness();
    await expectCleanThemeAuto(h);
    const [tool] = await h.ports.listTools();
    expect(await store.isTainted(ids.userA, h.bound.id)).toBe(false);
    expect(await h.ports.loadCandidates(tool!, new AbortController().signal)).toEqual([
      { id: h.source.id, label: h.source.title }
    ]);
    const row = await provenance(h.bound.id);
    expect(row.first_admission_path).toBe("classifier_candidates");
    expect(row.tainted_at).not.toBeNull();
    expect(await store.isTainted(ids.userA, h.source.id)).toBe(false);
    expect(JSON.stringify(row)).not.toContain(h.source.id);
    expect(JSON.stringify(row)).not.toContain(h.source.title);
    await expectThemeApproval(h);
  });

  it.each([
    ["empty", []],
    ["malformed", [{ id: "stored-id", label: null }]]
  ])("%s candidates leave durable provenance clean", async (name, raw) => {
    const h = await harness({ raw });
    const [tool] = await h.ports.listTools();
    const pending = h.ports.loadCandidates(tool!, new AbortController().signal);
    if (name === "empty") expect(await pending).toEqual([]);
    else await expect(pending).rejects.toThrow("invalid classifier candidates");
    expect(await store.isTainted(ids.userA, h.bound.id)).toBe(false);
    expect((await provenance(h.bound.id)).first_admission_path).toBeNull();
    await expectCleanThemeAuto(h);
  });

  it.each([true, false])(
    "withholds classifier content when the token binds another owner's thread (external %s)",
    async (isExternal) => {
      const h = await harness({ foreignThread: true, isExternal });
      if (isExternal) await expect(h.ports.listTools()).rejects.toThrow();
      else {
        const [tool] = await h.ports.listTools();
        await expect(h.ports.loadCandidates(tool!, new AbortController().signal)).rejects.toThrow();
      }
      expect(await store.isTainted(ids.userA, h.bound.id)).toBe(false);
      expect(await store.isTainted(ids.userB, h.foreign!.id)).toBe(false);
    }
  );
});
