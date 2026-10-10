import { describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { ConversationProvenanceStore } from "../../packages/chat/src/conversation-provenance.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const actor = "00000000-0000-4000-8000-000000000001";
const thread = "00000000-0000-4000-8000-000000000011";

function fixture(
  provenanceRows: Record<string, unknown>[] = [],
  options: { reserved?: boolean; failRelease?: boolean } = {}
) {
  const rows: Record<string, unknown>[] = [];
  const { scoped, queries } = makeRecordingDb({
    rows,
    beforeQuery: async (query) => {
      if (options.failRelease && query.startsWith("delete")) throw new Error("release failed");
      rows.splice(
        0,
        rows.length,
        ...(query.startsWith('select "reservation_id"')
          ? options.reserved
            ? [{ reservation_id: "active" }]
            : []
          : provenanceRows)
      );
    }
  });
  const accesses: string[] = [];
  const events: string[] = [];
  let activeTransactions = 0;
  const runner: Pick<DataContextRunner, "withDataContext"> = {
    withDataContext: async (access, work) => {
      accesses.push(access.actorUserId);
      events.push("begin");
      activeTransactions++;
      try {
        const value = await work(scoped);
        events.push("commit");
        return value;
      } finally {
        activeTransactions--;
      }
    }
  };
  return {
    store: new ConversationProvenanceStore(runner),
    queries,
    accesses,
    scoped,
    events,
    activeTransactions: () => activeTransactions
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    expect(await fixture().store.isTainted(actor, thread)).toBe(true);
  });

  it("reads only the bound thread and verifies both provenance and parent ownership", async () => {
    const { store, queries, accesses } = fixture([{ tainted_at: null, reserved: false }]);
    expect(await store.isTainted(actor, thread)).toBe(false);
    expect(accesses).toEqual([actor]);
    expect(queries[0]?.sql).toContain('inner join "app"."chat_threads" as "thread"');
    expect(queries[0]?.sql).toContain('"provenance"."thread_id" = $2');
    expect(queries[0]?.sql).toContain('"provenance"."owner_user_id" = $3');
    expect(queries[0]?.sql).toContain('"thread"."owner_user_id" = $4');
    expect(queries[0]?.parameters).toEqual([thread, thread, actor, actor]);
    expect(queries[0]?.sql).not.toContain("last_active_at");
  });

  it("does not cache a clean result across admissions or new store instances", async () => {
    const row = { tainted_at: null as Date | null, reserved: false };
    const { store, queries } = fixture([row]);
    expect(await store.isTainted(actor, thread)).toBe(false);
    row.tainted_at = new Date("2026-10-06T00:00:00Z");
    expect(await store.isTainted(actor, thread)).toBe(true);
    expect(queries).toHaveLength(2);
    expect(await fixture([row]).store.isTainted(actor, thread)).toBe(true);
  });

  it("treats a durable reservation as unsafe for an unguarded policy read", async () => {
    expect(
      await fixture([{ tainted_at: null, reserved: true }]).store.isTainted(actor, thread)
    ).toBe(true);
  });

  it("locks before admission, checks the reservation in a fresh statement and preserves first stamp", async () => {
    const { store, queries, accesses } = fixture([{ thread_id: thread }]);
    await store.recordAdmission(actor, thread, "app_action_outside");
    expect(accesses).toEqual([actor]);
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain('for update of "provenance"');
    expect(queries[1]?.sql).toContain('from "app"."chat_automatic_action_reservations"');
    expect(queries[2]?.sql).toContain('from "app"."chat_threads"');
    expect(queries[2]?.sql).toContain('"id" = $2 and "owner_user_id" = $3');
    expect(queries[2]?.sql).toContain('on conflict ("thread_id") do update');
    expect(queries[2]?.sql).toContain(
      "coalesce(app.chat_conversation_provenance.tainted_at, excluded.tainted_at)"
    );
    expect(queries[2]?.sql).toContain(
      "coalesce(app.chat_conversation_provenance.first_admission_path, excluded.first_admission_path)"
    );
    expect(queries[2]?.parameters).toEqual(["app_action_outside", thread, actor]);
  });

  it("refuses an admission when the owned parent is missing", async () => {
    await expect(
      fixture().store.recordAdmission(actor, thread, "tool_external_content")
    ).rejects.toThrow("Conversation is unavailable for content admission");
  });

  it("refuses admission without recording outside content while a reservation is active", async () => {
    const { store, queries } = fixture([{ tainted_at: null }], { reserved: true });
    await expect(store.recordAdmission(actor, thread, "attachment_read")).rejects.toThrow(
      "Conversation is unavailable for content admission"
    );
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.sql.startsWith("select"))).toBe(true);
  });

  it("propagates storage failure rather than representing failed admission as success", async () => {
    const failure = new Error("storage unavailable");
    const runner: Pick<DataContextRunner, "withDataContext"> = {
      withDataContext: vi.fn().mockRejectedValue(failure)
    };
    const store = new ConversationProvenanceStore(runner);
    await expect(store.recordAdmission(actor, thread, "attachment_read")).rejects.toBe(failure);
    await expect(store.isTainted(actor, thread)).rejects.toBe(failure);
    const run = vi.fn();
    expect(await store.runAutomatic(actor, thread, run)).toEqual({ kind: "confirm" });
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves atomic clean-row creation to the new-thread database trigger", async () => {
    const row = { id: thread, owner_user_id: actor };
    const { scoped, queries } = fixture([row]);
    expect(await new ChatRepository().openNewThread(scoped, { title: "New conversation" })).toEqual(
      row
    );
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(queries[1]?.sql).toContain('select "id" from "app"."chat_threads"');
    expect(queries[1]?.sql).toContain('"owner_user_id" = app.current_actor_user_id()');
    expect(queries[1]?.sql).toContain('"is_main" =');
    expect(queries[2]?.sql).toContain('insert into "app"."chat_threads"');
    expect(queries[2]?.sql).toContain("clock_timestamp()");
    expect(queries.some((query) => query.sql.includes('"chat_conversation_provenance"'))).toBe(
      false
    );
  });

  it("does not swallow new-thread trigger failure", async () => {
    const { scoped } = makeRecordingDb({
      rows: [{ id: thread, owner_user_id: actor }],
      beforeQuery: async (query) => {
        if (query.includes('insert into "app"."chat_threads"')) {
          throw new Error("provenance trigger failed");
        }
      }
    });
    await expect(
      new ChatRepository().openNewThread(scoped, { title: "New conversation" })
    ).rejects.toThrow("provenance trigger failed");
  });
});

describe("automatic execution reservation", () => {
  it.each([undefined, "not-a-thread"])("refuses an invalid binding: %s", async (binding) => {
    const { store, queries } = fixture([{ tainted_at: null }]);
    const run = vi.fn();
    expect(await store.runAutomatic(actor, binding, run)).toEqual({ kind: "confirm" });
    expect(run).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it.each([{ rows: [] }, { rows: [{ tainted_at: new Date() }] }])(
    "refuses unknown or tainted history",
    async ({ rows }) => {
      const { store, queries } = fixture(rows);
      const run = vi.fn();
      expect(await store.runAutomatic(actor, thread, run)).toEqual({ kind: "confirm" });
      expect(run).not.toHaveBeenCalled();
      expect(queries).toHaveLength(1);
    }
  );

  it("refuses a busy reservation without dispatch or deletion", async () => {
    const { store, queries } = fixture([{ tainted_at: null }], { reserved: true });
    const run = vi.fn();
    expect(await store.runAutomatic(actor, thread, run)).toEqual({ kind: "confirm" });
    expect(run).not.toHaveBeenCalled();
    expect(queries).toHaveLength(2);
  });

  it("commits the locked acquisition before callback and releases exactly its identity afterward", async () => {
    const { store, queries, events, activeTransactions } = fixture([{ tainted_at: null }]);
    const run = vi.fn(async () => {
      expect(events).toEqual(["begin", "commit"]);
      expect(activeTransactions()).toBe(0);
      events.push("callback");
      return { changed: true };
    });
    expect(await store.runAutomatic(actor, thread, run)).toEqual({
      kind: "ran",
      value: { changed: true }
    });
    expect(events).toEqual(["begin", "commit", "callback", "begin", "commit"]);
    expect(run).toHaveBeenCalledOnce();
    expect(queries).toHaveLength(4);
    expect(queries[0]?.sql).toContain('for update of "provenance"');
    expect(queries[0]?.parameters).toEqual([thread, actor, actor]);
    expect(queries[2]?.sql).toContain('insert into "app"."chat_automatic_action_reservations"');
    expect(queries[2]?.parameters).toEqual([thread, actor, expect.any(String)]);
    expect(queries[3]?.sql).toContain('"reservation_id" = $3');
    expect(queries[3]?.parameters).toEqual(queries[2]?.parameters);
  });

  it("does not release while the actual callback is still pending", async () => {
    const { store, queries } = fixture([{ tainted_at: null }]);
    const started = deferred<void>();
    const callback = deferred<string>();
    const operation = store.runAutomatic(actor, thread, async () => {
      started.resolve();
      return callback.promise;
    });
    await started.promise;
    expect(queries).toHaveLength(3);
    callback.resolve("finished");
    expect(await operation).toEqual({ kind: "ran", value: "finished" });
    expect(queries).toHaveLength(4);
  });

  it("propagates callback failure after cleanup, never offering confirmation or retry", async () => {
    const { store, queries } = fixture([{ tainted_at: null }]);
    const failure = new Error("callback failed");
    const run = vi.fn(async () => {
      throw failure;
    });
    await expect(store.runAutomatic(actor, thread, run)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(queries.at(-1)?.sql).toContain('delete from "app"."chat_automatic_action_reservations"');
  });

  it.each([false, true])(
    "propagates cleanup failure after callback (throws=%s)",
    async (throws) => {
      const { store } = fixture([{ tainted_at: null }], { failRelease: true });
      const run = vi.fn(async () => {
        if (throws) throw new Error("callback failed");
        return "already changed";
      });
      await expect(store.runAutomatic(actor, thread, run)).rejects.toThrow("release failed");
      expect(run).toHaveBeenCalledOnce();
    }
  );
});
