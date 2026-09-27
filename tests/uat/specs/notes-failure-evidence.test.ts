import { describe, expect, it } from "vitest";

import {
  boundToolCallEvents,
  captureActionAuditEvidence,
  captureNoteFileEvidence,
  captureToolCallEvidence,
  formatCaptureError,
  parseNoteFileCheckOutput,
  summarizeAuditEntries,
  type ExecFileImpl
} from "./notes-failure-evidence.js";

const OWNER_USER_ID = "00000000-0000-4000-8000-000000000001";
const TURN_START = "2026-09-26T00:00:00.000Z";
const TURN_END = "2026-09-26T00:05:00.000Z";
const PRIVATE_MARKER = "SECRET_TOKEN_ab12cd34_do_not_leak";

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
    expect(() => parseNoteFileCheckOutput("permission denied\n")).toThrow();
  });
});

describe("summarizeAuditEntries (#2737)", () => {
  it("keeps only tool name, outcome and timestamp", () => {
    const entries = summarizeAuditEntries([
      { toolName: "notes.create", outcome: "success", occurredAt: TURN_START }
    ]);
    expect(entries).toEqual([
      { toolName: "notes.create", outcome: "success", occurredAt: TURN_START }
    ]);
  });
});

describe("boundToolCallEvents (#2737)", () => {
  it("keeps only kind, tool name and status", () => {
    const bounded = boundToolCallEvents([
      { kind: "tool", toolName: "notes.create", outcome: undefined },
      { kind: "action_result", toolName: "notes.create", outcome: "executed" }
    ]);
    expect(bounded.events).toEqual([
      { kind: "tool", toolName: "notes.create", status: null },
      { kind: "action_result", toolName: "notes.create", status: "executed" }
    ]);
    expect(bounded.omittedCount).toBe(0);
  });

  it("drops non-tool kinds before capping, so a run of thoughts cannot push the one real tool event past the cap", () => {
    const filler = Array.from({ length: 25 }, () => ({ kind: "thought" }));
    const bounded = boundToolCallEvents([...filler, { kind: "tool", toolName: "notes.create" }]);
    expect(bounded.events).toEqual([{ kind: "tool", toolName: "notes.create", status: null }]);
    expect(bounded.omittedCount).toBe(0);
  });

  it("caps the list at 20 entries and reports how many were dropped", () => {
    const events = Array.from({ length: 30 }, (_, index) => ({
      kind: "tool",
      toolName: `tool-${index}`
    }));
    const bounded = boundToolCallEvents(events);
    expect(bounded.events).toHaveLength(20);
    expect(bounded.omittedCount).toBe(10);
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
    const bounded = boundToolCallEvents([rawRecord]);
    expect(Object.keys(bounded.events[0]!)).toEqual(["kind", "toolName", "status"]);
  });
});

describe("formatCaptureError (#2737)", () => {
  it("carries a numeric status when there is one", () => {
    expect(formatCaptureError("docker_exec_failed", 2)).toBe("docker_exec_failed:2");
  });

  it("is just the code when there is no status", () => {
    expect(formatCaptureError("docker_exec_timed_out")).toBe("docker_exec_timed_out");
  });
});

describe("container reads never leak a raw error, stderr, or command output (#2737)", () => {
  it("captureNoteFileEvidence turns a thrown exec error into a fixed code, never the error's own text", () => {
    const throwingExec: ExecFileImpl = (() => {
      throw new Error(`stat: cannot read, saw ${PRIVATE_MARKER}`);
    }) as unknown as ExecFileImpl;

    const evidence = captureNoteFileEvidence(throwingExec, "proj", "/data/vaults/x/note.md");

    expect(evidence.error).toBe("docker_exec_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureNoteFileEvidence reports a timeout distinctly from a plain nonzero exit", () => {
    const timingOutExec: ExecFileImpl = (() => {
      const error = new Error("timed out") as Error & { killed?: boolean };
      error.killed = true;
      throw error;
    }) as unknown as ExecFileImpl;

    const evidence = captureNoteFileEvidence(timingOutExec, "proj", "/data/vaults/x/note.md");

    expect(evidence.error).toBe("docker_exec_timed_out");
  });

  it("captureNoteFileEvidence keeps a real exit status, never the error's message", () => {
    const failingExec: ExecFileImpl = (() => {
      const error = new Error(`denied: ${PRIVATE_MARKER}`) as Error & { status?: number };
      error.status = 2;
      throw error;
    }) as unknown as ExecFileImpl;

    const evidence = captureNoteFileEvidence(failingExec, "proj", "/data/vaults/x/note.md");

    expect(evidence.error).toBe("docker_exec_failed:2");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureNoteFileEvidence turns unparsable output into a fixed code, never the output text", () => {
    const badOutputExec: ExecFileImpl = (() =>
      `permission denied, response was ${PRIVATE_MARKER}`) as unknown as ExecFileImpl;

    const evidence = captureNoteFileEvidence(badOutputExec, "proj", "/data/vaults/x/note.md");

    expect(evidence.error).toBe("unexpected_docker_output");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureActionAuditEvidence turns a thrown exec error into a fixed code, never the error's own text", () => {
    const throwingExec: ExecFileImpl = (() => {
      throw new Error(`connection reset, response body was: ${PRIVATE_MARKER}`);
    }) as unknown as ExecFileImpl;

    const evidence = captureActionAuditEvidence(
      throwingExec,
      "proj",
      OWNER_USER_ID,
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBe("docker_exec_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureActionAuditEvidence turns unparsable psql output into a fixed code, never the output text", () => {
    const badOutputExec: ExecFileImpl = (() =>
      `ERROR: syntax error, near ${PRIVATE_MARKER}`) as unknown as ExecFileImpl;

    const evidence = captureActionAuditEvidence(
      badOutputExec,
      "proj",
      OWNER_USER_ID,
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBe("unexpected_docker_output");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureActionAuditEvidence parses rows into the bounded shape", () => {
    const rows = [{ tool_name: "notes.create", outcome: "success", occurred_at: TURN_START }];
    const fakeExec: ExecFileImpl = (() => JSON.stringify(rows)) as unknown as ExecFileImpl;

    const evidence = captureActionAuditEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBeNull();
    expect(evidence.entries).toEqual([
      { toolName: "notes.create", outcome: "success", occurredAt: TURN_START }
    ]);
  });

  it("captureActionAuditEvidence treats a blank psql result (no rows) as an empty, non-error list", () => {
    const fakeExec: ExecFileImpl = (() => "\n") as unknown as ExecFileImpl;

    const evidence = captureActionAuditEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      TURN_START,
      TURN_END
    );

    expect(evidence).toEqual({
      source: "sql:app.moss_action_audit_log",
      entries: [],
      error: null
    });
  });

  it("captureActionAuditEvidence rejects an unsafe owner id before it ever reaches a query", () => {
    const neverCalledExec: ExecFileImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as ExecFileImpl;

    const evidence = captureActionAuditEvidence(
      neverCalledExec,
      "proj",
      "not-a-uuid; DROP TABLE users;--",
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBe("unexpected_docker_output");
  });

  it("captureToolCallEvidence reports turn_message_not_saved when nothing landed in the window", () => {
    const fakeExec: ExecFileImpl = (() => "\n") as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      TURN_START,
      TURN_END
    );

    expect(evidence).toEqual({
      source: "sql:app.chat_messages",
      events: [],
      omittedCount: 0,
      error: "turn_message_not_saved"
    });
  });

  it("captureToolCallEvidence merges activity across rows in the window and bounds it", () => {
    const rows = [
      { created_at: TURN_START, activity: [{ kind: "tool", toolName: "notes.create" }] },
      {
        created_at: TURN_END,
        activity: [{ kind: "result", toolName: "notes.create", outcome: "executed" }]
      }
    ];
    const fakeExec: ExecFileImpl = (() => JSON.stringify(rows)) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBeNull();
    expect(evidence.events).toEqual([
      { kind: "tool", toolName: "notes.create", status: null },
      { kind: "result", toolName: "notes.create", status: "executed" }
    ]);
    expect(evidence.omittedCount).toBe(0);
  });

  it("captureToolCallEvidence turns a thrown exec error into a fixed code, never the error's own text", () => {
    const throwingExec: ExecFileImpl = (() => {
      throw new Error(`psql: fatal, saw ${PRIVATE_MARKER}`);
    }) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      throwingExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBe("docker_exec_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureToolCallEvidence rejects an unsafe chat surface before it ever reaches a query", () => {
    const neverCalledExec: ExecFileImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      neverCalledExec,
      "proj",
      OWNER_USER_ID,
      "drawer'; DROP TABLE app.chat_messages;--",
      TURN_START,
      TURN_END
    );

    expect(evidence.error).toBe("unexpected_docker_output");
  });
});
