import { describe, expect, it } from "vitest";

import { injectActionResultRecord } from "../../packages/chat/src/live/session-runtime-helpers.js";
import type { ActionResultMetadata, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { readActivity } from "../../packages/chat/src/route-serializers.js";

describe("approval outcome stream and history metadata", () => {
  it.each([
    { outcome: "executed", decidedBy: "person", kind: "approved" },
    { outcome: "allowed", decidedBy: "person", kind: "approved" },
    { outcome: "error", decidedBy: "person", kind: "approved" },
    { outcome: "denied", decidedBy: "person", kind: "not_approved" },
    { outcome: "denied", decidedBy: "timeout", kind: "not_approved" },
    { outcome: "denied", decidedBy: "cancelled", kind: "not_approved" }
  ] as const)("keeps $outcome/$decidedBy correlated through reload", (decision) => {
    const emitted: TranscriptRecord[] = [];
    const activity: TranscriptRecord[] = [{ kind: "thought", text: "Planning", sequence: 1 }];
    const actionResults: ActionResultMetadata[] = [];
    const result: TranscriptRecord = {
      kind: "action_result",
      text: "Gateway audit detail",
      actionRequestId: "request-1",
      toolName: "app.callAction",
      summary: "Remove saved theme",
      outcome: decision.outcome,
      decidedBy: decision.decidedBy,
      durationMs: 2400,
      ...(decision.outcome === "executed"
        ? { affectsModules: ["settings"], affectsQueryKeys: ["settings.themes"] }
        : {})
    };

    injectActionResultRecord(result, {
      sessionKey: "session-1",
      sequenceBySession: new Map([["session-1", 1]]),
      turnRecords: activity,
      actionResults,
      emit: (record) => emitted.push(record)
    });

    const metadata = {
      actionRequestId: "request-1",
      summary: "Remove saved theme",
      outcome: decision.outcome,
      decidedBy: decision.decidedBy
    };
    // Approval remains separate from execution, including approved calls that failed.
    expect(emitted[0]).toBe(result);
    expect(emitted[1]).toMatchObject({ kind: decision.kind, ...metadata });
    expect(activity.map((record) => record.kind)).toEqual([
      "thought",
      "action_result",
      decision.kind
    ]);
    expect(activity.map((record) => record.sequence)).toEqual([1, 2, 3]);
    const reloaded = readActivity(JSON.parse(JSON.stringify(activity)));
    expect(reloaded[1]).toMatchObject(metadata);
    expect(reloaded[2]).toMatchObject(metadata);
    // Legacy persistence's metadata-only fallback preserves the same terminal decision.
    expect(readActivity(JSON.parse(JSON.stringify(actionResults)))[0]).toMatchObject(metadata);
  });

  it("does not turn policy decisions into human approval", () => {
    const emitted: TranscriptRecord[] = [];
    const activity: TranscriptRecord[] = [];
    const actionResults: ActionResultMetadata[] = [];
    injectActionResultRecord(
      {
        kind: "action_result",
        text: "Executed: app.callAction",
        actionRequestId: "automatic-1",
        outcome: "executed",
        decidedBy: "policy"
      },
      {
        sessionKey: "session-1",
        sequenceBySession: new Map(),
        turnRecords: activity,
        actionResults,
        emit: (record) => emitted.push(record)
      }
    );
    expect(emitted).toHaveLength(1);
    expect(readActivity(JSON.parse(JSON.stringify(activity)))).toMatchObject([
      { decidedBy: "policy", actionRequestId: "automatic-1", outcome: "executed" }
    ]);
    expect(actionResults[0]).toMatchObject({ decidedBy: "policy" });
  });

  it("keeps exact request IDs and accepts only typed title metadata in history", () => {
    const reloaded = readActivity([
      {
        kind: "action_result",
        text: "Existing audit text",
        actionRequestId: "request-1",
        summary: "A".repeat(220),
        outcome: "denied",
        decidedBy: "timeout",
        preview: { body: "Private preview" },
        details: { target: "Private target" }
      },
      {
        kind: "action_result",
        text: "Old outcome",
        actionRequestId: 123,
        summary: { title: "Invalid title" },
        decidedBy: "invalid"
      }
    ]);
    expect(reloaded[0]).toEqual({
      kind: "action_result",
      text: "Existing audit text",
      actionRequestId: "request-1",
      summary: "A".repeat(200),
      outcome: "denied",
      decidedBy: "timeout"
    });
    expect(reloaded[1]).toEqual({ kind: "action_result", text: "Old outcome" });
  });
});
