import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";

import {
  RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE,
  retireShadowRecordPurgeQueue
} from "../../packages/chat/src/jobs.js";

// #2911 — installs that ran 0251's 7-day purge can still hold the retired queue and its daily
// schedule in pgboss. The tidy-up must drop both when present and be a quiet no-op otherwise.

class BossMock {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  schedules: Array<{ name: string; key: string | null }> = [];
  queues = new Set<string>();

  async getSchedules(): Promise<Array<{ name: string; key: string | null }>> {
    this.calls.push({ method: "getSchedules", args: [] });
    return [...this.schedules];
  }

  async getQueue(name: string): Promise<{ name: string } | null> {
    this.calls.push({ method: "getQueue", args: [name] });
    return this.queues.has(name) ? { name } : null;
  }

  async unschedule(name: string, key?: string): Promise<void> {
    this.calls.push({ method: "unschedule", args: [name, key] });
  }

  async deleteQueue(name: string): Promise<void> {
    this.calls.push({ method: "deleteQueue", args: [name] });
    this.queues.delete(name);
  }

  methodsFor(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }
}

const asBoss = (mock: BossMock) => mock as unknown as PgBoss;

describe("retireShadowRecordPurgeQueue (#2911)", () => {
  it("drops the retired queue and its schedule, leaving other queues alone", async () => {
    const boss = new BossMock();
    boss.schedules = [
      { name: RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE, key: "daily" },
      { name: "chat.embed-turn", key: "keep" }
    ];
    boss.queues = new Set([RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE, "chat.embed-turn"]);
    const logger = { info: vi.fn() };

    await retireShadowRecordPurgeQueue(asBoss(boss), logger);

    expect(boss.methodsFor("unschedule")).toEqual([
      [RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE, "daily"]
    ]);
    expect(boss.methodsFor("deleteQueue")).toEqual([[RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE]]);
    expect(boss.queues.has(RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE)).toBe(false);
    expect(boss.queues.has("chat.embed-turn")).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("is a quiet no-op on a fresh install with neither queue nor schedule", async () => {
    const boss = new BossMock();
    const logger = { info: vi.fn() };

    await retireShadowRecordPurgeQueue(asBoss(boss), logger);

    expect(boss.methodsFor("unschedule")).toEqual([]);
    expect(boss.methodsFor("deleteQueue")).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
