import { describe, expect, it } from "vitest";

import { classifyAcpPermission } from "./permissions.js";
import { acpToolNamesIn, launchOffList, lookupAcpToolFamily } from "./tool-table.js";

const CWD = "/runner/session/acp/proj";
const FOLDERS = { cwd: CWD, home: "/home/agent" };

/**
 * The launch list and the use-time policy agree because both derive from the
 * table: every row classifies into its own family, and the off-lists hold no
 * silently allowed tool.
 */
describe("tool table agreement", () => {
  it("classifies every row into its own family", () => {
    const inFolder = { file_path: "src/a.ts", notebook_path: "n.ipynb", path: "src" };
    for (const name of acpToolNamesIn("read", "web", "harmless")) {
      const rawInput =
        name === "WebFetch" ? { url: "https://example.com/docs" } : { file_path: "src/a.ts" };
      expect(
        classifyAcpPermission(
          {
            sessionId: "s",
            turnId: "t",
            toolCallId: "c",
            title: "t",
            rawInput,
            toolName: name,
            kind: null,
            locations: null
          },
          FOLDERS
        )
      ).toEqual({ verdict: "allow" });
    }
    for (const name of acpToolNamesIn("write")) {
      expect(
        classifyAcpPermission(
          {
            sessionId: "s",
            turnId: "t",
            toolCallId: "c",
            title: "t",
            rawInput: inFolder,
            toolName: name,
            kind: null,
            locations: null
          },
          FOLDERS
        )
      ).toEqual({ verdict: "allow" });
    }
    for (const name of acpToolNamesIn("shell")) {
      expect(
        classifyAcpPermission(
          {
            sessionId: "s",
            turnId: "t",
            toolCallId: "c",
            title: "t",
            rawInput: {},
            toolName: name,
            kind: null,
            locations: null
          },
          FOLDERS
        )
      ).toEqual({ verdict: "ask" });
    }
    for (const name of acpToolNamesIn("mode", "not-offered")) {
      expect(
        classifyAcpPermission(
          {
            sessionId: "s",
            turnId: "t",
            toolCallId: "c",
            title: "t",
            rawInput: {},
            toolName: name,
            kind: null,
            locations: null
          },
          FOLDERS
        )
      ).toEqual({ verdict: "deny", reason: "not_offered" });
    }
  });

  it("names Moss tools as their own family and anything else unknown", () => {
    expect(lookupAcpToolFamily("mcp__moss__calendar_createEvent")).toBe("moss");
    expect(lookupAcpToolFamily("mcp__moss__")).toBe("unknown");
    expect(lookupAcpToolFamily("DefinitelyNotATool")).toBe("unknown");
    expect(lookupAcpToolFamily("Read")).toBe("read");
  });

  it("keeps the launch off-lists exactly on the table rows", () => {
    expect(new Set(launchOffList("chat"))).toEqual(
      new Set([
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "mcp__acp__Write",
        "mcp__acp__Edit",
        "Bash",
        "KillShell",
        "mcp__acp__Bash",
        "mcp__acp__KillShell",
        "ExitPlanMode",
        "EnterPlanMode",
        "Task",
        "Skill",
        "SlashCommand",
        "AskUserQuestion"
      ])
    );
    expect(new Set(launchOffList("workshop"))).toEqual(
      new Set([
        "Bash",
        "KillShell",
        "mcp__acp__Bash",
        "mcp__acp__KillShell",
        "ExitPlanMode",
        "EnterPlanMode",
        "Task",
        "Skill",
        "SlashCommand",
        "AskUserQuestion"
      ])
    );
  });
});
