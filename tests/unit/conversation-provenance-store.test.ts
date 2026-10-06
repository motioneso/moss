import { describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const actor = "00000000-0000-4000-8000-000000000001";
const thread = "00000000-0000-4000-8000-000000000011";

function fixture(rows: Record<string, unknown>[] = []) {
  const { scoped, queries } = makeRecordingDb({ rows });
  const accesses: string[] = [];
  const runner: Pick<DataContextRunner, "withDataContext"> = {
    withDataContext: async (access, work) => {
      accesses.push(access.actorUserId);
      return work(scoped);
    }
  };
  return { store: new ConversationProvenanceStore(runner), queries, accesses, scoped };
}

describe("durable conversation provenance store", () => {
  it.each([undefined, "", "not-a-thread"])(
    "fails closed for an absent or invalid binding: %s",
    async (id) => {
      const { store, queries, accesses } = fixture();
      expect(await store.isTainted(actor, id)).toBe(true);
      expect(queries).toEqual([]);
      expect(accesses).toEqual([]);
    }
  );

  it("fails closed when owner-scoped storage returns no row", async () => {
    const { store } = fixture();
    expect(await store.isTainted(actor, thread)).toBe(true);
  });

  it("reads only the bound thread and verifies both provenance and parent ownership", async () => {
    const { store, queries, accesses } = fixture([{ tainted_at: null }]);
    expect(await store.isTainted(actor, thread)).toBe(false);
    expect(accesses).toEqual([actor]);
    expect(queries[0]?.sql).toContain('inner join "app"."chat_threads" as "thread"');
    expect(queries[0]?.sql).toContain('"provenance"."thread_id" = $1');
    expect(queries[0]?.sql).toContain('"provenance"."owner_user_id" = $2');
    expect(queries[0]?.sql).toContain('"thread"."owner_user_id" = $3');
    expect(queries[0]?.parameters).toEqual([thread, actor, actor]);
    expect(queries[0]?.sql).not.toContain("last_active_at");
  });

  it("does not cache a clean result across admissions or new store instances", async () => {
    const row = { tainted_at: null as Date | null };
    const { store, queries } = fixture([row]);
    expect(await store.isTainted(actor, thread)).toBe(false);
    row.tainted_at = new Date("2026-10-06T00:00:00Z");
    expect(await store.isTainted(actor, thread)).toBe(true);
    expect(queries).toHaveLength(2);
    expect(await fixture([row]).store.isTainted(actor, thread)).toBe(true);
  });

  it("inserts admissions only for an owned thread and preserves the first stamp on conflict", async () => {
    const { store, queries, accesses } = fixture([{ thread_id: thread }]);
    await store.recordAdmission(actor, thread, "app_action_outside");
    expect(accesses).toEqual([actor]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('from "app"."chat_threads"');
    expect(queries[0]?.sql).toContain('"id" = $2 and "owner_user_id" = $3');
    expect(queries[0]?.sql).toContain('on conflict ("thread_id") do update');
    expect(queries[0]?.sql).toContain(
      "coalesce(app.chat_conversation_provenance.tainted_at, excluded.tainted_at)"
    );
    expect(queries[0]?.sql).toContain(
      "coalesce(app.chat_conversation_provenance.first_admission_path, excluded.first_admission_path)"
    );
    expect(queries[0]?.parameters).toEqual(["app_action_outside", thread, actor]);
  });

  it("refuses an admission when the owned parent is missing", async () => {
    await expect(
      fixture().store.recordAdmission(actor, thread, "tool_external_content")
    ).rejects.toThrow("Conversation is unavailable for content admission");
  });

  it("propagates storage failure rather than representing failed admission as success", async () => {
    const failure = new Error("storage unavailable");
    const runner: Pick<DataContextRunner, "withDataContext"> = {
      withDataContext: vi.fn().mockRejectedValue(failure)
    };
    const store = new ConversationProvenanceStore(runner);
    await expect(store.recordAdmission(actor, thread, "attachment_read")).rejects.toBe(failure);
    await expect(store.isTainted(actor, thread)).rejects.toBe(failure);
  });

  it("creates clean provenance immediately after a new thread on the same scoped handle", async () => {
    const row = { id: thread, owner_user_id: actor };
    const { scoped, queries } = fixture([row]);
    expect(await new ChatRepository().openNewThread(scoped, { title: "New conversation" })).toEqual(
      row
    );
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(queries[1]?.sql).toContain('insert into "app"."chat_threads"');
    expect(queries[1]?.sql).toContain("clock_timestamp()");
    expect(queries[2]?.sql).toContain('insert into "app"."chat_conversation_provenance"');
    expect(queries[2]?.parameters).toEqual([thread, actor]);
    expect(queries[2]?.sql).not.toContain("on conflict");
  });

  it("does not swallow clean-provenance insertion failure", async () => {
    const { scoped } = makeRecordingDb({
      rows: [{ id: thread, owner_user_id: actor }],
      beforeQuery: async (query) => {
        if (query.includes('insert into "app"."chat_conversation_provenance"')) {
          throw new Error("provenance insert failed");
        }
      }
    });
    await expect(
      new ChatRepository().openNewThread(scoped, { title: "New conversation" })
    ).rejects.toThrow("provenance insert failed");
  });
});
