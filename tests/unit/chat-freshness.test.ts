import { describe, expect, it } from "vitest";
import type { DataContextDb } from "@moss/db";

import {
  resolveChatFreshness,
  toolNameToSource
} from "../../packages/chat/src/live/persistence.js";

const scopedDb = {} as DataContextDb;
const CAPTURED = new Date("2026-06-28T09:00:00.000Z");
const CAPTURED_ISO = CAPTURED.toISOString();

describe("toolNameToSource", () => {
  it("maps email.* to email", () =>
    expect(toolNameToSource("email.listVisibleMessages")).toBe("email"));
  it("maps calendar.* to calendar", () =>
    expect(toolNameToSource("calendar.listVisibleEvents")).toBe("calendar"));
  it("maps vault.* to vault", () => expect(toolNameToSource("vault.search")).toBe("vault"));
  it("maps notes.* to vault", () => expect(toolNameToSource("notes.search")).toBe("vault"));
  it("maps tasks.* to tasks", () => expect(toolNameToSource("tasks.list")).toBe("tasks"));
  it("maps commitments.* to commitments", () =>
    expect(toolNameToSource("commitments.listVisible")).toBe("commitments"));
  it("maps chat.* to chats", () => expect(toolNameToSource("chat.listTodaysTurns")).toBe("chats"));
  it("maps goals.* to goals", () => expect(toolNameToSource("goals.list")).toBe("goals"));
  it("returns null for unknown tools", () => expect(toolNameToSource("memory.recall")).toBeNull());
});

describe("resolveChatFreshness", () => {
  it("returns null when no tool names map to grounded sources", async () => {
    expect(
      await resolveChatFreshness(scopedDb, new Set(["memory.recall"]), CAPTURED, {})
    ).toBeNull();
  });

  it("returns null for empty tool set", async () => {
    expect(await resolveChatFreshness(scopedDb, new Set(), CAPTURED, {})).toBeNull();
  });

  it("returns realtime entries for tasks/commitments/chats/goals", async () => {
    const result = await resolveChatFreshness(
      scopedDb,
      new Set(["tasks.list", "commitments.listVisible"]),
      CAPTURED,
      {}
    );
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.capturedAt).toBe(CAPTURED_ISO);
    expect(result!.sources.find((s) => s.source === "tasks")?.freshnessKind).toBe("realtime");
    expect(result!.sources.find((s) => s.source === "commitments")?.asOf).toBe(CAPTURED_ISO);
  });

  it("resolves email connector_sync via connectorSyncAt", async () => {
    const emailAt = new Date("2026-06-27T20:00:00.000Z");
    const result = await resolveChatFreshness(
      scopedDb,
      new Set(["email.listVisibleMessages"]),
      CAPTURED,
      { connectorSyncAt: async () => emailAt }
    );
    expect(result!.sources.find((s) => s.source === "email")?.asOf).toBe(emailAt.toISOString());
  });

  it("serializes connector lookups on the shared transaction", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const result = await resolveChatFreshness(
      scopedDb,
      new Set(["email.listVisibleMessages", "calendar.listVisibleEvents"]),
      CAPTURED,
      {
        connectorSyncAt: async (_db, kind) => {
          calls.push(kind);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return null;
        }
      }
    );
    expect(calls).toEqual(["email", "calendar"]);
    expect(maxActive).toBe(1);
    expect(result?.sources.map((source) => source.source)).toEqual(["email", "calendar"]);
  });

  it("returns asOf: null for vault (no vaultLastWriteAt in V1)", async () => {
    const result = await resolveChatFreshness(scopedDb, new Set(["notes.search"]), CAPTURED, {});
    expect(result!.sources.find((s) => s.source === "vault")?.asOf).toBeNull();
  });

  it("connectorSyncAt throwing → asOf: null, does not throw", async () => {
    const result = await resolveChatFreshness(
      scopedDb,
      new Set(["calendar.listVisibleEvents"]),
      CAPTURED,
      {
        connectorSyncAt: async () => {
          throw new Error("network");
        }
      }
    );
    expect(result!.sources.find((s) => s.source === "calendar")?.asOf).toBeNull();
  });
});
