import { describe, expect, it } from "vitest";

import type { PermissionOption } from "@agentclientprotocol/sdk";

import {
  classifyAcpPermission,
  decideAcpPermission,
  extractAcpPaths,
  inferAcpToolName,
  isInsideSessionFolder,
  selectAllowOptionId,
  type AcpBuiltInRequest
} from "./permissions.js";

const CWD = "/runner/session/acp/proj";

function request(partial: Partial<AcpBuiltInRequest> & { title: string }): AcpBuiltInRequest {
  return {
    sessionId: "agent-sess-1",
    toolCallId: "call-1",
    rawInput: {},
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

describe("classifyAcpPermission with a kind", () => {
  it("allows read-only kinds without looking at paths", () => {
    for (const kind of ["read", "search", "fetch", "think"] as const) {
      expect(classifyAcpPermission(request({ title: "anything", kind }), CWD)).toBe("allow");
    }
  });

  it("allows an edit whose every path sits inside the session folder", () => {
    expect(
      classifyAcpPermission(
        request({
          title: "Edit",
          kind: "edit",
          rawInput: { file_path: "src/index.ts" },
          locations: [{ path: "src/index.ts" }]
        }),
        CWD
      )
    ).toBe("allow");
  });

  it("asks when one edit path leaves the session folder", () => {
    expect(
      classifyAcpPermission(
        request({
          title: "Edit",
          kind: "edit",
          rawInput: { file_path: "src/index.ts" },
          locations: [{ path: "/etc/passwd" }]
        }),
        CWD
      )
    ).toBe("ask");
  });

  it("asks for an edit that names no path rather than guessing", () => {
    expect(classifyAcpPermission(request({ title: "Edit", kind: "edit" }), CWD)).toBe("ask");
  });

  it("always asks for destructive and mode-changing kinds", () => {
    for (const kind of ["delete", "move", "execute", "switch_mode"] as const) {
      expect(classifyAcpPermission(request({ title: "anything", kind }), CWD)).toBe("ask");
    }
  });

  it("refuses an unrecognised kind", () => {
    expect(classifyAcpPermission(request({ title: "anything", kind: "other" }), CWD)).toBe("deny");
  });
});

describe("classifyAcpPermission without a kind (what the adapter sends)", () => {
  it("allows read-only titles", () => {
    for (const title of [
      "Read src/index.ts",
      "Read Notebook notes.ipynb",
      "List the `src` directory's contents",
      "Find `src` `*.ts`",
      'grep "hello" src',
      "Fetch https://example.com",
      '"best router"',
      "Update TODOs: write tests",
      "Tail Logs"
    ]) {
      expect(classifyAcpPermission(request({ title, rawInput: {} }), CWD)).toBe("allow");
    }
  });

  it("allows a write inside the session folder and asks outside it", () => {
    expect(
      classifyAcpPermission(
        request({ title: "Write src/out.txt", rawInput: { file_path: "src/out.txt" } }),
        CWD
      )
    ).toBe("allow");
    expect(
      classifyAcpPermission(
        request({ title: "Write /tmp/out.txt", rawInput: { file_path: "/tmp/out.txt" } }),
        CWD
      )
    ).toBe("ask");
  });

  it("asks for shell commands and process control", () => {
    expect(
      classifyAcpPermission(
        request({ title: "`pnpm test`", rawInput: { command: "pnpm test" } }),
        CWD
      )
    ).toBe("ask");
    expect(classifyAcpPermission(request({ title: "Kill Process" }), CWD)).toBe("ask");
    expect(classifyAcpPermission(request({ title: "Ready to code?" }), CWD)).toBe("ask");
  });

  it("refuses a title it does not recognise, such as a free-form task", () => {
    expect(
      classifyAcpPermission(
        request({ title: "Refactor the billing module", rawInput: { prompt: "do it all" } }),
        CWD
      )
    ).toBe("deny");
  });

  it("treats folder traversal as outside the session folder", () => {
    expect(
      classifyAcpPermission(
        request({ title: "Write ../escape.txt", rawInput: { file_path: "../escape.txt" } }),
        CWD
      )
    ).toBe("ask");
  });
});

describe("helpers", () => {
  it("recovers tool names from adapter titles and null otherwise", () => {
    expect(inferAcpToolName("Read src/a.ts")).toBe("Read");
    expect(inferAcpToolName("`pnpm test`")).toBe("Bash");
    expect(inferAcpToolName("Something the agent invented")).toBeNull();
  });

  it("collects paths from locations and known input fields", () => {
    expect(
      extractAcpPaths(
        request({
          title: "Edit",
          rawInput: { file_path: "a.ts" },
          locations: [{ path: "b.ts" }]
        })
      )
    ).toEqual(["b.ts", "a.ts"]);
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
  function permissionRequest(title: string, rawInput: unknown) {
    return {
      sessionId: "agent-sess-1",
      toolCall: { toolCallId: "call-9", title, rawInput },
      options: options()
    };
  }

  it("answers an allowed read with the single-use option", async () => {
    const response = await decideAcpPermission(
      permissionRequest("Read src/a.ts", {}),
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
      permissionRequest("`rm -rf /tmp/x`", { command: "rm -rf /tmp/x" }),
      CWD,
      async (builtIn) => {
        asked.push(builtIn.toolCallId);
        return "allow";
      }
    );
    expect(allow.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    const deny = await decideAcpPermission(
      permissionRequest("`rm -rf /tmp/x`", { command: "rm -rf /tmp/x" }),
      CWD,
      async () => "deny"
    );
    expect(deny.outcome).toEqual({ outcome: "cancelled" });
    expect(asked).toEqual(["call-9"]);
  });

  it("refuses the unknown without asking anyone", async () => {
    const response = await decideAcpPermission(
      permissionRequest("Invent everything", { whatever: true }),
      CWD,
      async () => {
        throw new Error("must not ask a person for the unknown");
      }
    );
    expect(response.outcome).toEqual({ outcome: "cancelled" });
  });
});
