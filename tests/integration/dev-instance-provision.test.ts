import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { AiAutoRegisterService, AiRepository, createAiSecretCipher } from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import type { DevInstanceConfig } from "../../scripts/dev-instance/config.js";
import type { CliRunnerStatus, ProvisionDeps } from "../../scripts/dev-instance/provision.js";
import { runProvision } from "../../scripts/dev-instance/provision.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("dev-instance provision (#1258)", () => {
  let migrationDb: Kysely<MossDatabase>;
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let originalSecretKey: string | undefined;

  beforeAll(() => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "dev-instance-provision-test-key";

    migrationDb = createDatabase({
      connectionString: connectionStrings.migration,
      maxConnections: 1
    });
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

  function fakeConfig(overrides: Partial<DevInstanceConfig> = {}): DevInstanceConfig {
    return {
      providerKind: "anthropic",
      credentialFilePath: "/tmp/dev-instance-provision-test-credential.gpg",
      adminEmail: "owner@example.com",
      adminName: "Test Owner",
      adminPasswordFilePath: "/tmp/dev-instance-provision-test-password",
      cliHomeBase: "/tmp/dev-instance-provision-test-cli-home",
      cliRunnerSocketPath: "/tmp/dev-instance-provision-test-nonexistent.sock",
      ...overrides
    };
  }

  const notReachable: CliRunnerStatus = {
    reachable: false,
    socketPath: "/tmp/dev-instance-provision-test-nonexistent.sock",
    detail: "cli-runner not wired yet (Phase 3)"
  };

  function deps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
    const autoRegister = new AiAutoRegisterService({
      repository: new AiRepository(),
      cipher: createAiSecretCipher()
    });

    return {
      migrationDb,
      runner,
      autoRegister,
      config: fakeConfig(),
      signUpOwner: async () => {
        throw new Error("signUpOwner test double not configured for this test");
      },
      readAdminPassword: async () => "sentinel-admin-password-12345",
      ensureCliRunner: async () => notReachable,
      persistCliToken: async () => false,
      log: () => {},
      ...overrides
    };
  }

  async function insertActiveAdmin(id: string, email: string): Promise<void> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
         VALUES ($1, $2, 'Existing Admin', true, true, 'active')`,
        [id, email]
      );
    } finally {
      await client.end();
    }
  }

  function fakeSignUpOwner(userId: string): (input: {
    email: string;
    password: string;
    name: string;
  }) => Promise<{ userId: string }> {
    return async (input) => {
      await insertActiveAdmin(userId, input.email);
      return { userId };
    };
  }

  describe("admin-account step (T10)", () => {
    it("creates the admin account when none exists", async () => {
      let calls = 0;
      let recordedInput: { email: string; name: string } | undefined;
      const createAdmin = fakeSignUpOwner("11111111-1111-1111-1111-111111111111");
      const signUpOwner = async (input: {
        email: string;
        password: string;
        name: string;
      }): Promise<{ userId: string }> => {
        calls += 1;
        recordedInput = { email: input.email, name: input.name };
        return createAdmin(input);
      };

      const outcomes = await runProvision(deps({ signUpOwner }));
      const adminOutcome = outcomes.find((o) => o.id === "admin-account");

      expect(calls).toBe(1);
      expect(recordedInput).toEqual({ email: "owner@example.com", name: "Test Owner" });
      expect(adminOutcome?.changed).toBe(true);
    });

    it("does not call signUpOwner when an active admin already exists", async () => {
      await insertActiveAdmin("22222222-2222-2222-2222-222222222222", "existing@example.com");

      let calls = 0;
      const signUpOwner = async (): Promise<{ userId: string }> => {
        calls += 1;
        return { userId: "should-not-be-used" };
      };

      const outcomes = await runProvision(deps({ signUpOwner }));
      const adminOutcome = outcomes.find((o) => o.id === "admin-account");

      expect(calls).toBe(0);
      expect(adminOutcome?.changed).toBe(false);
    });
  });

  describe("the real signup driver (T11)", () => {
    it("creates a bootstrap owner with a usable credential row via signUpBootstrapOwner", async () => {
      const { signUpBootstrapOwner } = await import("../../scripts/dev-instance/signup.js");

      const result = await signUpBootstrapOwner({
        email: "real-signup@example.com",
        password: "a-real-password-123",
        name: "Real Signup"
      });

      const userRow = await migrationDb
        .selectFrom("app.users")
        .select(["id", "is_bootstrap_owner", "status"])
        .where("id", "=", result.userId)
        .executeTakeFirst();
      expect(userRow?.is_bootstrap_owner).toBe(true);
      expect(userRow?.status).toBe("active");

      const accountRow = await migrationDb
        .selectFrom("app.auth_accounts")
        .select(["id"])
        .where("user_id", "=", result.userId)
        .executeTakeFirst();
      expect(accountRow).toBeDefined();
    });
  });

  describe("provider-rows step (T12)", () => {
    it("registers the default provider and chat model via the real AiAutoRegisterService", async () => {
      const outcomes = await runProvision(
        deps({
          signUpOwner: fakeSignUpOwner("33333333-3333-3333-3333-333333333333")
        })
      );
      const providerRowsOutcome = outcomes.find((o) => o.id === "provider-rows");
      expect(providerRowsOutcome?.changed).toBe(true);

      const adminUserId = "33333333-3333-3333-3333-333333333333";
      const repository = new AiRepository();
      const context = { actorUserId: adminUserId, requestId: "test:provider-rows-check" };

      const providerId = await runner.withDataContext(context, (scopedDb) =>
        repository.resolveDefaultProviderId(scopedDb)
      );
      expect(providerId).not.toBeNull();

      const model = await runner.withDataContext(context, (scopedDb) =>
        repository.selectChatModelForUser(scopedDb)
      );
      expect(model?.capabilities).toContain("chat");
    });
  });

  describe("idempotence (T13)", () => {
    it("reports changed:false on every step on a second consecutive run", async () => {
      const signUpOwner = fakeSignUpOwner("44444444-4444-4444-4444-444444444444");

      await runProvision(deps({ signUpOwner }));

      const repository = new AiRepository();
      const context = {
        actorUserId: "44444444-4444-4444-4444-444444444444",
        requestId: "test:idempotence-check"
      };
      const providerId = await runner.withDataContext(context, (scopedDb) =>
        repository.resolveDefaultProviderId(scopedDb)
      );
      const providerBefore = await migrationDb
        .selectFrom("app.ai_provider_configs")
        .select(["updated_at"])
        .where("id", "=", providerId!)
        .executeTakeFirstOrThrow();
      const modelBefore = await migrationDb
        .selectFrom("app.ai_configured_models")
        .select(["id", "updated_at"])
        .where("provider_config_id", "=", providerId!)
        .executeTakeFirstOrThrow();

      const secondOutcomes = await runProvision(deps({ signUpOwner }));
      for (const outcome of secondOutcomes) {
        expect(outcome.changed).toBe(false);
      }

      const providerAfter = await migrationDb
        .selectFrom("app.ai_provider_configs")
        .select(["updated_at"])
        .where("id", "=", providerId!)
        .executeTakeFirstOrThrow();
      const modelAfter = await migrationDb
        .selectFrom("app.ai_configured_models")
        .select(["id", "updated_at"])
        .where("id", "=", modelBefore.id)
        .executeTakeFirstOrThrow();

      expect(providerAfter.updated_at).toEqual(providerBefore.updated_at);
      expect(modelAfter.updated_at).toEqual(modelBefore.updated_at);
    });
  });

  describe("no-leak and round-trip (T14)", () => {
    it("never logs the sentinel admin password", async () => {
      const sentinel = "sentinel-admin-password-12345";
      const loggedLines: string[] = [];
      const signUpOwner = fakeSignUpOwner("55555555-5555-5555-5555-555555555555");

      await runProvision(
        deps({
          signUpOwner,
          readAdminPassword: async () => sentinel,
          log: (line) => loggedLines.push(line)
        })
      );

      for (const line of loggedLines) {
        expect(line).not.toContain(sentinel);
      }
    });

    it("decrypts the default provider's stored credential with the production cipher setup", async () => {
      const signUpOwner = fakeSignUpOwner("66666666-6666-6666-6666-666666666666");
      await runProvision(deps({ signUpOwner }));

      const repository = new AiRepository();
      const context = {
        actorUserId: "66666666-6666-6666-6666-666666666666",
        requestId: "test:round-trip-check"
      };
      const providerId = await runner.withDataContext(context, (scopedDb) =>
        repository.resolveDefaultProviderId(scopedDb)
      );
      const providerRow = await migrationDb
        .selectFrom("app.ai_provider_configs")
        .select(["encrypted_credential"])
        .where("id", "=", providerId!)
        .executeTakeFirstOrThrow();

      const cipher = createAiSecretCipher(process.env);
      const decrypted = cipher.decryptJson(cipher.parseEnvelope(providerRow.encrypted_credential));
      expect(decrypted).toEqual({ cli: true });
    });

    it("fails to decrypt when provision ran under a different NODE_ENV without the real secret key", async () => {
      const signUpOwner = fakeSignUpOwner("77777777-7777-7777-7777-777777777777");
      await runProvision(deps({ signUpOwner }));

      const repository = new AiRepository();
      const context = {
        actorUserId: "77777777-7777-7777-7777-777777777777",
        requestId: "test:round-trip-nodeenv-check"
      };
      const providerId = await runner.withDataContext(context, (scopedDb) =>
        repository.resolveDefaultProviderId(scopedDb)
      );
      const providerRow = await migrationDb
        .selectFrom("app.ai_provider_configs")
        .select(["encrypted_credential"])
        .where("id", "=", providerId!)
        .executeTakeFirstOrThrow();

      const hardenedEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
      delete hardenedEnv.JARVIS_AI_SECRET_KEY;
      delete hardenedEnv.MOSS_AI_SECRET_KEY;

      expect(() => createAiSecretCipher(hardenedEnv)).toThrow();
      void providerRow;
    });
  });
});
