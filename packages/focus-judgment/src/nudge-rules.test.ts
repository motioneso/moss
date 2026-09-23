import { describe, expect, it } from "vitest";

import { decideNudge, type RecentJudgment } from "./nudge-rules.js";

const NOW = new Date("2026-09-21T10:00:00.000Z");
const OPTIONS = { capMinutes: 45, inQuietHours: false };

function at(minutesAgo: number): Date {
  return new Date(NOW.getTime() - minutesAgo * 60_000);
}

function judgments(...labels: RecentJudgment["label"][]): RecentJudgment[] {
  return labels.map((label, index) => ({ label, at: at(index * 5) }));
}

describe("decideNudge", () => {
  it("nudges on two distracted judgments in a row", () => {
    expect(decideNudge(judgments("distracted", "distracted"), null, NOW, OPTIONS)).toBe(true);
  });

  it("does not nudge on a single distracted judgment (fails if one sample is enough)", () => {
    expect(decideNudge(judgments("distracted"), null, NOW, OPTIONS)).toBe(false);
  });

  it("does not nudge when a detour or an unknown sits between (fails if the run ignores them)", () => {
    expect(decideNudge(judgments("distracted", "necessary_detour"), null, NOW, OPTIONS)).toBe(
      false
    );
    expect(decideNudge(judgments("distracted", "insufficient_evidence"), null, NOW, OPTIONS)).toBe(
      false
    );
    expect(decideNudge(judgments("necessary_detour", "distracted"), null, NOW, OPTIONS)).toBe(
      false
    );
  });

  it("never nudges on insufficient evidence or focus", () => {
    expect(
      decideNudge(judgments("insufficient_evidence", "insufficient_evidence"), null, NOW, OPTIONS)
    ).toBe(false);
    expect(decideNudge(judgments("focused", "focused"), null, NOW, OPTIONS)).toBe(false);
  });

  it("refuses a nudge inside the cap window and allows one after it", () => {
    const recent = judgments("distracted", "distracted");
    expect(decideNudge(recent, at(44), NOW, OPTIONS)).toBe(false);
    expect(decideNudge(recent, at(45), NOW, OPTIONS)).toBe(true);
    expect(decideNudge(recent, at(300), NOW, OPTIONS)).toBe(true);
  });

  it("answers false in quiet hours, never a later time (fails if a deferral is wired in)", () => {
    const recent = judgments("distracted", "distracted");
    expect(decideNudge(recent, null, NOW, { capMinutes: 45, inQuietHours: true })).toBe(false);
  });

  it("uses the last nudge from any block or Mac, so a second Mac cannot double the nudges", () => {
    // The caller passes the person's newest nudge time regardless of device or block.
    const recent = judgments("distracted", "distracted");
    expect(decideNudge(recent, at(10), NOW, OPTIONS)).toBe(false);
  });

  it("does not nudge with no history", () => {
    expect(decideNudge([], null, NOW, OPTIONS)).toBe(false);
  });
});
