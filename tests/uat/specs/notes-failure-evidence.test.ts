import { describe, expect, it } from "vitest";

import {
  boundToolCallEvents,
  parseNoteFileCheckOutput,
  summarizeAuditEntries
} from "./notes-failure-evidence.js";

describe("parseNoteFileCheckOutput (#2737)", () => {
  it("reads a byte size as an existing file", () => {
    expect(parseNoteFileCheckOutput("42\n")).toEqual({ exists: true, sizeBytes: 42 });
  });

  it("reads the missing marker as a file that does not exist", () => {
    expect(parseNoteFileCheckOutput("NOTES_2737_MISSING\n")).toEqual({
      exists: false,
      sizeBytes: null
    });
  });

  it("throws on unexpected output rather than guessing", () => {
    expect(() => parseNoteFileCheckOutput("permission denied\n")).toThrow(
      /unexpected note-file-check output/
    );
  });
});

describe("summarizeAuditEntries (#2737)", () => {
  it("keeps only tool name, outcome and timestamp", () => {
    const entries = summarizeAuditEntries([
      {
        toolName: "notes.create",
        outcome: "success",
        occurredAt: "2026-09-26T00:00:00.000Z"
      } as never
    ]);
    expect(entries).toEqual([
      { toolName: "notes.create", outcome: "success", occurredAt: "2026-09-26T00:00:00.000Z" }
    ]);
  });
});

describe("boundToolCallEvents (#2737)", () => {
  it("keeps only kind, tool name and status", () => {
    const events = boundToolCallEvents([
      { kind: "tool", toolName: "notes.create", outcome: undefined },
      { kind: "action_result", toolName: "notes.create", outcome: "executed" }
    ]);
    expect(events).toEqual([
      { kind: "tool", toolName: "notes.create", status: null },
      { kind: "action_result", toolName: "notes.create", status: "executed" }
    ]);
  });

  it("caps the list at 20 entries", () => {
    const events = Array.from({ length: 30 }, (_, index) => ({
      kind: "tool",
      toolName: `tool-${index}`
    }));
    expect(boundToolCallEvents(events)).toHaveLength(20);
  });

  it("never carries text, toolCallId or raw arguments", () => {
    const rawRecord = {
      kind: "tool",
      toolName: "notes.create",
      // Extra fields a real record would carry — must not survive the bound shape.
      text: "secret note body",
      toolCallId: "abc-123",
      rawInput: { content: "x" }
    };
    const events = boundToolCallEvents([rawRecord]);
    expect(Object.keys(events[0]!)).toEqual(["kind", "toolName", "status"]);
  });
});
