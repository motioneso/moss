import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { ChatSkillsRepository } from "@moss/chat";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000051";
const otherUserId = "00000000-0000-4000-8000-000000000052";

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "req:chat-skills-test" };
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'skills-a@example.test', false), ($2, 'skills-b@example.test', false)`,
      [userId, otherUserId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("ChatSkillsRepository", () => {
  const repo = new ChatSkillsRepository();

  it("create persists frontmatter + body; get round-trips them", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const created = await repo.create(scopedDb, {
        name: "Standup Notes",
        description: "Summarize standup",
        frontmatter: { trigger: "/standup" },
        body: "Summarize the last standup thread.",
        source: "authored"
      });
      expect(created.name).toBe("Standup Notes");
      expect(created.frontmatter).toEqual({ trigger: "/standup" });
      expect(created.enabled).toBe(true);
      expect(created.source).toBe("authored");

      const fetched = await repo.get(scopedDb, created.id);
      expect(fetched?.body).toBe("Summarize the last standup thread.");
      expect(fetched?.frontmatter).toEqual({ trigger: "/standup" });
    });
  });

  it("create defaults frontmatter to {} when omitted", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const created = await repo.create(scopedDb, {
        name: "No Frontmatter",
        body: "Body only.",
        source: "authored"
      });
      expect(created.frontmatter).toEqual({});
    });
  });

  it("allows duplicate names (no unique constraint)", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const first = await repo.create(scopedDb, {
        name: "Duplicate",
        body: "First body.",
        source: "authored"
      });
      const second = await repo.create(scopedDb, {
        name: "Duplicate",
        body: "Second body.",
        source: "authored"
      });
      expect(first.id).not.toBe(second.id);
      expect(first.name).toBe(second.name);
    });
  });

  it("list is owner-scoped and ordered enabled-first, then updated_at desc", async () => {
    // Each create runs in its own withDataContext call (own transaction) so updated_at
    // timestamps are distinct — within one transaction now() ties, making ordering
    // among equal timestamps arbitrary instead of exercising the real ordering rule.
    await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.create(scopedDb, { name: "Older Enabled", body: "b1", source: "authored" })
    );
    const disabled = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.create(scopedDb, { name: "Disabled", body: "b2", source: "authored" })
    );
    await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.setEnabled(scopedDb, disabled.id, false)
    );
    await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.create(scopedDb, { name: "Newer Enabled", body: "b3", source: "authored" })
    );

    // All three rows belong to otherUserId; enabled ones first (newest updated first), then disabled.
    const list = await dataContext.withDataContext(ctx(otherUserId), (scopedDb) =>
      repo.list(scopedDb)
    );
    const names = list.map((s) => s.name);
    expect(names.indexOf("Newer Enabled")).toBeLessThan(names.indexOf("Older Enabled"));
    expect(names.indexOf("Older Enabled")).toBeLessThan(names.indexOf("Disabled"));

    // Owner scoping: userId's list must not contain otherUserId's rows.
    const userList = await dataContext.withDataContext(ctx(userId), (scopedDb) =>
      repo.list(scopedDb)
    );
    expect(userList.some((s) => s.id === disabled.id)).toBe(false);
  });

  it("update only changes provided fields and bumps updated_at", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const created = await repo.create(scopedDb, {
        name: "Editable",
        description: "original description",
        frontmatter: { a: 1 },
        body: "original body",
        source: "authored"
      });

      // `create` takes its `updated_at` from the database's `now()`, but `update` stamps it from
      // the app clock (`new Date()` in ChatSkillsRepository.update). On a fast machine the two
      // writes land in the same millisecond and the strict inequality below flaked (#2537). Pin
      // the app clock strictly after the created row's timestamp so the bump is deterministic
      // instead of dependent on a lucky clock tick. Only `Date` is faked, so pg's connections and
      // timers are untouched.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const createdMs = created.updated_at.getTime();
        vi.setSystemTime(new Date(createdMs + 1_000));

        const updated = await repo.update(scopedDb, created.id, { body: "new body" });
        expect(updated?.body).toBe("new body");
        expect(updated?.name).toBe("Editable");
        expect(updated?.description).toBe("original description");
        expect(updated?.frontmatter).toEqual({ a: 1 });
        expect(updated?.updated_at.getTime()).toBeGreaterThan(createdMs);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("update returns undefined for a non-existent id", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const result = await repo.update(scopedDb, "00000000-0000-4000-8000-000000009999", {
        body: "x"
      });
      expect(result).toBeUndefined();
    });
  });

  it("setEnabled toggles the enabled flag", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const created = await repo.create(scopedDb, {
        name: "Togglable",
        body: "b",
        source: "authored"
      });
      expect(created.enabled).toBe(true);
      const disabled = await repo.setEnabled(scopedDb, created.id, false);
      expect(disabled?.enabled).toBe(false);
      const reenabled = await repo.setEnabled(scopedDb, created.id, true);
      expect(reenabled?.enabled).toBe(true);
    });
  });

  it("delete removes the row and reports success", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const created = await repo.create(scopedDb, {
        name: "Deletable",
        body: "b",
        source: "authored"
      });
      const deleted = await repo.delete(scopedDb, created.id);
      expect(deleted).toBe(true);
      const fetched = await repo.get(scopedDb, created.id);
      expect(fetched).toBeUndefined();
    });
  });

  it("delete returns false for a non-existent id", async () => {
    await dataContext.withDataContext(ctx(userId), async (scopedDb) => {
      const deleted = await repo.delete(scopedDb, "00000000-0000-4000-8000-000000009998");
      expect(deleted).toBe(false);
    });
  });

  it("create throws on an unbranded handle (DataContextDb guard)", async () => {
    await expect(
      repo.create(appDb as unknown as never, { name: "x", body: "y", source: "authored" })
    ).rejects.toThrow("Repository access requires withDataContext");
  });
});
