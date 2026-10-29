import { describe, expect, it } from "vitest";

import type { HeartbeatSourceRead } from "@moss/shared";

import { filterCandidates, findingKey } from "../../packages/chat/src/heartbeat/filter.js";
import { changedSources } from "../../packages/chat/src/heartbeat/precheck.js";
import { validateHeartbeatResult } from "../../packages/chat/src/heartbeat/validator.js";

const candidate = {
  findingId: "11111111-1111-4111-8111-111111111111",
  source: "tasks" as const,
  item: {
    entityKey: "t1",
    episodeKey: "e1",
    title: "Send 3 invoices",
    at: "2026-10-29T15:00:00Z",
    kind: "task_due",
    facts: {}
  }
};

const read = (revision: string): HeartbeatSourceRead => ({
  source: "tasks",
  revision,
  nextBoundaryAt: null,
  freshness: "fresh",
  truncated: false,
  items: []
});

describe("changedSources", () => {
  const now = new Date("2026-10-29T10:00:00Z");
  it("flags a missing checkpoint, a new revision and a passed boundary only", () => {
    expect(changedSources([read("a")], new Map(), now)).toEqual(["tasks"]);
    expect(
      changedSources(
        [read("b")],
        new Map([["tasks", { revision: "a", nextBoundaryAt: null }]]),
        now
      )
    ).toEqual(["tasks"]);
    expect(
      changedSources(
        [read("a")],
        new Map([["tasks", { revision: "a", nextBoundaryAt: new Date("2026-10-29T09:00:00Z") }]]),
        now
      )
    ).toEqual(["tasks"]);
    expect(
      changedSources(
        [read("a")],
        new Map([["tasks", { revision: "a", nextBoundaryAt: new Date("2026-10-29T11:00:00Z") }]]),
        now
      )
    ).toEqual([]);
  });
});

describe("filterCandidates", () => {
  it("drops muted, topic-muted and already settled items", () => {
    const itemMute = { scope: "item", source: "tasks", entityKey: "t1", topic: null } as const;
    const topicMute = { scope: "topic", source: null, entityKey: null, topic: "INVOICES" } as const;
    expect(filterCandidates([candidate], [itemMute], new Set())).toEqual([]);
    expect(filterCandidates([candidate], [topicMute], new Set())).toEqual([]);
    expect(filterCandidates([candidate], [], new Set([findingKey("tasks", "t1", "e1")]))).toEqual(
      []
    );
    expect(filterCandidates([candidate], [], new Set())).toEqual([candidate]);
  });
});

describe("validateHeartbeatResult", () => {
  const ok = (note: string, intro: string | null = null) =>
    validateHeartbeatResult({ selected: [{ findingId: candidate.findingId, note }], intro }, [
      candidate
    ]);

  it("accepts a note whose numbers come from the item", () => {
    expect(ok("Those 3 invoices are due at 15:00.").ok).toBe(true);
  });
  it("rejects an unknown or repeated finding id", () => {
    const unknown = { selected: [{ findingId: "nope", note: "Hi." }], intro: null };
    expect(validateHeartbeatResult(unknown, [candidate]).ok).toBe(false);
    const dup = { findingId: candidate.findingId, note: "Hi." };
    expect(validateHeartbeatResult({ selected: [dup, dup], intro: null }, [candidate]).ok).toBe(
      false
    );
  });
  it("rejects a number the evidence does not support, and any digit in the intro", () => {
    expect(ok("That is 9 invoices.").ok).toBe(false);
    expect(ok("Fine.", "You have 3 things.").ok).toBe(false);
  });
  it("rejects overlong notes", () => {
    expect(ok("x".repeat(281)).ok).toBe(false);
  });
});
