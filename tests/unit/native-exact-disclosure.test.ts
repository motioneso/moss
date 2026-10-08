import { describe, expect, it } from "vitest";
import { acpCardText } from "../../packages/ai/src/gateway/acp-permission.js";
import { nativeToolSummary } from "../../packages/ai/src/gateway/native-tool-guard.js";
import type { AcpBuiltInRequest } from "@moss/acp";

function request(toolName: string, rawInput: Record<string, unknown>): AcpBuiltInRequest {
  return {
    toolName,
    rawInput,
    sessionId: "session",
    turnId: "turn",
    toolCallId: "call",
    title: "Untrusted misleading title",
    kind: null,
    locations: null
  };
}
describe("native exact pending disclosure", () => {
  it("retains a command tail far beyond the old 200-character display cap", () => {
    const command = `echo ${"a".repeat(20000)}\nthen perform the final action`;
    expect(acpCardText(request("Bash", { command }))).toBe(
      `The agent wants to use Bash: ${command}`
    );
  });
  it("retains complete long file paths and addresses", () => {
    const path = `/workspace/${"long-directory/".repeat(100)}important.txt`;
    expect(acpCardText(request("Read", { file_path: path }))).toBe(
      `The agent wants to use Read: ${path}`
    );
    const url = `https://example.test/${"part/".repeat(100)}final`;
    expect(acpCardText(request("WebFetch", { url }))).toBe(
      `The agent wants to use WebFetch: ${url}`
    );
  });
  it("does not substitute a model-written description for exact unknown input", () => {
    const input = { path: "target", nested: { operation: "delete" } };
    const result = acpCardText(request("Unknown", input));
    expect(result).not.toContain("Untrusted misleading title");
    expect(result).toContain(JSON.stringify(input, null, 2));
  });
  it("direct native asks disclose all nested command, path and write values", () => {
    const input = {
      command: "printf 'hello'\nls",
      file_path: "/workspace/target",
      content: "  long exact\ntext ".repeat(1000),
      nested: [null, false, 12]
    };
    expect(nativeToolSummary("Bash", input)).toBe(
      `Claude wants to use native Bash:\n${JSON.stringify(input, null, 2)}`
    );
  });
});
