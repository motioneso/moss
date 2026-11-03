import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry
} from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { saveChatSettings } from "../../packages/chat/src/chat-settings-save.js";
import { createClassifierGatePortsFactory } from "../../packages/chat/src/live/classifier-gate-wiring.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";

// Real database, real row-level security, real gateway policy. The device tool is a stand-in that
// never touches a real door; the device list is hand-set and mixes a light, a lock and a garage.
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
const preferences = new PreferencesRepository();
const threads = new ChatRepository();

const manifest: MossModuleManifest = {
  id: "home",
  name: "Home",
  version: "1.0.0",
  publisher: "Moss",
  lifecycle: "optional",
  compatibility: { jarv1s: "*" },
  assistantActionFamilies: [
    {
      id: "home.devices",
      label: "Home devices",
      description: "Stand-in device actions.",
      defaultTier: "trusted_auto",
      allowedTiers: ["trusted_auto", "ask_each_time"]
    }
  ],
  assistantTools: [
    {
      name: "home.setSwitch",
      description: "Turn a device on or off",
      permissionId: "home.use",
      risk: "write",
      actionFamilyId: "home.devices",
      executionPolicy: "auto",
      inputSchema: {
        type: "object",
        properties: { device: { type: "string" }, state: { type: "string", enum: ["on", "off"] } },
        required: ["device", "state"]
      },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      classifier: {
        description: "Turn a device on or off.",
        arguments: { device: { kind: "candidates" }, state: { kind: "enum" } },
        replyTemplate: "Done.",
        candidates: async () => [
          { id: "light.kitchen", label: "Kitchen light" },
          { id: "lock.front_door", label: "Front door" },
          { id: "cover.garage_door", label: "Garage door" }
        ]
      },
      execute: async () => ({ data: { ok: true } })
    }
  ]
};

beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  runner = new DataContextRunner(db);
});
afterAll(async () => {
  await db?.destroy();
});

async function ports(actorUserId: string) {
  const thread = await runner.withDataContext({ actorUserId }, (scoped) =>
    threads.openNewThread(scoped, { title: `Stored ${randomUUID()}` })
  );
  const tokens = new SessionTokenRegistry();
  const token = tokens.mint({
    actorUserId,
    threadId: thread.id,
    chatSessionId: randomUUID(),
    allowedToolNames: null
  });
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [manifest],
    repository: new AiRepository(),
    runner,
    tokens,
    confirmations: new ConfirmationRegistry(),
    notifier: { emit: () => {} },
    provenance: new ConversationProvenanceStore(runner),
    confirmTimeoutMs: 5000,
    yoloMode: async () => false,
    actionPolicy: () => ({
      getFamilyTier: async () => "trusted_auto",
      getFamilyManifest: async (_moduleId, familyId) =>
        manifest.assistantActionFamilies?.find((family) => family.id === familyId) ?? null
    })
  });
  const gate = createClassifierGatePortsFactory({
    resolveActiveModules: async () => [manifest],
    dataContext: runner,
    gateway,
    preferences,
    classifierDeps: {} as never
  })(actorUserId, token);
  const [tool] = await gate.listTools();
  const offered = async () =>
    ((await gate.loadCandidates(tool!, new AbortController().signal)) as { id: string }[]).map(
      (entry) => entry.id
    );
  return { gate, gateway, token, offered };
}

const setOptIn = (actorUserId: string, on: boolean) =>
  runner.withDataContext({ actorUserId }, (scoped) =>
    saveChatSettings(scoped, preferences, {
      responseStyle: "balanced",
      frontDoorGuardedDevices: on
    })
  );

describe("front door: locks and doors are a per-account opt-in", () => {
  it("offers only the light by default", async () => {
    expect(await (await ports(ids.userA)).offered()).toEqual(["light.kitchen"]);
  });

  it("offers the lock and the garage after the account opts in, for that account only", async () => {
    await setOptIn(ids.userA, true);
    expect(await (await ports(ids.userA)).offered()).toEqual([
      "light.kitchen",
      "lock.front_door",
      "cover.garage_door"
    ]);
    expect(await (await ports(ids.userB)).offered()).toEqual(["light.kitchen"]);
    expect(await (await ports(ids.adminUser)).offered()).toEqual(["light.kitchen"]);
  });

  it("returns to refusing them once the account opts out", async () => {
    await setOptIn(ids.userA, false);
    expect(await (await ports(ids.userA)).offered()).toEqual(["light.kitchen"]);
  });

  it("handles a light with no approval card", async () => {
    const h = await ports(ids.userB);
    expect(
      await h.gateway.callToolForGate(
        h.token,
        "home.setSwitch",
        { device: "light.kitchen", state: "off" },
        "dry-run"
      )
    ).toEqual({ kind: "would_run", approvalMode: "auto" });
  });
});
