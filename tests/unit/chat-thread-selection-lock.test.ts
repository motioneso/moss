import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_SURFACE } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const threadId = "00000000-0000-4000-8000-000000000011";

describe("chat thread selection serialization", () => {
  it("does not refresh a delayed bound completion after another thread becomes current", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ id: "newly-current-thread" }] });
    expect(await new ChatRepository().touchCurrentThread(scoped, threadId)).toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(queries[0]?.sql).toContain("app.current_actor_user_id()");
    expect(queries[0]?.parameters).toEqual([DEFAULT_CHAT_SURFACE]);
    expect(queries[1]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
    expect(queries[1]?.sql).toContain('order by "last_active_at" desc, "id"');
    expect(queries.some((query) => query.sql.startsWith("update"))).toBe(false);
  });

  it("refreshes the still-current owner's activity under the same selection lock", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ id: threadId }] });
    expect(await new ChatRepository().touchCurrentThread(scoped, threadId)).toEqual({
      id: threadId
    });
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(queries[2]?.sql).toContain('update "app"."chat_threads"');
    expect(queries[2]?.sql).toContain("greatest(clock_timestamp()");
    expect(queries[2]?.sql).toContain("max(last_active_at) + interval '1 microsecond'");
    expect(queries[2]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
    expect(queries[2]?.parameters).toContain(threadId);
  });

  it("explicit resume uses the same actor/surface lock and a strictly later DB timestamp", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ id: threadId }] });
    await new ChatRepository().touchThread(scoped, threadId);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain("'chat:thread-selection:' || app.current_actor_user_id()");
    expect(queries[0]?.parameters).toEqual([DEFAULT_CHAT_SURFACE]);
    expect(queries[1]?.sql).toContain("max(last_active_at) + interval '1 microsecond'");
    expect(queries[1]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
  });
});
