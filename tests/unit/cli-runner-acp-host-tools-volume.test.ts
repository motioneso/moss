/**
 * AcpHost on the tools volume (#2689 slice 2): the adapter and the CLI come from the tools
 * volume when installed, and from the image otherwise.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcpHost, defaultResolveAdapterTarget } from "../../packages/cli-runner/src/acp-host.js";
import { applyToolsVolumeCli } from "../../packages/cli-runner/src/tools-volume-adapters.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acp-2689-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function release(slot: string, files: Record<string, string>, mode = 0o644): string {
  const dir = join(root, "tools", "providers", slot, "releases", "r1");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body, { mode });
  }
  symlinkSync(join("releases", "r1"), join(root, "tools", "providers", slot, "current"));
  return dir;
}

describe("adapter resolution", () => {
  it("runs the tools volume adapter when installed and the image copy once it is gone", () => {
    const prefix = join(root, "tools");
    const image = defaultResolveAdapterTarget("anthropic", prefix).args[0];
    expect(image).toContain(join("node_modules", "@agentclientprotocol", "claude-agent-acp"));
    const entry = "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    const dir = release("anthropic-adapter", { [entry]: "//" });
    expect(defaultResolveAdapterTarget("anthropic", prefix).args).toEqual([join(dir, entry)]);
    expect(defaultResolveAdapterTarget("openai", prefix).args[0]).toContain("codex-acp");
    rmSync(join(prefix, "providers", "anthropic-adapter"), { recursive: true, force: true });
    expect(defaultResolveAdapterTarget("anthropic", prefix).args[0]).not.toContain(prefix);
  });
});

describe("launch environment", () => {
  function makeHost(toolsPrefix: string) {
    const seen: NodeJS.ProcessEnv[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: () => undefined },
      kill: () => true
    });
    const host = new AcpHost({
      neutralBase: join(root, "neutral"),
      homeBase: join(root, "homes"),
      allowSharedUid: true,
      toolsPrefix,
      resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
      spawnChild: (opts) => (seen.push(opts.env), child as never)
    });
    return { host, seen };
  }

  it("points the Claude adapter at the tools volume CLI, and only when one is installed", async () => {
    mkdirSync(join(root, "homes"), { recursive: true });
    mkdirSync(join(root, "neutral"), { recursive: true });
    const { host, seen } = makeHost(join(root, "tools"));
    await host.spawn("chat:u:a", "proj", "anthropic", "u", "workshop");
    expect(seen[0]?.CLAUDE_CODE_EXECUTABLE).toBeUndefined();

    const dir = release("anthropic", { "node_modules/.bin/claude": "#!/bin/sh\n" }, 0o755);
    await host.spawn("chat:u:c", "proj", "anthropic", "u", "workshop");
    await host.spawn("chat:u:e", "proj", "opencode", "u", "workshop");
    expect(seen[1]?.CLAUDE_CODE_EXECUTABLE).toBe(join(dir, "node_modules/.bin/claude"));
    expect(seen[2]?.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
  });

  it("sets the Codex override from the installed release and never overrides an existing one", () => {
    const dir = release("openai-compatible", { "node_modules/.bin/codex": "#!/bin/sh\n" }, 0o755);
    const env: NodeJS.ProcessEnv = {};
    applyToolsVolumeCli(env, join(root, "tools"), "openai");
    expect(env.CODEX_PATH).toBe(join(dir, "node_modules/.bin/codex"));
    const preset: NodeJS.ProcessEnv = { CODEX_PATH: "/custom/codex" };
    applyToolsVolumeCli(preset, join(root, "tools"), "openai");
    expect(preset.CODEX_PATH).toBe("/custom/codex");
  });
});
