import { describe, expect, it } from "vitest";
import { sortThreadsByRecency } from "../../apps/web/src/chat/thread-recency.js";

describe("sortThreadsByRecency", () => {
  it("orders threads newest updatedAt first", () => {
    const threads = [
      { id: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "newest", updatedAt: "2026-03-01T00:00:00.000Z" },
      { id: "middle", updatedAt: "2026-02-01T00:00:00.000Z" }
    ];
    expect(sortThreadsByRecency(threads).map((t) => t.id)).toEqual(["newest", "middle", "old"]);
  });

  it("does not mutate the input array", () => {
    const threads = [
      { id: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", updatedAt: "2026-02-01T00:00:00.000Z" }
    ];
    sortThreadsByRecency(threads);
    expect(threads.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
