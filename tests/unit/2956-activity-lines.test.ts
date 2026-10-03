import { describe, expect, it } from "vitest";

import type { ActionAuditLogEntryDto, ActivityLineDto } from "@moss/shared";

import {
  activityBadges,
  activityMeta,
  activityQuote,
  activitySubline,
  activityTitle,
  durationText,
  failureSentence,
  groupActivity
} from "../../apps/web/src/settings/settings-activity-line.js";

function line(overrides: Partial<ActivityLineDto> = {}): ActivityLineDto {
  return {
    id: "line-1",
    occurredAt: "2026-10-03T16:41:00.000Z",
    kind: "chat",
    action: "chat",
    outcome: "ok",
    modelName: "claude-sonnet-4-6",
    result: "completed",
    ownerUserId: "user-a",
    actionCode: "chat.answer",
    turnId: "turn-1",
    parentId: null,
    durationMs: 6200,
    inputTokens: 4120,
    outputTokens: 96,
    failureCode: null,
    factCounts: null,
    detail: null,
    ...overrides
  };
}

function audit(overrides: Partial<ActionAuditLogEntryDto> = {}): ActionAuditLogEntryDto {
  return {
    id: "audit-1",
    ownerUserId: "user-a",
    toolModuleId: "home-assistant",
    toolName: "home-assistant.HassTurnOn",
    actionFamilyId: null,
    actionKind: "write",
    approvalMode: "auto",
    outcome: "success",
    errorClass: null,
    requestId: "req-1",
    chatSessionId: "session-1",
    turnId: null,
    sourceSurface: "chat",
    inputSummary: null,
    durationMs: 800,
    occurredAt: "2026-10-03T16:41:05.000Z",
    ...overrides
  };
}

describe("activity titles (#2956 slice C)", () => {
  it("names each action code in fixed words, never stored text", () => {
    expect(activityTitle("chat.answer", "chat")).toBe("Answered a chat message");
    expect(activityTitle("chat.tool_check", "choices")).toBe("Jev guessed which tool to use");
    expect(activityTitle("embed.notes", "embed")).toBe("Indexed notes for search");
    expect(activityTitle("transcribe.voice_note", "transcribe")).toBe("Transcribed a voice note");
    expect(activityTitle("module.build", "build")).toBe("Built a module draft");
    expect(activityTitle("probe.reachable", "probe")).toBe("Checked that a model is reachable");
  });

  it("falls back to a fixed sentence for structured and background codes", () => {
    expect(activityTitle("structured.briefings", "briefings")).toBe("Ran a structured task");
    expect(activityTitle("task.morning_briefing", "task")).toBe("Morning briefing");
    expect(activityTitle(null, "chat")).toBe("Model activity");
  });
});

describe("activity sub-lines (#2956 slice C)", () => {
  it("prefers the recorded result line while the detail is unexpired", () => {
    const entry = line({
      detail: {
        quote: "Turn on the kitchen light",
        resultLine: "Turned on the kitchen light, read 3 events.",
        steps: [],
        expiresAt: "2026-11-02T16:41:00.000Z"
      }
    });
    expect(activitySubline(entry)).toBe("Turned on the kitchen light, read 3 events.");
  });

  it("falls back to bare facts once the detail has expired", () => {
    const entry = line({ factCounts: { tools: 2, jev_agreed: true } });
    expect(activitySubline(entry)).toBe("Used 2 tools. Jev agreed.");
    const bare = line({ factCounts: null });
    expect(activitySubline(bare)).toBe("Answered.");
  });

  it("names a failed bare line without raw provider text", () => {
    const entry = line({
      outcome: "error",
      actionCode: "structured.briefings",
      failureCode: "bad_shape"
    });
    expect(activitySubline(entry)).toContain("Did not work");
    expect(activitySubline(entry)).not.toContain("bad_shape");
  });
});

describe("activity quotes (#2956 slice C)", () => {
  it("cuts the recorded words at 140 characters", () => {
    expect(activityQuote(null)).toBeNull();
    expect(activityQuote("Turn on the light")).toBe('"Turn on the light"');
    const long = "x".repeat(200);
    const cut = activityQuote(long);
    expect(cut!.length).toBeLessThanOrEqual(145);
    expect(cut!.endsWith('..."')).toBe(true);
  });
});

describe("activity meta (#2956 slice C)", () => {
  it("reads model, duration and step count like the mockup", () => {
    expect(activityMeta(line({ durationMs: 6200 }), 5)).toBe("claude-sonnet-4-6 - 6.2s - 5 steps");
    expect(activityMeta(line({ durationMs: 41000 }), null)).toBe("claude-sonnet-4-6 - 41s");
    expect(activityMeta(line({ durationMs: null }), null)).toBe("claude-sonnet-4-6");
  });
});

describe("activity badges (#2956 slice C)", () => {
  it("marks failed, partial, disagreed and System lines only", () => {
    expect(activityBadges(line())).toEqual([]);
    expect(activityBadges(line({ outcome: "error" }))).toEqual([
      { text: "Did not work", tone: "red" }
    ]);
    expect(activityBadges(line({ factCounts: { tools: 3, tools_failed: 1 } }))).toEqual([
      { text: "1 step failed", tone: "amber" }
    ]);
    expect(activityBadges(line({ factCounts: { tools: 2, jev_agreed: false } }))).toEqual([
      { text: "Jev disagreed", tone: "amber" }
    ]);
    expect(activityBadges(line({ ownerUserId: null }))).toEqual([
      { text: "System", tone: "steel" }
    ]);
  });
});

describe("failure sentences (#2956 slice C)", () => {
  it("maps every spec code to a fixed sentence, never raw text", () => {
    expect(failureSentence("timeout", "the weather service", "10 seconds")).toBe(
      "The weather service did not answer within 10 seconds, so Moss stopped waiting."
    );
    expect(failureSentence("rate_limited", undefined, undefined)).toContain("slow down");
    expect(failureSentence("cancelled", undefined, undefined)).toBe("You stopped it.");
    expect(failureSentence("mystery-code", undefined, undefined)).toBe(
      "Something went wrong that Moss could not name."
    );
    expect(failureSentence(null, undefined, undefined)).toBe(
      "Something went wrong that Moss could not name."
    );
  });
});

describe("duration text (#2956 slice C)", () => {
  it("matches the mockup shapes", () => {
    expect(durationText(600)).toBe("0.6s");
    expect(durationText(6200)).toBe("6.2s");
    expect(durationText(10000)).toBe("10.0s");
    expect(durationText(41000)).toBe("41s");
  });
});

describe("activity grouping (#2956 slice C)", () => {
  it("folds child lines and turn-linked tools into their answer", () => {
    const answer = line({ id: "answer-1", turnId: "turn-1" });
    const check = line({
      id: "check-1",
      actionCode: "chat.tool_check",
      turnId: "turn-1",
      parentId: "answer-1",
      occurredAt: "2026-10-03T16:41:02.000Z"
    });
    const tool = audit({ id: "tool-1", turnId: "turn-1" });
    const rows = groupActivity([answer, check], [tool]);
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(first?.kind).toBe("line");
    if (first?.kind === "line") {
      expect(first.children.map((child) => child.id)).toEqual(["check-1"]);
      expect(first.tools.map((entry) => entry.id)).toEqual(["tool-1"]);
    }
  });

  it("keeps tools outside any turn as their own rows", () => {
    const rows = groupActivity([], [audit({ id: "tool-9", turnId: null })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool");
  });

  it("keeps turn-linked tools visible when their answer line is missing", () => {
    const rows = groupActivity([], [audit({ id: "tool-9", turnId: "turn-gone" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool");
  });

  it("orders rows newest first", () => {
    const old = line({ id: "old", occurredAt: "2026-10-03T15:00:00.000Z", turnId: null });
    const fresh = line({ id: "fresh", occurredAt: "2026-10-03T16:00:00.000Z", turnId: null });
    const rows = groupActivity([old, fresh], []);
    expect(rows.map((row) => (row.kind === "line" ? row.line.id : "?"))).toEqual(["fresh", "old"]);
  });
});
