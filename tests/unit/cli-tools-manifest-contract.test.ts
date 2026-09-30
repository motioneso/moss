import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acpInitialize,
  checkHandshakeResult
} from "../../scripts/cli-tools-manifest/contract-check.js";
import {
  captureLaunchCommands,
  extractLongFlags,
  missingFlags,
  toolsFlagWithMcp
} from "../../scripts/cli-tools-manifest/launch-commands.js";

describe("launch flag extraction", () => {
  it("reads long flags, including camel-case ones, and ignores quoted prompt text", () => {
    const line = `claude --print --allowedTools 'mcp__a__* --fake' --model x "$(cat p --not-a-flag)"`;
    expect(extractLongFlags(line)).toEqual(["--print", "--allowedTools", "--model"]);
  });

  it("reports a flag the tool's help no longer lists", () => {
    const help = "Options:\n  --print  print\n  --verbose  loud\n";
    expect(missingFlags(["--print", "--strict-mcp-config"], help)).toEqual(["--strict-mcp-config"]);
  });

  it("does not let a longer flag name satisfy a shorter one", () => {
    expect(missingFlags(["--tools"], "  --tools-extra  something")).toEqual(["--tools"]);
  });
});

describe("the --tools guard", () => {
  it("flags --tools next to the Moss tool server config", () => {
    expect(toolsFlagWithMcp('claude --mcp-config /x --tools ""')).toBe(true);
    expect(toolsFlagWithMcp('claude --tools ""')).toBe(false);
  });

  it("holds for every command Moss really launches", async () => {
    const commands = await captureLaunchCommands();
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const c of commands) expect(toolsFlagWithMcp(c.line), c.label).toBe(false);
  });
});

async function fakeAdapter(reply: object): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-adapter-"));
  const file = path.join(dir, "adapter.js");
  await writeFile(
    file,
    `process.stdin.once("data", () => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ${JSON.stringify(reply)} }) + "\\n"); });\nsetTimeout(() => {}, 60000);\n`
  );
  return file;
}

describe("adapter handshake", () => {
  it("passes an adapter that speaks protocol 1 and describes its capabilities", async () => {
    const file = await fakeAdapter({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } }
    });
    const answer = await acpInitialize(
      process.execPath,
      [file],
      { PATH: process.env.PATH },
      10_000
    );
    expect(checkHandshakeResult(answer)).toBeNull();
  });

  it("fails an adapter that moved to another protocol version", async () => {
    const file = await fakeAdapter({ protocolVersion: 2, agentCapabilities: {} });
    const answer = await acpInitialize(
      process.execPath,
      [file],
      { PATH: process.env.PATH },
      10_000
    );
    expect(checkHandshakeResult(answer)).toMatch(/protocol version 2/);
  });

  it("fails an adapter that never answers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fake-adapter-"));
    const file = path.join(dir, "silent.js");
    await writeFile(file, "setTimeout(() => {}, 60000);\n");
    await expect(
      acpInitialize(process.execPath, [file], { PATH: process.env.PATH }, 500)
    ).rejects.toThrow(/did not answer/);
  });
});
