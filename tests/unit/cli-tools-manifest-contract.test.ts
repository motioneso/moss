import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acpInitialize,
  acpInitializeViaResolver,
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

  it("reads a folded help entry such as --append-system-prompt[-file]", () => {
    const help =
      "  --append-system-prompt <prompt>  x\n  e.g. --append-system-prompt[-file], --add-dir";
    expect(missingFlags(["--append-system-prompt-file", "--append-system-prompt"], help)).toEqual(
      []
    );
    expect(missingFlags(["--append-system-prompt-files"], help)).toEqual([
      "--append-system-prompt-files"
    ]);
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

describe("adapter handshake through the real resolver", () => {
  /** A tools volume laid out the way the runner installs the CLI and, optionally, the adapter. */
  async function toolsVolume(withAdapter: boolean): Promise<{ prefix: string; cli: string }> {
    const prefix = await mkdtemp(path.join(tmpdir(), "tools-volume-"));
    const providers = path.join(prefix, "providers");
    const cliRelease = path.join(providers, "anthropic", "releases", "r1");
    await mkdir(path.join(cliRelease, "node_modules", ".bin"), { recursive: true });
    const cli = path.join(cliRelease, "node_modules", ".bin", "claude");
    await writeFile(cli, "#!/bin/sh\n");
    await chmod(cli, 0o755);
    await symlink(cliRelease, path.join(providers, "anthropic", "current"));
    if (withAdapter) {
      const release = path.join(providers, "anthropic-adapter", "releases", "r1");
      const dist = path.join(
        release,
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
        "dist"
      );
      await mkdir(dist, { recursive: true });
      await writeFile(
        path.join(dist, "index.js"),
        `process.stdin.once("data", () => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, seenCli: process.env.CLAUDE_CODE_EXECUTABLE } }) + "\\n"); });\nsetTimeout(() => {}, 60000);\n`
      );
      await symlink(release, path.join(providers, "anthropic-adapter", "current"));
    }
    return { prefix, cli };
  }

  it("starts the adapter the resolver picks, with the CLI the resolver picks", async () => {
    const { prefix, cli } = await toolsVolume(true);
    const answer = (await acpInitializeViaResolver(prefix, "anthropic", 10_000)) as {
      seenCli?: string;
    };
    expect(checkHandshakeResult(answer)).toBeNull();
    expect(answer.seenCli).toBe(cli);
  });

  it("fails when the resolver finds no adapter instead of starting some other copy", async () => {
    const { prefix } = await toolsVolume(false);
    await expect(acpInitializeViaResolver(prefix, "anthropic", 2_000)).rejects.toThrow(
      /resolver found no adapter/
    );
  });
});
