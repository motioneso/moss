import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiRepository, createAiSecretCipher, type GenerateStructuredProviderInput } from "@moss/ai";
import {
  buildFeatureGrantService,
  ConnectorsRepository,
  createConnectorSecretCipher,
  featureGrantsPrefKey,
  ingestWorkMail,
  type WorkMailPorts
} from "@moss/connectors";
import { createDatabase, DataContextRunner } from "@moss/db";
import { createEmailMonitorProvider, EmailRepository } from "@moss/email";
import { ChatMemoryFactsRepository } from "@moss/memory";
import { PeopleRepository } from "@moss/people";
import { PreferencesRepository } from "@moss/structured-state";
import { readVaultFile, VaultContextRunner } from "@moss/vault";
import { createWorkMailPorts } from "../../packages/module-registry/src/work-mail-ports.js";
import { buildTestSourceContextService } from "./source-context-helpers.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const access = { actorUserId: ids.adminUser, requestId: "invented-work-mail" };
const preferences = new PreferencesRepository();
const ai = new AiRepository();
const cipher = createAiSecretCipher();
const knownSender = "invented-teammate@example.test";
const capturedLogs: string[] = [];
const logger = {
  info: (...args: unknown[]) => {
    capturedLogs.push(JSON.stringify(args));
  },
  warn: (...args: unknown[]) => {
    capturedLogs.push(JSON.stringify(args));
  }
};
let database: ReturnType<typeof createDatabase>;
let context: DataContextRunner;
let vault: VaultContextRunner;
let root: string;
let accountId: string;
let calls: GenerateStructuredProviderInput[] = [];
let ports: WorkMailPorts;

beforeAll(async () => {
  await resetFoundationDatabase();
  database = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(database);
  root = await mkdtemp(join(tmpdir(), "work-mail-storage-"));
  vault = new VaultContextRunner(root);
  await context.withDataContext(access, async (db) => {
    const provider = await ai.createProvider(db, {
      providerKind: "anthropic",
      displayName: "Invented provider",
      encryptedCredential: cipher.encryptJson({ apiKey: "invented-key" })
    });
    const model = await ai.createModel(db, {
      providerConfigId: provider.id,
      providerModelId: "invented-json",
      displayName: "Invented JSON",
      capabilities: ["json"],
      tier: "economy"
    });
    await ai.setServiceBinding(
      db,
      "module.connectors.work-mail",
      { kind: "model", modelId: model.id },
      ids.adminUser
    );
    await new ChatMemoryFactsRepository().insertFact(db, ids.adminUser, {
      category: "preference",
      content: "Never write anything about HR mail",
      provenance: "confirmed"
    });
    const facts = new ChatMemoryFactsRepository();
    await facts.insertFact(db, ids.adminUser, { category: "profile", content: "Not a preference" });
    const old = await facts.insertFact(db, ids.adminUser, {
      category: "preference",
      content: "Superseded preference"
    });
    await facts.supersedeFact(db, old.id);
    const people = new PeopleRepository();
    const person = await people.upsertPersonProjection(db, {
      ownerUserId: ids.adminUser,
      personId: randomUUID(),
      displayName: "Invented teammate",
      relationshipSummary: "Project colleague",
      contextSummary: "Reviews proposals"
    });
    await people.upsertIdentity(db, {
      ownerUserId: ids.adminUser,
      personId: person.id,
      identityKind: "email_address",
      sourceKind: "manual",
      normalizedValue: knownSender,
      displayValue: knownSender,
      sourceRef: null,
      sourceRefHash: null,
      status: "active",
      provenance: "user_confirmed"
    });
    accountId = (
      await new ConnectorsRepository().createAccount(db, {
        providerId: "outlook-browser-calendar",
        scopes: ["calendar.readonly", "email.read"],
        encryptedSecret: createConnectorSecretCipher().encryptJson({ kind: "invented-browser" })
      })
    ).id;
    await preferences.upsert(db, featureGrantsPrefKey(accountId), { email: true, calendar: true });
  });
  ports = createWorkMailPorts({
    vault,
    retrieval: { retrieve: async () => [] },
    ai: {
      repository: ai,
      cipher,
      logger,
      createAdapter: () => ({
        generateStructured: async (input) => {
          calls.push(input);
          return {
            rawObject: {
              decision: "note",
              target: { kind: "default" },
              entry: "Review the invented project proposal by Friday.",
              reason: "Action requested"
            },
            usage: { inputTokens: 20, outputTokens: 10 }
          };
        }
      })
    }
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await database?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

function message(marker: string, time = "2026-10-26T10:00:00Z") {
  return {
    sender: `${marker}@example.test`,
    subject: `Invented ${marker}`,
    receivedAt: time,
    threadHint: null,
    body: `Please review the invented proposal. ${marker}`,
    bodyTruncated: false
  };
}

async function storageHits(marker: string): Promise<string[]> {
  // Bootstrap scans through RLS, including records owned by other users. Never return row contents.
  const client = new pg.Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      "SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'app' ORDER BY tablename"
    );
    expect(tables.rows.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const { table_name: table } of tables.rows) {
      const quoted = '"' + table.replaceAll('"', '""') + '"';
      const result = await client.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM app.${quoted} t WHERE strpos(row_to_json(t)::text, $1) > 0) AS found`,
        [marker]
      );
      if (result.rows[0]?.found) hits.push(table);
    }
    return hits;
  } finally {
    await client.end();
  }
}

describe("invented work mail through real routing and vault adapters", () => {
  it("leaves no canary in any app table or captured logs; grant adds no monitor or briefing mail", async () => {
    const canary = `WORK_MAIL_CANARY_${randomUUID()}`;
    const result = await ingestWorkMail(context, access, [message(canary)], ports);
    expect(result.processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("module.connectors.work-mail");
    expect(JSON.stringify(calls[0]?.messages)).toContain("Never write anything about HR mail");
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("Superseded preference");
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("Not a preference");
    await context.withDataContext(access, async (db) => {
      expect(await ports.people.senderContext(db, ids.adminUser, knownSender)).toContain(
        "Project colleague"
      );
    });
    await vault.withVaultContext(access, async (ctx) => {
      const note = await readVaultFile(ctx, "Work mail notes.md");
      expect(note).toContain(canary); // Only this explicitly sourced vault entry is allowed.
      expect(note).toContain("Review the invented project proposal by Friday.");
    });
    await context.withDataContext(access, async (db) => {
      const grants = buildFeatureGrantService({
        connectorsRepository: new ConnectorsRepository(),
        preferencesRepository: preferences
      });
      expect(await grants.grantedAccountIds(db, "email")).toContain(accountId);
      const monitor = createEmailMonitorProvider({
        grantedAccountIds: grants.grantedAccountIds,
        isModuleActive: async () => true
      });
      expect(
        (
          await monitor.collectSignals(db, {
            ownerUserId: ids.adminUser,
            now: "2026-10-26T11:00:00Z",
            sinceCursor: null,
            timeZone: "UTC",
            locale: { timezone: "UTC", region: "US", dateFormat: "24" },
            priorityAnchors: [],
            maxSignals: 25
          })
        ).signals
      ).toEqual([]);
      expect(await new EmailRepository().listVisibleForBriefing(db)).toEqual([]);
      const source = buildTestSourceContextService({ preferencesRepository: preferences });
      expect((await source.listEmailContext(db, {})).items).toEqual([]);
    });
    expect(await storageHits(canary)).toEqual([]);
    expect(capturedLogs.join("\n")).not.toContain(canary);
  });

  it("serializes simultaneous ingestion and replays safely after a DB failure following append", async () => {
    const captured = message(`invented-${randomUUID()}`, "2026-10-26T10:01:00Z");
    const upsert = vi.spyOn(PreferencesRepository.prototype, "upsert");
    upsert.mockImplementationOnce(async () => {
      throw new Error("invented transaction failure");
    });
    await expect(ingestWorkMail(context, access, [captured], ports)).rejects.toThrow(
      "invented transaction failure"
    );
    upsert.mockRestore();
    calls = [];
    const results = await Promise.all([
      ingestWorkMail(context, access, [captured], ports),
      ingestWorkMail(context, access, [captured], ports)
    ]);
    expect(results.map((result) => result.processed).sort()).toEqual([0, 1]);
    expect(calls).toHaveLength(1);
    await vault.withVaultContext(access, async (ctx) => {
      const note = await readVaultFile(ctx, "Work mail notes.md");
      expect(note.split(`Subject: ${captured.subject}`).length - 1).toBe(1);
    });
    expect(
      await context.withDataContext({ actorUserId: ids.userB }, (db) =>
        preferences.get(db, "outlook_mail.cursor")
      )
    ).toBeNull();
  });
});
