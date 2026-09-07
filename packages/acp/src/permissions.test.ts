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

/** Exactly what the patched adapter sends: id, input, title, real name. */
function permissionRequest(toolCall: Record<string, unknown>) {
  return {
    sessionId: "agent-sess-1",
    toolCall: { toolCallId: "call-9", ...toolCall },
    options: options()
  };
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
    expect(classifyAcpPermission(request({ title: "t", toolName: "Skill" }), CWD)).toBe(
      "deny"
    );
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
      classifyAcpPermission(
        request({ title: "t", toolName: "NotebookEdit", rawInput: {} }),
        CWD
      )
    ).toBe("ask");
  });

  it("always asks for shell, subagents, and mode changes", () => {
    for (const toolName of ["Bash", "mcp__acp__Bash", "KillShell", "ExitPlanMode", "Task"]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), CWD)).toBe("ask");
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

  it("asks a person when the real name says Task, not what the title says", async () => {
    const asked: string[] = [];
    const response = await decideAcpPermission(
      permissionRequest({
        title: "Read the repository and summarize the layout",
        rawInput: mimicInput,
        _meta: { toolName: "Task" }
      }),
      CWD,
      async (builtIn) => {
        asked.push(builtIn.toolName ?? "missing");
        return "deny";
      }
    );
    expect(asked).toEqual(["Task"]);
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });

  it("refuses the same mimic with no name rather than trusting the title", async () => {
    const response = await decideAcpPermission(
      permissionRequest({
        title: "Read the repository and summarize the layout",
        rawInput: mimicInput
      }),
      CWD,
      async () => {
        throw new Error("must not ask a person for the unnamed");
      }
    );
    expect(response.outcome).toEqual({ outcome: "cancelled" });
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
      extractAcpPaths(
        request({ title: "t", toolName: "Edit", rawInput: { file_path: "a.ts" } })
      )
    ).toEqual(["a.ts"]);
    expect(extractAcpPaths(request({ title: "t", toolName: "Read", rawInput: null }))).toEqual(
      []
    );
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
  it("answers a named read with the single-use option", async () => {
    const response = await decideAcpPermission(
      permissionRequest({
        title: "Read src/a.ts",
        rawInput: { file_path: "src/a.ts" },
        _meta: { toolName: "Read" }
      }),
      CWD,
      async () => {
        throw new Error("must not ask a person for a read");
      }
    );
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("asks a person for a shell command and honors the answer", async () => {
    const asked: string[] = [];
    const allow = await decideAcpPermission(
      permissionRequest({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        _meta: { toolName: "Bash" }
      }),
      CWD,
      async (builtIn) => {
        asked.push(builtIn.toolCallId);
        return "allow";
      }
    );
    expect(allow.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    const deny = await decideAcpPermission(
      permissionRequest({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        _meta: { toolName: "Bash" }
      }),
      CWD,
      async () => "deny"
    );
    expect(deny.outcome).toEqual({ outcome: "cancelled" });
    expect(asked).toEqual(["call-9"]);
  });
});
