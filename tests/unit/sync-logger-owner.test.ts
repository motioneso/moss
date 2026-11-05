import { describe, expect, it, vi } from "vitest";

import { bindSyncLoggerOwner } from "../../packages/connectors/src/sync-jobs.js";

const ownerA = "00000000-0000-4000-8000-00000000000a";
const ownerB = "00000000-0000-4000-8000-00000000000b";

describe("bindSyncLoggerOwner", () => {
  it("adds the job owner as a top-level field on warn and info", () => {
    const base = { warn: vi.fn(), info: vi.fn() };
    const bound = bindSyncLoggerOwner(base, ownerA);
    bound.warn({ stage: "auth" }, "google-sync auth failed");
    bound.info({ event: "x" }, "note");
    expect(base.warn).toHaveBeenCalledWith(
      { stage: "auth", actorUserId: ownerA },
      "google-sync auth failed"
    );
    expect(base.info).toHaveBeenCalledWith({ event: "x", actorUserId: ownerA }, "note");
  });

  it("keeps two owners apart on one shared logger", () => {
    const base = { warn: vi.fn(), info: vi.fn() };
    bindSyncLoggerOwner(base, ownerA).warn({}, "m");
    bindSyncLoggerOwner(base, ownerB).warn({}, "m");
    expect(base.warn.mock.calls.map((c) => c[0].actorUserId)).toEqual([ownerA, ownerB]);
  });
});
