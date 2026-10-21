import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";
import { CHAT_DELIVER_REMINDER_QUEUE } from "../../packages/chat/src/reminders/deliver.js";
import { reminderSavedReply } from "../../packages/chat/src/reminders/wording.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #3543: an account that has never chatted can make its first message a reminder. The turn
// opens Main before the reminder is answered, exactly as a first model turn would.

const { Client } = pg;
const executed = { provider: "anthropic", model: "offline-fixture" } as const;

let appDb: Kysely<MossDatabase>;
let appBoss: PgBoss;
let bootstrap: pg.Client;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  appBoss = createPgBossClient(connectionStrings.app);
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await Promise.all([appBoss.start(), bootstrap.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([
    appBoss?.stop({ graceful: false }),
    appDb?.destroy(),
    bootstrap?.end()
  ]);
});

function runtime() {
  const store = new DataContextChatPersistence({
    dataContext: new DataContextRunner(appDb),
    chatRepository: new ChatRepository(),
    aiRepository: new AiRepository(),
    boss: appBoss
  });
  vi.spyOn(store, "resolveActiveProvider").mockResolvedValue({
    ...executed,
    providerConfigId: "offline-provider",
    authMethod: "cli",
    acpAgentId: "claude"
  });
  const launch = vi.fn(async () => ({ offset: 0 }));
  const engine: CliChatEngine = {
    provider: executed.provider,
    launch,
    async submit() {},
    async interrupt() {},
    async readNew() {
      return { records: [{ kind: "reply", text: "model answer" }], offset: 1, complete: true };
    },
    async isAlive() {
      return true;
    },
    async kill() {}
  };
  const manager = new ChatSessionManager({
    persistence: store,
    engineFactory: () => engine,
    personaFs: { async mkdir() {}, async writeFile() {} },
    clock: { now: () => 1_725_000_000_000 },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "First reminder fixture",
    serverOwnsDrain: true
  });
  return { manager, launch };
}

async function threadsOf(actorUserId: string) {
  const result = await bootstrap.query<{ id: string; is_main: boolean; surface: string }>(
    "SELECT id, is_main, surface FROM app.chat_threads WHERE owner_user_id = $1",
    [actorUserId]
  );
  return result.rows;
}

describe("first reminder on a fresh account (#3543)", () => {
  it("opens Main and saves the reminder there without starting the model", async () => {
    const actor = ids.userB;
    expect(await threadsOf(actor)).toEqual([]);
    const { manager, launch } = runtime();

    const result = await manager.submitTurn(actor, "Owner", "remind me in 10 minutes to stretch");

    expect(result.reply).toBe(reminderSavedReply(600, "stretch"));
    expect(launch).not.toHaveBeenCalled();
    const threads = await threadsOf(actor);
    expect(threads).toEqual([expect.objectContaining({ is_main: true, surface: "drawer" })]);
    const reminder = await bootstrap.query(
      "SELECT id, thread_id, reminder_text, state FROM app.chat_reminders WHERE owner_user_id = $1",
      [actor]
    );
    expect(reminder.rows).toEqual([
      expect.objectContaining({
        thread_id: threads[0]!.id,
        reminder_text: "stretch",
        state: "queued"
      })
    ]);
    const job = await bootstrap.query(
      "SELECT 1 FROM pgboss.job WHERE name = $1 AND data->>'resourceId' = $2",
      [CHAT_DELIVER_REMINDER_QUEUE, reminder.rows[0].id]
    );
    expect(job.rows).toHaveLength(1);

    // The next ordinary turn joins the same Main rather than opening another conversation.
    await manager.submitTurn(actor, "Owner", "thanks");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(await threadsOf(actor)).toEqual(threads);
    await manager.clear(actor);
  });
});
