import { describe, expect, it } from "vitest";

import {
  boundToolCallEvents,
  captureActionAuditEvidence,
  captureToolCallEvidence,
  parseNoteFileCheckOutput,
  summarizeAuditEntries,
  type FetchImpl
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
    expect(() => parseNoteFileCheckOutput("permission denied\n")).toThrow();
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

describe("captures never leak a raw error's own text (#2737)", () => {
  const PRIVATE_MARKER = "SECRET_TOKEN_ab12cd34_do_not_leak";

  it("captureActionAuditEvidence turns a thrown error into a fixed code, never the error's own text", async () => {
    const throwingFetch: FetchImpl = (() => {
      throw new Error(`connection reset, response body was: ${PRIVATE_MARKER}`);
    }) as unknown as FetchImpl;

    const evidence = await captureActionAuditEvidence(
      throwingFetch,
      "http://example.test",
      "better-auth.session_token=abc",
      "2026-09-26T00:00:00.000Z"
    );

    expect(evidence.error).toBe("http_request_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureActionAuditEvidence turns an unparsable body into a fixed code, never the body text", async () => {
    const badJsonFetch: FetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error(`Unexpected token in ${PRIVATE_MARKER}`);
        }
      }) as unknown as Response) as FetchImpl;

    const evidence = await captureActionAuditEvidence(
      badJsonFetch,
      "http://example.test",
      "better-auth.session_token=abc",
      "2026-09-26T00:00:00.000Z"
    );

    expect(evidence.error).toBe("response_parse_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it("captureToolCallEvidence turns an HTTP error status into a fixed code plus status, never the response body", async () => {
    const errorFetch: FetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({ error: PRIVATE_MARKER })
      }) as unknown as Response) as FetchImpl;

    const evidence = await captureToolCallEvidence(
      errorFetch,
      "http://example.test",
      "better-auth.session_token=abc",
      "thread-1",
      "drawer"
    );

    expect(evidence.error).toBe("http_error:500");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });
});
