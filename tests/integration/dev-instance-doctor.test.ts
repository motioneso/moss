import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { createAiSecretCipher, AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { getBuiltInSqlMigrationDirectories } from "@moss/module-registry";

import { DOCTOR_CHECKS } from "../../scripts/dev-instance/doctor-checks.js";
import { resolveActiveAdminUserId, runDoctor, type DoctorDeps } from "../../scripts/dev-instance/doctor.js";
import type { DevInstanceConfig } from "../../scripts/dev-instance/config.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID } from "../uat/seed/admin.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationDirectories = [
  join(root, "infra/postgres/migrations"),
  ...getBuiltInSqlMigrationDirectories()
];

const repository = new AiRepository();

function getCheck(id: string) {
  const check = DOCTOR_CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no doctor check registered for id "${id}"`);
  return check;
}

async function insertUser(
  id: string,
  email: string,
  options: { readonly isInstanceAdmin?: boolean; readonly status?: "pending" | "active" | "deactivated" } = {}
): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin, status) VALUES ($1, $2, $3, $4)`,
      [id, email, options.isInstanceAdmin ?? false, options.status ?? "active"]
    );
  } finally {
    await client.end();
  }
}

async function deleteLastAppliedMigration(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `DELETE FROM app.schema_migrations WHERE version = (SELECT version FROM app.schema_migrations ORDER BY applied_at DESC LIMIT 1)`
    );
  } finally {
    await client.end();
  }
}

const ADMIN_ID = "00000000-0000-4000-9000-000000000001";
const ADMIN_EMAIL = "dev-instance-doctor-admin@example.test";
const NON_ADMIN_ID = "00000000-0000-4000-9000-000000000002";
const NON_ADMIN_EMAIL = "dev-instance-doctor-non-admin@example.test";
const PENDING_ADMIN_ID = "00000000-0000-4000-9000-000000000003";
const PENDING_ADMIN_EMAIL = "dev-instance-doctor-pending-admin@example.test";

function fakeConfig(overrides: Partial<DevInstanceConfig> = {}): DevInstanceConfig {
  return {
    providerKind: "openai-compatible",
    credentialFilePath: "/dev/null",
    adminEmail: ADMIN_EMAIL,
    adminName: "Dev Instance Admin",
    adminPasswordFilePath: "/dev/null",
    cliHomeBase: "/tmp/dev-instance-doctor-test",
    cliRunnerSocketPath: "/tmp/dev-instance-doctor-test-nonexistent.sock",
    ...overrides
  };
}

describe("dev-instance doctor (#1258)", () => {
  let migrationDb: Kysely<MossDatabase>;
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let originalSecretKey: string | undefined;

  beforeAll(() => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "dev-instance-doctor-test-key";
    migrationDb = createDatabase({ connectionString: connectionStrings.migration, maxConnections: 1 });
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await Promise.allSettled([migrationDb?.destroy(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
  });

  function deps(configOverrides: Partial<DevInstanceConfig> = {}): DoctorDeps {
    return {
      migrationDb,
      runner,
      cipher: createAiSecretCipher(),
      config: fakeConfig(configOverrides),
      migrationDirectories,
      env: process.env
    };
  }

  // T5 — active-admin resolution.
  describe("resolveActiveAdminUserId", () => {
    it("returns null on an empty database", async () => {
      expect(await resolveActiveAdminUserId(migrationDb)).toBeNull();
    });

    it("returns the id of an active instance-admin user", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      expect(await resolveActiveAdminUserId(migrationDb)).toBe(ADMIN_ID);
    });

    it("does not match a non-admin user", async () => {
      await insertUser(NON_ADMIN_ID, NON_ADMIN_EMAIL, { isInstanceAdmin: false, status: "active" });
      expect(await resolveActiveAdminUserId(migrationDb)).toBeNull();
    });

    it("does not match an admin whose status is not active", async () => {
      await insertUser(PENDING_ADMIN_ID, PENDING_ADMIN_EMAIL, {
        isInstanceAdmin: true,
        status: "pending"
      });
      expect(await resolveActiveAdminUserId(migrationDb)).toBeNull();
    });
  });

  // T6 — provider-shape checks.
  describe("single-instance-default-provider", () => {
    it("fails with zero providers", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      const result = await getCheck("single-instance-default-provider").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(false);
    });

    it("fails with two active admin-owned providers and none flagged default", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      await runner.withDataContext({ actorUserId: ADMIN_ID }, async (scopedDb) => {
        await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider One",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-one" })
        });
        await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider Two",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-two" })
        });
      });
      const result = await getCheck("single-instance-default-provider").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(false);
    });

    it("passes with exactly one provider flagged default", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      await runner.withDataContext({ actorUserId: ADMIN_ID }, async (scopedDb) => {
        const providerOne = await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider One",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-one" })
        });
        await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider Two",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-two" })
        });
        await repository.setInstanceDefaultProvider(scopedDb, providerOne.id);
      });
      const result = await getCheck("single-instance-default-provider").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(true);
    });
  });

  describe("chat-model-resolves", () => {
    it("fails when no model row carries the chat capability", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      await runner.withDataContext({ actorUserId: ADMIN_ID }, async (scopedDb) => {
        const provider = await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider One",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-one" })
        });
        await repository.setInstanceDefaultProvider(scopedDb, provider.id);
        await repository.createModel(scopedDb, {
          providerConfigId: provider.id,
          providerModelId: "embed-only-model",
          displayName: "Embed Only",
          capabilities: ["embedding"]
        });
      });
      const result = await getCheck("chat-model-resolves").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(false);
    });

    it("passes when a model with the chat capability resolves", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      await runner.withDataContext({ actorUserId: ADMIN_ID }, async (scopedDb) => {
        const provider = await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider One",
          encryptedCredential: createAiSecretCipher().encryptJson({ apiKey: "secret-one" })
        });
        await repository.setInstanceDefaultProvider(scopedDb, provider.id);
        await repository.createModel(scopedDb, {
          providerConfigId: provider.id,
          providerModelId: "chat-model",
          displayName: "Chat Model",
          capabilities: ["chat"]
        });
      });
      const result = await getCheck("chat-model-resolves").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(true);
    });
  });

  describe("provider-credential-decrypts", () => {
    it("fails when the stored envelope was encrypted under a different key", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      const otherKeyCipher = createAiSecretCipher({
        ...process.env,
        JARVIS_AI_SECRET_KEY: "a-completely-different-key"
      });
      await runner.withDataContext({ actorUserId: ADMIN_ID }, async (scopedDb) => {
        const provider = await repository.createProvider(scopedDb, {
          providerKind: "openai-compatible",
          displayName: "Provider One",
          encryptedCredential: otherKeyCipher.encryptJson({ apiKey: "secret-one" })
        });
        await repository.setInstanceDefaultProvider(scopedDb, provider.id);
      });
      const result = await getCheck("provider-credential-decrypts").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(false);
    });
  });

  // T7 — remaining checks and runDoctor composition.
  describe("no-uat-fixture-rows", () => {
    it("fails when a UAT admin fixture row is present", async () => {
      await insertUser(UAT_ADMIN_ID, UAT_ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      const result = await getCheck("no-uat-fixture-rows").run(deps(), UAT_ADMIN_ID);
      expect(result.ok).toBe(false);
    });

    it("passes when no UAT fixture row is present", async () => {
      await insertUser(ADMIN_ID, ADMIN_EMAIL, { isInstanceAdmin: true, status: "active" });
      const result = await getCheck("no-uat-fixture-rows").run(deps(), ADMIN_ID);
      expect(result.ok).toBe(true);
    });
  });

  describe("migrations-current", () => {
    it("fails on a database migrated to an earlier point", async () => {
      await deleteLastAppliedMigration();
      const result = await getCheck("migrations-current").run(deps(), null);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("pending");
    });
  });

  describe("cli-runner-reachable", () => {
    it("fails against a socket path that does not exist", async () => {
      const result = await getCheck("cli-runner-reachable").run(
        deps({ cliRunnerSocketPath: "/tmp/dev-instance-doctor-test-nonexistent.sock" }),
        null
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("runDoctor composition", () => {
    it("is not ok on a database with no admin, and names the admin check as the prerequisite for context-needing checks", async () => {
      const report = await runDoctor(deps());
      expect(report.ok).toBe(false);

      const activeAdmin = report.checks.find((c) => c.id === "active-instance-admin");
      expect(activeAdmin?.ok).toBe(false);

      for (const id of [
        "single-instance-default-provider",
        "chat-model-resolves",
        "provider-credential-decrypts"
      ] as const) {
        const check = report.checks.find((c) => c.id === id);
        expect(check?.ok).toBe(false);
        expect(check?.detail).toContain("active-instance-admin check must pass");
      }
    });
  });
});
