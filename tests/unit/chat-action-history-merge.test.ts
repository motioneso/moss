import { describe, expect, it } from "vitest";

import type { TranscriptRecord } from "@moss/shared";
import {
  actionRecordId,
  actionRecords,
  mergeTerminalAction,
  terminalActionRecord,
  type TerminalActionRecord
} from "../../packages/chat/src/action-record-history.js";

const terminal: TerminalActionRecord = {
  kind: "action_result",
  actionRequestId: "action-a",
  text: "denied",
  outcome: "denied",
  decidedBy: "timeout",
  reason: "Action timed out."
};

describe("terminal action history projection", () => {
  it("projects only bounded terminal metadata from a rich live result", () => {
    const record: TranscriptRecord = {
      ...terminal,
      text: "t".repeat(250),
      toolName: "n".repeat(150),
      summary: "s".repeat(250),
      reason: "r".repeat(550),
      sequence: 0,
      durationMs: 0,
      preview: { to: "recipient@example.test", subject: "preview", body: "live body" },
      details: { target: "live target", fields: [{ label: "body", value: "live value" }] },
      result: { artifact: "live artifact" },
      affectsQueryKeys: ["tasks.list"],
      affectsModules: ["tasks"],
      outcomeTitle: "live title"
    };
    expect(terminalActionRecord(record)).toEqual({
      ...terminal,
      text: "t".repeat(200),
      toolName: "n".repeat(120),
      summary: "s".repeat(200),
      reason: "r".repeat(500),
      sequence: 0,
      durationMs: 0
    });
  });

  it.each<TranscriptRecord>([
    { kind: "action_request", text: "pending", actionRequestId: "action-a" },
    { kind: "action_result", text: "missing ID", outcome: "denied" },
    { kind: "action_result", text: "empty ID", actionRequestId: "", outcome: "denied" },
    { kind: "action_result", text: "missing outcome", actionRequestId: "action-a" }
  ])("does not persist incomplete terminal records: $text", (record) => {
    expect(terminalActionRecord(record)).toBeUndefined();
  });
});

describe("terminal action activity merge", () => {
  const pending = { kind: "action_request", actionRequestId: "action-a", text: "pending" };
  const other = {
    kind: "action_result",
    actionRequestId: "action-b",
    text: "other",
    outcome: "executed"
  };

  it("joins the result immediately after its pending request without changing other activity", () => {
    const activity = Object.freeze([other, pending, { kind: "thought", text: "after" }]);
    expect(mergeTerminalAction(activity, terminal)).toEqual([
      other,
      pending,
      terminal,
      activity[2]
    ]);
    expect(activity).toHaveLength(3);
  });

  it("replaces duplicate terminal results in place and remains idempotent", () => {
    const stale = { ...terminal, decidedBy: "person", reason: "outdated" };
    const merged = mergeTerminalAction([pending, stale, other, stale], terminal);
    expect(merged).toEqual([pending, terminal, other]);
    expect(mergeTerminalAction(merged, terminal)).toEqual(merged);
  });

  it("keeps rich metadata across bare recovery and allows a later rich notification to fill gaps", () => {
    const rich = { ...terminal, summary: "Create the task", durationMs: 31_000, sequence: 4 };
    expect(mergeTerminalAction([rich], terminal)).toEqual([rich]);
    expect(mergeTerminalAction([terminal], rich)).toEqual([rich]);
  });

  it("appends an orphan result and tolerates unrelated malformed stored entries", () => {
    const activity = [null, "legacy", { actionRequestId: 12 }, other];
    expect(mergeTerminalAction(activity, terminal)).toEqual([...activity, terminal]);
    expect(actionRecords(null)).toEqual([]);
    expect(actionRecords({ activity })).toEqual([]);
    expect(actionRecords(activity)).toBe(activity);
    expect(actionRecordId({ actionRequestId: "" })).toBeUndefined();
    expect(actionRecordId({ actionRequestId: 12 })).toBeUndefined();
    expect(actionRecordId(pending)).toBe("action-a");
  });
});
