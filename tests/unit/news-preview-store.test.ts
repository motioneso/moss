import { describe, expect, it } from "vitest";

import { createPreviewStore } from "../../packages/news/src/discovery/preview-store.js";

const preview = (ownerUserId: string, createdAt: number) => ({
  ownerUserId,
  candidates: [],
  replaceSourceId: null,
  createdAt
});

describe("createPreviewStore", () => {
  it("keeps entries owner-scoped, single-use, and time-limited", () => {
    let now = 0;
    const store = createPreviewStore({ ttlMs: 100, now: () => now });
    const id = store.put(preview("owner-a", now));
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(store.take("owner-b", id)).toBeNull();
    expect(store.take("owner-a", id)).toEqual(preview("owner-a", 0));
    expect(store.take("owner-a", id)).toBeNull();

    const expired = store.put(preview("owner-a", now));
    now = 101;
    expect(store.take("owner-a", expired)).toBeNull();
  });

  it("evicts the oldest preview per owner without affecting other owners", () => {
    const store = createPreviewStore({ maxPerOwner: 2, now: () => 3 });
    const first = store.put(preview("owner-a", 1));
    const second = store.put(preview("owner-a", 2));
    const other = store.put(preview("owner-b", 1));
    const third = store.put(preview("owner-a", 3));

    expect(store.take("owner-a", first)).toBeNull();
    expect(store.take("owner-a", second)).not.toBeNull();
    expect(store.take("owner-a", third)).not.toBeNull();
    expect(store.take("owner-b", other)).not.toBeNull();
  });

  it("sweeps another owner's expired entry when a different owner puts", () => {
    let now = 0;
    const store = createPreviewStore({ ttlMs: 100, now: () => now });
    const abandoned = store.put(preview("owner-a", now));

    now = 101;
    store.put(preview("owner-b", now));

    expect(store.take("owner-a", abandoned)).toBeNull();
  });

  it("keeps an entry exactly ttlMs old and sweeps one ttlMs + 1 old", () => {
    let now = 0;
    const store = createPreviewStore({ ttlMs: 100, now: () => now });
    const atBoundary = store.put(preview("owner-a", now));
    const pastBoundary = store.put(preview("owner-a", now));

    now = 100;
    store.put(preview("owner-c", now));
    expect(store.take("owner-a", atBoundary)).not.toBeNull();

    now = 101;
    store.put(preview("owner-c", now));
    expect(store.take("owner-a", pastBoundary)).toBeNull();
  });
});
