import { describe, expect, it } from "vitest";

import { readHeartbeatMuteResult } from "../../packages/shared/src/heartbeat-api.js";

const mute = { id: "m1", label: "Gym", scope: "topic", createdAt: "2026-10-29T00:00:00.000Z" };

describe("readHeartbeatMuteResult", () => {
  it("keeps only the known fields of a saved mute", () => {
    expect(
      readHeartbeatMuteResult({ status: "muted", mute: { ...mute, extra: 1 }, junk: 2 })
    ).toEqual({
      status: "muted",
      mute
    });
  });

  it("reads choices and not_found", () => {
    expect(
      readHeartbeatMuteResult({ status: "choose", candidates: [{ label: "A", findingId: "f1" }] })
    ).toEqual({ status: "choose", candidates: [{ label: "A", findingId: "f1" }] });
    expect(readHeartbeatMuteResult({ status: "not_found" })).toEqual({ status: "not_found" });
  });

  it.each([
    undefined,
    null,
    "muted",
    [],
    {},
    { status: "other" },
    { status: "muted" },
    { status: "muted", mute: { ...mute, scope: "everything" } },
    { status: "muted", mute: { id: 1, label: "x", scope: "topic", createdAt: "t" } },
    { status: "choose", candidates: [{ label: "A" }] },
    { status: "choose", candidates: "none" }
  ])("rejects malformed input %j", (value) => {
    expect(readHeartbeatMuteResult(value)).toBeUndefined();
  });
});
