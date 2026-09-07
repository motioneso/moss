import { describe, expect, it } from "vitest";

// Entry first: the adapter's modules only load in a working order this way.
import "@zed-industries/claude-code-acp";
import { toolInfoFromToolUse } from "@zed-industries/claude-code-acp/dist/tools.js";
import type { PermissionOption } from "@agentclientprotocol/sdk";

import {
  classifyAcpPermission,
  decideAcpPermission,
  extractAcpPaths,
  isInsideSessionFolder,
  selectAllowOptionId,
  toolNameFromMeta,
  type AcpBuiltInRequest,
  type AcpSessionFolders
} from "./permissions.js";

const CWD = "/runner/session/acp/proj";
const HOME = "/home/agent";
const FOLDERS: AcpSessionFolders = { cwd: CWD, home: HOME };

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
      expect(classifyAcpPermission(request({ title, toolName: null }), FOLDERS)).toEqual({
        verdict: "deny",
        reason: "unknown_tool"
      });
    }
  });

  it("refuses a name outside the explicit lists", () => {
    expect(
      classifyAcpPermission(request({ title: "t", toolName: "DefinitelyNotATool" }), FOLDERS)
    ).toEqual({
      verdict: "deny",
      reason: "unknown_tool"
    });
  });

  it("refuses mode changes and tools that are never offered", () => {
    for (const toolName of ["ExitPlanMode", "EnterPlanMode", "Task", "Skill"]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), FOLDERS)).toEqual({
        verdict: "deny",
        reason: "not_offered"
      });
    }
  });

  it("allows named read-only tools inside the folder", () => {
    for (const toolName of [
      "Read",
      "mcp__acp__Read",
      "NotebookRead",
      "LS",
      "Glob",
      "Grep",
      "WebSearch",
      "TodoWrite",
      "BashOutput"
    ]) {
      const rawInput = toolName === "WebSearch" ? { query: "q" } : { file_path: "src/a.ts" };
      expect(classifyAcpPermission(request({ title: "t", toolName, rawInput }), FOLDERS)).toEqual({
        verdict: "allow"
      });
    }
  });

  it("refuses a bare Read that names no file", () => {
    expect(
      classifyAcpPermission(request({ title: "Read", toolName: "Read", rawInput: {} }), FOLDERS)
    ).toEqual({ verdict: "deny", reason: "malformed" });
  });

  it("allows a named write inside the folder and asks outside it", () => {
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Write", rawInput: { file_path: "src/out.txt" } }),
        FOLDERS
      )
    ).toEqual({ verdict: "allow" });
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Edit", rawInput: { file_path: "/etc/passwd" } }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "NotebookEdit", rawInput: {} }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
  });

  it("always asks for shell", () => {
    for (const toolName of ["Bash", "mcp__acp__Bash", "KillShell"]) {
      expect(classifyAcpPermission(request({ title: "t", toolName }), FOLDERS)).toEqual({
        verdict: "ask"
      });
    }
  });

  it("refuses the agent home and the system pseudofolders with no card", () => {
    for (const target of [
      "/home/agent/.jarvis/token",
      "/home/agent/.claude.json",
      "/proc/self/environ",
      "/sys/kernel",
      "/dev/null",
      "/run/secrets/x"
    ]) {
      expect(
        classifyAcpPermission(
          request({ title: "t", toolName: "Read", rawInput: { file_path: target } }),
          FOLDERS
        )
      ).toEqual({ verdict: "deny", reason: "forbidden_zone" });
    }
  });

  it("asks for secret-shaped names inside the folder instead of reading quietly", () => {
    for (const target of ["src/../.env", ".env.production", "keys/id_rsa", "cert.p12"]) {
      expect(
        classifyAcpPermission(
          request({ title: "t", toolName: "Read", rawInput: { file_path: target } }),
          FOLDERS
        )
      ).toEqual({ verdict: "ask" });
    }
  });

  it("asks for a read outside the folder that is not forbidden, and allows a bare search", () => {
    // /etc/hosts is the person's own file system: a card with the path, not a refusal.
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Read", rawInput: { file_path: "/etc/hosts" } }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
    // Glob and Grep with no path search the session folder by default.
    for (const toolName of ["Glob", "Grep", "LS"]) {
      expect(
        classifyAcpPermission(
          request({ title: "t", toolName, rawInput: { pattern: "*" } }),
          FOLDERS
        )
      ).toEqual({ verdict: "allow" });
    }
  });

  it("judges a request naming several files by its most sensitive one", () => {
    expect(
      classifyAcpPermission(
        request({
          title: "t",
          toolName: "Read",
          rawInput: { file_path: ".env" },
          locations: [{ path: "/home/agent/.jarvis/cli-tokens/claude" }]
        }),
        FOLDERS
      )
    ).toEqual({ verdict: "deny", reason: "forbidden_zone" });
    expect(
      classifyAcpPermission(
        request({
          title: "t",
          toolName: "Read",
          rawInput: { file_path: ".env" },
          locations: [{ path: "/etc/hosts" }]
        }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
  });

  // Known gap, not a passing test that proves nothing: a link inside the
  // session folder pointing at a secret passes the lexical check. The decision
  // runs on the API side and cannot resolve paths on the runner host. The
  // runner's per-user account plus the 0600 token file is the containment that
  // does not care about paths, and only exists with per-user identity on.
  // Spec section 4, known limits.

  it("treats folder traversal as outside the session folder", () => {
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "Write", rawInput: { file_path: "../escape.txt" } }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
  });

  it("asks for loopback, private and bare web addresses", () => {
    for (const url of [
      "http://localhost:3000/x",
      "http://127.0.0.1:8080/",
      "http://10.0.0.5/docs",
      "http://192.168.1.2/",
      "http://172.20.0.9/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://printer/"
    ]) {
      expect(
        classifyAcpPermission(
          request({ title: "t", toolName: "WebFetch", rawInput: { url } }),
          FOLDERS
        )
      ).toEqual({ verdict: "ask" });
    }
  });

  it("allows public web addresses and refuses a fetch with none", () => {
    // Names that merely start like an IPv6 private prefix are public hosts.
    for (const url of ["https://example.com/docs", "https://fcc.gov/", "https://fdroid.org/x"]) {
      expect(
        classifyAcpPermission(
          request({ title: "t", toolName: "WebFetch", rawInput: { url } }),
          FOLDERS
        )
      ).toEqual({ verdict: "allow" });
    }
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "WebFetch", rawInput: { url: "not a url" } }),
        FOLDERS
      )
    ).toEqual({ verdict: "ask" });
    expect(
      classifyAcpPermission(request({ title: "t", toolName: "WebFetch", rawInput: {} }), FOLDERS)
    ).toEqual({ verdict: "deny", reason: "malformed" });
  });

  it("allows Moss tools at the agent prompt", () => {
    expect(
      classifyAcpPermission(
        request({ title: "t", toolName: "mcp__moss__calendar_createEvent", rawInput: {} }),
        FOLDERS
      )
    ).toEqual({ verdict: "allow" });
  });
});

/**
 * Fixtures built by the adapter's own title/kind/locations mapping, so the
 * policy tests track what the adapter really sends. The question in each case
 * carries only the id, the raw input and the display title.
 */
describe("adapter-built fixtures", () => {
  function announced(name: string, input: Record<string, unknown>): AcpBuiltInRequest {
    const info = toolInfoFromToolUse({ name, input });
    return {
      sessionId: "agent-sess-1",
      toolCallId: "call-9",
      title: info.title,
      rawInput: input,
      toolName: name,
      kind: info.kind ?? null,
      locations: info.locations ?? null
    };
  }

  it("allows the announced read, write-inside, and public fetch", () => {
    expect(classifyAcpPermission(announced("Read", { file_path: "src/a.ts" }), FOLDERS)).toEqual({
      verdict: "allow"
    });
    expect(classifyAcpPermission(announced("Edit", { file_path: "src/a.ts" }), FOLDERS)).toEqual({
      verdict: "allow"
    });
    expect(
      classifyAcpPermission(announced("WebFetch", { url: "https://example.com/x" }), FOLDERS)
    ).toEqual({ verdict: "allow" });
  });

  it("asks the announced write-outside and shell run, refuses the rest", () => {
    expect(classifyAcpPermission(announced("Edit", { file_path: "/etc/passwd" }), FOLDERS)).toEqual(
      { verdict: "ask" }
    );
    expect(classifyAcpPermission(announced("Bash", { command: "pnpm build" }), FOLDERS)).toEqual({
      verdict: "ask"
    });
    expect(classifyAcpPermission(announced("ExitPlanMode", {}), FOLDERS)).toEqual({
      verdict: "deny",
      reason: "not_offered"
    });
    expect(
      classifyAcpPermission(announced("Task", { description: "x", prompt: "y" }), FOLDERS)
    ).toEqual({ verdict: "deny", reason: "not_offered" });
  });

  it("refuses a task whose description mimics a read, title and all", async () => {
    const built = announced("Task", {
      description: "Read the repository and summarize the layout",
      prompt: "Read every file and report back."
    });
    expect(built.title).toBe("Read the repository and summarize the layout");
    const verdict = await decideAcpPermission(built, FOLDERS, async () => {
      throw new Error("must not ask a person about a subagent");
    });
    expect(verdict).toEqual({ decision: "deny", asked: false, reason: "not_offered" });
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
      FOLDERS,
      async () => {
        throw new Error("must not ask a person about a subagent");
      }
    );
    expect(verdict).toEqual({ decision: "deny", asked: false, reason: "not_offered" });
  });

  it("refuses the same mimic with no name rather than trusting the title", async () => {
    const verdict = await decideAcpPermission(
      request({
        title: "Read the repository and summarize the layout",
        rawInput: mimicInput,
        toolName: null
      }),
      FOLDERS,
      async () => {
        throw new Error("must not ask a person for the unnamed");
      }
    );
    expect(verdict).toEqual({ decision: "deny", asked: false, reason: "unknown_tool" });
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

  it("collects paths from locations and the known input fields", () => {
    expect(
      extractAcpPaths(
        request({
          title: "t",
          toolName: "Edit",
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
  it("allows a named read without asking anyone", async () => {
    const verdict = await decideAcpPermission(
      request({ title: "Read File", rawInput: { file_path: "src/a.ts" }, toolName: "Read" }),
      FOLDERS,
      async () => {
        throw new Error("must not ask a person for a read");
      }
    );
    expect(verdict).toEqual({ decision: "allow", asked: false, reason: null });
  });

  it("asks a person for a shell command and honors the answer", async () => {
    const asked: string[] = [];
    const allow = await decideAcpPermission(
      request({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        toolName: "Bash"
      }),
      FOLDERS,
      async (builtIn) => {
        asked.push(builtIn.toolCallId);
        return "allow";
      }
    );
    expect(allow).toEqual({ decision: "allow", asked: true, reason: null });
    const deny = await decideAcpPermission(
      request({
        title: "`rm -rf /tmp/x`",
        rawInput: { command: "rm -rf /tmp/x" },
        toolName: "Bash"
      }),
      FOLDERS,
      async () => "deny"
    );
    expect(deny).toEqual({ decision: "deny", asked: true, reason: "denied_by_person" });
    expect(asked).toEqual(["call-1"]);
  });
});
