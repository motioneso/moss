import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiRepository } from "@moss/ai";
import { TasksRepository } from "@moss/tasks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UAT_ADMIN_EMAIL, UAT_SECOND_OWNER_EMAIL } from "./admin.js";
import { createAppRuntimeRunner, createMigrationOwnerDb } from "./connections.js";
import { seedLevel } from "./levels.js";
import { UAT_SEED_BASE_TIMESTAMP } from "./timestamps.js";

// #1025: seedLevel("admin+data") composes the notes chunk, which writes real
// files through VaultContext — same JARVIS_VAULT_ROOT override as
// chunks/notes.test.ts, needed here because the real default (/data/vaults)
// doesn't exist on this dev host outside Docker.
let prevVaultRoot: string | undefined;

beforeAll(async () => {
  prevVaultRoot = process.env["JARVIS_VAULT_ROOT"];
  process.env["JARVIS_VAULT_ROOT"] = await mkdtemp(join(tmpdir(), "uat-seed-levels-"));
});

afterAll(() => {
  if (prevVaultRoot === undefined) delete process.env["JARVIS_VAULT_ROOT"];
  else process.env["JARVIS_VAULT_ROOT"] = prevVaultRoot;
});

describe("seedLevel", () => {
  it("bare seeds nothing beyond the migrated schema", async () => {
    await seedLevel({ level: "bare" });
    // no users/data — nothing further to assert beyond "did not throw"
  });

  it("admin+data excludes named chunks", async () => {
    await seedLevel({ level: "admin+data", excludeChunks: ["news"] });
    const db = createMigrationOwnerDb();
    try {
      const admin = await db
        .selectFrom("app.users")
        .selectAll()
        .where("email", "=", "uat-admin@jarv1s.local")
        .executeTakeFirstOrThrow();
      expect(admin.is_instance_admin).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  // #1087 finding 3: admin+data must leave EVERY external module NOT installed by
  // default (spec §4.4's absent-module UI path for #1026) even when the caller passes
  // no excludeChunks at all. The old code excluded the installing chunk only when a
  // caller remembered to say so, so it silently installed by default. Asserting the
  // whole table is empty keeps this true for any module added later.
  it("admin+data installs no external module when no excludeChunks is passed", async () => {
    await seedLevel({ level: "admin+data" });
    const db = createMigrationOwnerDb();
    try {
      const rows = await db.selectFrom("app.external_modules").select(["id", "status"]).execute();
      expect(rows).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("seeds idempotent private data plus one explicit cross-user share", async () => {
    await seedLevel({ level: "multi-user", excludeChunks: ["news"] });
    await seedLevel({ level: "multi-user", excludeChunks: ["news"] });

    const migrationDb = createMigrationOwnerDb();
    let users: Array<{ id: string; email: string }>;
    try {
      users = await migrationDb
        .selectFrom("app.users")
        .select(["id", "email"])
        .where("email", "in", [UAT_ADMIN_EMAIL, UAT_SECOND_OWNER_EMAIL])
        .execute();
    } finally {
      await migrationDb.destroy();
    }
    expect(users).toHaveLength(2);

    const admin = users.find((user) => user.email === UAT_ADMIN_EMAIL)!;
    const owner2 = users.find((user) => user.email === UAT_SECOND_OWNER_EMAIL)!;
    const tasks = new TasksRepository();
    const runner = createAppRuntimeRunner();
    try {
      const { shared: adminShared, privateTask: adminPrivate } = await runner.withDataContext(
        { actorUserId: admin.id },
        async (scopedDb) => {
          const owned = await scopedDb.db
            .selectFrom("app.tasks")
            .selectAll()
            .where("owner_user_id", "=", admin.id)
            .where("source", "=", "uat-seed")
            .execute();
          expect(owned).toHaveLength(12);
          return {
            shared: owned.find((task) => task.external_key === "Draft Q1 planning doc")!,
            privateTask: owned.find((task) => task.external_key === "Review PR backlog")!
          };
        }
      );
      const owner2Private = await runner.withDataContext(
        { actorUserId: owner2.id },
        async (scopedDb) => {
          const owned = await scopedDb.db
            .selectFrom("app.tasks")
            .selectAll()
            .where("owner_user_id", "=", owner2.id)
            .where("source", "=", "uat-seed")
            .execute();
          expect(owned).toHaveLength(12);
          return owned.find((task) => task.external_key === "Review PR backlog")!;
        }
      );

      await runner.withDataContext({ actorUserId: admin.id }, async (scopedDb) => {
        await expect(tasks.getById(scopedDb, owner2Private.id)).resolves.toBeUndefined();
        const shares = await scopedDb.db
          .selectFrom("app.shares")
          .selectAll()
          .where("resource_type", "=", "task")
          .where("resource_id", "=", adminShared.id)
          .execute();
        expect(shares).toHaveLength(1);
        expect(shares[0]).toMatchObject({
          owner_user_id: admin.id,
          grantee_user_id: owner2.id,
          level: "view",
          created_at: UAT_SEED_BASE_TIMESTAMP,
          updated_at: UAT_SEED_BASE_TIMESTAMP
        });
      });
      await runner.withDataContext({ actorUserId: owner2.id }, async (scopedDb) => {
        await expect(tasks.getById(scopedDb, adminPrivate.id)).resolves.toBeUndefined();
        await expect(tasks.getById(scopedDb, adminShared.id)).resolves.toMatchObject({
          id: adminShared.id
        });
      });

      // FIN-04 (#1149): finance is ADMIN-ONLY at multi-user — the chunk's fixed
      // account ids would otherwise exist as owner2's OWN accounts and break the
      // shared-pool UAT's "member does NOT see the unshared account" assertion.
      const financeKvCount = (userId: string) =>
        runner.withDataContext({ actorUserId: userId }, async (scopedDb) => {
          const rows = await scopedDb.db
            .selectFrom("app.module_kv")
            .select("id")
            .where("module_id", "=", "finance")
            .where("owner_user_id", "=", userId)
            .execute();
          return rows.length;
        });
      expect(await financeKvCount(admin.id)).toBeGreaterThan(0);
      expect(await financeKvCount(owner2.id)).toBe(0);
    } finally {
      await runner.destroy();
    }
  });

  // #1121: without an explicit chatScript, solo-admin still has no usable real assistant chat
  // engine — same gap chunks/ai.test.ts's #1121 red check proves at admin+data.
  it("solo-admin without chatScript leaves no chat-capable model", async () => {
    await seedLevel({ level: "solo-admin" });

    const migrationDb = createMigrationOwnerDb();
    let adminId: string;
    try {
      const admin = await migrationDb
        .selectFrom("app.users")
        .select(["id"])
        .where("email", "=", UAT_ADMIN_EMAIL)
        .executeTakeFirstOrThrow();
      adminId = admin.id;
    } finally {
      await migrationDb.destroy();
    }

    const aiRepo = new AiRepository();
    const runner = createAppRuntimeRunner();
    try {
      await runner.withDataContext({ actorUserId: adminId }, async (scopedDb) => {
        const chatModel = await aiRepo.selectChatModelForUser(scopedDb);
        expect(chatModel).toBeNull();
      });
    } finally {
      await runner.destroy();
    }
  });

  it("solo-admin with chatScript: phase1-smoke resolves the neutral scripted model", async () => {
    const migrationDb = createMigrationOwnerDb();
    let adminId: string;
    try {
      const admin = await migrationDb
        .selectFrom("app.users")
        .select(["id"])
        .where("email", "=", UAT_ADMIN_EMAIL)
        .executeTakeFirstOrThrow();
      adminId = admin.id;
    } finally {
      await migrationDb.destroy();
    }

    const aiRepo = new AiRepository();
    const runner = createAppRuntimeRunner();
    try {
      // #1121: earlier it() blocks in this file (admin+data, multi-user) already seeded an
      // assistant provider for this same fixed admin id, in the same shared, un-reset gate DB.
      // resolveDefaultProviderId's un-pinned fallback only resolves when the admin owns exactly
      // one active assistant provider, so neutralize those before seeding the scripted one —
      // matches the real deployment shape (a fresh solo-admin container has none), doesn't touch
      // production seed code, and doesn't affect other test files.
      await runner.withDataContext({ actorUserId: adminId }, async (scopedDb) => {
        await scopedDb.db
          .updateTable("app.ai_provider_configs")
          .set({ status: "disabled" })
          .where("purpose", "=", "assistant")
          .execute();
      });

      await seedLevel({ level: "solo-admin", chatScript: "phase1-smoke" });

      await runner.withDataContext({ actorUserId: adminId }, async (scopedDb) => {
        const chatModel = await aiRepo.selectChatModelForUser(scopedDb);
        expect(chatModel).not.toBeNull();
        expect(chatModel?.provider_kind).toBe("anthropic");
        expect(chatModel?.capabilities).toContain("chat");
      });
    } finally {
      await runner.destroy();
    }
  });
});
