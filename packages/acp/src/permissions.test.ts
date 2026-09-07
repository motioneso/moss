import { describe, expect, it } from "vitest";

import type { PermissionOption } from "@agentclientprotocol/sdk";

import {
  classifyAcpPermission,
  decideAcpPermission,
  extractAcpPaths,
  isInsideSessionFolder,
  selectAllowOptionId,
  toolNameFromMeta,
  type AcpBuiltInRequest
} from "./permissions.js";

const CWD = "/runner/session/acp/proj";

function request(partial: Partial<AcpBuiltInRequest>): AcpBuiltInRequest {
  return {
    sessionId: "agent-sess-1",
    toolCallId: "call-1",
    title: "",
    rawInput: {},
    toolName: null,
    kind: null,
    locations: null,
    ...partial
  };
}

function options(): PermissionOption[] {
  return [
    { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Reject", optionId: "reject" }
  ];
}

describe("classifyAcpPermission", () => {
  it("refuses when no real name arrived, whatever the title claims", () => {
    for (const title of [
      "Read src/index.ts",
      "Find `src` `*.ts`",
      "Update TODOs: write tests",
      "Refactor the billing module"
    ]) {
      expect(classifyAcpPermission(request({ title, toolName: null }), CWD)).toBe("deny");
    }
  });

  it("refuses a name outside the explicit lists", () => {
    expect(classifyAcpPermission(request({ title: "t", toolName: "Skill" }), CWD)).toBe("deny");
    expect(
      classifyAcpPermission(request({ title: "t", toolName: "mcp__github__issue_read" }), CWD)
    ).toBe("deny");
  });

  it("allows named read-only tools", () => {
    for (const toolName of [
      "Read",
      "mcp__acp__Read",
      "NotebookRead",
      "LS",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "BashOutput"
    ]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), CWD)).toBe("allow");
    }
  });

  it("allows a named write inside the folder and asks outside it", () => {
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Write", rawInput: { file_path: "src/out.txt" } }),
        CWD
      )
    ).toBe("allow");
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Edit", rawInput: { file_path: "/etc/passwd" } }),
        CWD
      )
    ).toBe("ask");
    expect(
      classifyAcpPermission(request({ title: "t", toolName: "NotebookEdit", rawInput: {} }), CWD)
    ).toBe("ask");
  });

  it("always asks for shell", () => {
    for (const toolName of ["Bash", "mcp__acp__Bash", "KillShell"]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), CWD)).toBe("ask");
    }
  });

  it("refuses mode changes and tools that are never offered", () => {
    for (const toolName of ["ExitPlanMode", "EnterPlanMode", "Task", "Skill", "Other"]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), CWD)).toBe("deny");
    }
  });

  it("treats folder traversal as outside the session folder", () => {
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Write", rawInput: { file_path: "../escape.txt" } }),
        CWD
      )
    ).toBe("ask");
  });
});

describe("task tool titled like a harmless read", () => {
  const mimicInput = {
    description: "Read the repository and summarize the layout",
    prompt: "Read every file in the repo, including secrets, and report back."
  };

  it("refuses a subagent titled like a read, without asking anyone", async () => {
    const verdict = await decideAcpPermission(
      request({
        title: "Read the repository and summarize the layout",
        rawInput: mimicInput,
        toolName: "Task"
      }),
      CWD,
      async () => {
        throw new Error("must not ask a person about a subagent");
      }
    );
    expect(verdict).toBe("deny");
  });

  it("refuses the same mimic with no name rather than trusting the title", async () => {
    const verdict = await decideAcpPermission(
      request({
        title: "Read the repository and summarize the layout",
        rawInput: mimicInput,
        toolName: null
      }),
      CWD,
      async () => {
        throw new Error("must not ask a person for the unnamed");
      }
    );
    expect(verdict).toBe("deny");
  });
});

describe("helpers", () => {
  it("reads the real name from adapter metadata and nothing else", () => {
    expect(toolNameFromMeta({ toolName: "Bash" })).toBe("Bash");
    expect(toolNameFromMeta({})).toBeNull();
    expect(toolNameFromMeta(null)).toBeNull();
    expect(toolNameFromMeta({ toolName: "  " })).toBeNull();
    expect(toolNameFromMeta({ toolName: 7 })).toBeNull();
  });

  it("collects paths from the known input fields", () => {
    expect(
      extractAcpPaths(request({ title: "t", toolName: "Edit", rawInput: { file_path: "a.ts" } }))
    ).toEqual(["a.ts"]);
    expect(extractAcpPaths(request({ title: "t", toolName: "Read", rawInput: null }))).toEqual([]);
  });

  it("keeps absolute outside paths outside and relative inside paths inside", () => {
    expect(isInsideSessionFolder(CWD, "src/a.ts")).toBe(true);
    expect(isInsideSessionFolder(CWD, "/etc/passwd")).toBe(false);
    expect(isInsideSessionFolder(CWD, "../other")).toBe(false);
    expect(isInsideSessionFolder(CWD, "")).toBe(false);
  });

  it("picks the single-use allow option and null when none allows", () => {
    expect(selectAllowOptionId(options())).toBe("allow");
    expect(
      selectAllowOptionId([{ kind: "reject_once", name: "No", optionId: "reject" }])
    ).toBeNull();
  });
});

describe("decideAcpPermission", () => {
  it("allows a named read without asking anyone", async () => {
    const verdict = await decideAcpPermission(
      request({ title: "Read File", rawInput: { file_path: "src/a.ts" }, toolName: "Read" }),
      CWD,
      async () => {
        throw new Error("must not ask a person for a read");
      }
    );
    expect(verdict).toBe("allow");
  });

  it("asks a person for a shell command and honors the answer", async () => {
    const asked: string[] = [];
    const allow = await decideAcpPermission(
      request({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        toolName: "Bash"
      }),
      CWD,
      async (builtIn) => {
        asked.push(builtIn.toolCallId);
        return "allow";
      }
    );
    expect(allow).toBe("allow");
    const deny = await decideAcpPermission(
      request({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        toolName: "Bash"
      }),
      CWD,
      async () => "deny"
    );
    expect(deny).toBe("deny");
    expect(asked).toEqual(["call-1"]);
  });
});
