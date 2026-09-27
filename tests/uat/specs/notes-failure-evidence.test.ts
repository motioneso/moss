import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TestInfo } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import {
  attachNotesFailureEvidence,
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
const NOTE_MARKER = "uat/notes-default-retrieval-1790000000000.md";

/** The SQL text is always the last docker argument. */
function lastArg(args: readonly string[]): string {
  return args[args.length - 1] ?? "";
}

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
        tool_name: "notes.create",
        outcome: "success",
        occurred_at: TURN_START,
        request_id: PRIVATE_MARKER
      }
    ]);
    expect(entries).toEqual([
      { toolName: "notes.create", outcome: "success", occurredAt: TURN_START }
    ]);
  });

  it("labels a nested, unknown or unbounded value malformed, never copying its text", () => {
    const entries = summarizeAuditEntries([
      {
        tool_name: { leaked: PRIVATE_MARKER },
        outcome: { leaked: PRIVATE_MARKER },
        occurred_at: { leaked: PRIVATE_MARKER }
      },
      {
        tool_name: `notes ${PRIVATE_MARKER}`,
        outcome: PRIVATE_MARKER,
        occurred_at: PRIVATE_MARKER
      },
      PRIVATE_MARKER
    ]);
    expect(entries).toEqual([
      { toolName: "malformed", outcome: "malformed", occurredAt: "malformed" },
      { toolName: "malformed", outcome: "malformed", occurredAt: "malformed" },
      { toolName: null, outcome: null, occurredAt: "malformed" }
    ]);
    expect(JSON.stringify(entries)).not.toContain(PRIVATE_MARKER);
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
  // The app container drops root's permission override, so a check run as root cannot see
  // inside a vault and wrongly reports the note as absent.
  function vaultExec(fileCheckOutput: string, calls: (readonly string[])[] = []): ExecFileImpl {
    return ((_file: string, args: readonly string[]) => {
      calls.push(args);
      return args.includes("%u:%g") ? "1000:1001\n" : fileCheckOutput;
    }) as unknown as ExecFileImpl;
  }

  it("captureNoteFileEvidence checks the note as the vault's owner", () => {
    const calls: (readonly string[])[] = [];

    const evidence = captureNoteFileEvidence(
      vaultExec("42\n", calls),
      "proj",
      "/data/vaults/x/n.md"
    );

    expect(evidence).toMatchObject({ exists: true, sizeBytes: 42, error: null });
    const fileCheck = calls.find((args) => args.includes("/data/vaults/x/n.md"))!;
    expect(fileCheck.slice(fileCheck.indexOf("--user"), fileCheck.indexOf("--user") + 2)).toEqual([
      "--user",
      "1000:1001"
    ]);
  });

  it("captureNoteFileEvidence reports an unreadable note as unknown, never as absent", () => {
    const evidence = captureNoteFileEvidence(
      vaultExec("NOTES_2737_UNREADABLE\n"),
      "proj",
      "/data/vaults/x/n.md"
    );

    expect(evidence).toMatchObject({ exists: null, error: "note_file_unreadable" });
  });

  // Runs the real file-check shell command against a fake stat, so the command's own handling
  // of missing and unreadable files is under test, not just the marker parsing.
  describe("the file-check command", () => {
    function runWithFakeStat(stdout: string, stderr: string, exitCode: number) {
      const dir = mkdtempSync(join(tmpdir(), "notes-2737-stat-"));
      try {
        const fakeStat = join(dir, "stat");
        writeFileSync(
          fakeStat,
          `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s\\n' '${stderr}' >&2\nexit ${exitCode}\n`
        );
        chmodSync(fakeStat, 0o755);
        const exec = ((_file: string, args: readonly string[]) => {
          if (args.includes("%u:%g")) return "1000:1001\n";
          const shellArgs = args.slice(args.indexOf("sh"));
          return execFileSync(shellArgs[0]!, shellArgs.slice(1), {
            encoding: "utf8",
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }
          });
        }) as unknown as ExecFileImpl;
        return captureNoteFileEvidence(exec, "proj", "/data/vaults/x/n.md");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("reports the size of a readable note", () => {
      expect(runWithFakeStat("42\n", "", 0)).toMatchObject({
        exists: true,
        sizeBytes: 42,
        error: null
      });
    });

    it("reports a missing note as absent", () => {
      const evidence = runWithFakeStat(
        "",
        `stat: cannot statx '/data/vaults/x/n.md': No such file or directory ${PRIVATE_MARKER}`,
        1
      );

      expect(evidence).toMatchObject({ exists: false, sizeBytes: null, error: null });
      expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
    });

    it("reports a permission failure as unknown, never as absent", () => {
      const evidence = runWithFakeStat(
        "",
        `stat: cannot statx '/data/vaults/x/n.md': Permission denied ${PRIVATE_MARKER}`,
        1
      );

      expect(evidence).toMatchObject({ exists: null, error: "note_file_unreadable" });
      expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
    });
  });

  it("captureNoteFileEvidence refuses a malformed vault owner", () => {
    const exec = ((_file: string, args: readonly string[]) =>
      args.includes("%u:%g") ? `root; ${PRIVATE_MARKER}` : "42\n") as unknown as ExecFileImpl;

    const evidence = captureNoteFileEvidence(exec, "proj", "/data/vaults/x/n.md");

    expect(evidence).toMatchObject({ exists: null, error: "unexpected_docker_output" });
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

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
      scope: "account_time_window",
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

  it("captureToolCallEvidence reports note_request_not_saved when no request carries the note path", () => {
    const fakeExec: ExecFileImpl = (() => "\n") as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      NOTE_MARKER,
      TURN_START
    );

    expect(evidence).toEqual({
      source: "sql:app.chat_messages",
      events: [],
      omittedCount: 0,
      error: "note_request_not_saved"
    });
  });

  it("captureToolCallEvidence reports note_request_ambiguous rather than picking one of two matches", () => {
    const rows = [
      { has_reply: true, activity: [{ kind: "tool", toolName: "notes.create" }] },
      { has_reply: true, activity: [] }
    ];
    const fakeExec: ExecFileImpl = (() => JSON.stringify(rows)) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      NOTE_MARKER,
      TURN_START
    );

    expect(evidence.error).toBe("note_request_ambiguous");
    expect(evidence.events).toEqual([]);
  });

  it("captureToolCallEvidence reports turn_message_not_saved when the request has no reply beside it", () => {
    const fakeExec: ExecFileImpl = (() =>
      JSON.stringify([{ has_reply: false, activity: [] }])) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      NOTE_MARKER,
      TURN_START
    );

    expect(evidence.error).toBe("turn_message_not_saved");
  });

  it("captureToolCallEvidence finds the request by its note path and the reply by the shared save time, not by a time window", () => {
    const seen: string[] = [];
    const fakeExec: ExecFileImpl = ((_cmd: string, args: readonly string[]) => {
      seen.push(lastArg(args));
      return JSON.stringify([
        {
          has_reply: true,
          activity: [
            { kind: "tool", toolName: "notes.create" },
            { kind: "result", toolName: "notes.create", outcome: "executed" }
          ]
        }
      ]);
    }) as unknown as ExecFileImpl;

    const evidence = captureToolCallEvidence(
      fakeExec,
      "proj",
      OWNER_USER_ID,
      "drawer",
      NOTE_MARKER,
      TURN_START
    );

    expect(evidence.error).toBeNull();
    expect(evidence.events).toEqual([
      { kind: "tool", toolName: "notes.create", status: null },
      { kind: "result", toolName: "notes.create", status: "executed" }
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(`strpos(u.body, '${NOTE_MARKER}') > 0`);
    expect(seen[0]).toContain("a.created_at = u.created_at");
    expect(seen[0]).not.toContain("u.created_at <");
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
      NOTE_MARKER,
      TURN_START
    );

    expect(evidence.error).toBe("docker_exec_failed");
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE_MARKER);
  });

  it.each([
    ["an unsafe chat surface", "drawer'; DROP TABLE app.chat_messages;--", NOTE_MARKER, TURN_START],
    ["a note marker with a quote", "drawer", "uat/x'); DROP TABLE app.users;--.md", TURN_START],
    ["an empty note marker", "drawer", "", TURN_START],
    ["a loosely parsed timestamp", "drawer", NOTE_MARKER, "Tue Mar 1 2016 ' or 1=1"]
  ])(
    "captureToolCallEvidence rejects %s before it ever reaches a query",
    (_label, surface, marker, start) => {
      const neverCalledExec: ExecFileImpl = (() => {
        throw new Error("must not be called");
      }) as unknown as ExecFileImpl;

      const evidence = captureToolCallEvidence(
        neverCalledExec,
        "proj",
        OWNER_USER_ID,
        surface,
        marker,
        start
      );

      expect(evidence.error).toBe("unexpected_docker_output");
    }
  );
});

describe("attachNotesFailureEvidence keeps malformed stored values out of both outputs (#2737)", () => {
  it("labels nested private values malformed in the attachment and the console", async () => {
    const nested = { leaked: PRIVATE_MARKER };
    const fakeExec: ExecFileImpl = ((_cmd: string, args: readonly string[]) => {
      if (args.includes("sh")) return "123\n";
      const sql = lastArg(args);
      if (sql.includes("moss_action_audit_log")) {
        return JSON.stringify([{ tool_name: nested, outcome: nested, occurred_at: nested }]);
      }
      return JSON.stringify([
        {
          has_reply: true,
          activity: [
            { kind: "tool", toolName: nested, outcome: nested, text: PRIVATE_MARKER },
            { kind: nested, toolName: "notes.create" }
          ]
        }
      ]);
    }) as unknown as ExecFileImpl;

    const attached: string[] = [];
    const fakeTestInfo = {
      attach: async (_name: string, options: { body: string | Buffer }) => {
        attached.push(String(options.body));
      }
    } as unknown as TestInfo;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let printed: string;

    try {
      await attachNotesFailureEvidence(
        fakeTestInfo,
        {
          projectName: "proj",
          ownerUserId: OWNER_USER_ID,
          fullNotePath: `/data/vaults/${OWNER_USER_ID}/${NOTE_MARKER}`,
          chatSurface: "drawer",
          noteRequestMarker: NOTE_MARKER,
          turnStartIso: TURN_START,
          retrievalTurnStartIso: TURN_END
        },
        fakeExec
      );
      printed = consoleSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    } finally {
      consoleSpy.mockRestore();
    }

    expect(printed).toContain("[uat #2737]");
    expect(attached).toHaveLength(1);
    for (const output of [attached[0]!, printed]) {
      expect(output).not.toContain(PRIVATE_MARKER);
      expect(output).toContain("malformed");
    }
    const evidence = JSON.parse(attached[0]!) as {
      actionAudit: { entries: unknown[] };
      toolCalls: { events: unknown[] };
    };
    expect(evidence.actionAudit.entries).toEqual([
      { toolName: "malformed", outcome: "malformed", occurredAt: "malformed" }
    ]);
    expect(evidence.toolCalls.events).toEqual([
      { kind: "tool", toolName: "malformed", status: "malformed" }
    ]);
  });
});
