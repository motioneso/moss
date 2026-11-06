import { describe, expect, it } from "vitest";

import type { TmuxIo } from "@moss/ai";

import { ClaudePersistentRuntime } from "./claude-persistent-runtime.js";
import { CLAUDE_SELF_SCHEDULING_TOOLS } from "./claude-self-scheduling-tools.js";
import { buildLaunchCommand } from "./module-build-launch-commands.js";
import { ClaudePrintChatEngine } from "./structured-claude-engine.js";
import type { EngineLaunchOpts } from "./types.js";

function stubIo(): TmuxIo {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile() {
      throw new Error("ENOENT");
    },
    async writeFile() {},
    async sleep() {}
  };
}

const opts: EngineLaunchOpts = {
  neutralDir: "/tmp/neutral",
  personaPath: "/tmp/neutral/persona.md",
  mcpToken: "jst_test",
  mcpServerUrl: "http://127.0.0.1:1/mcp"
};

/** Tool names handed to --disallowedTools (every word up to the next flag). */
function disallowed(command: string): string[] {
  const match = /--disallowedTools((?: [^-\s][^\s]*)+)/.exec(command);
  return match?.[1]?.trim().split(" ") ?? [];
}

function expectAllOff(command: string): void {
  const off = disallowed(command);
  for (const tool of CLAUDE_SELF_SCHEDULING_TOOLS) expect(off).toContain(tool);
  expect(off).toEqual(expect.arrayContaining(["ScheduleWakeup", "CronCreate", "CronDelete"]));
}

describe("Claude chat launches switch off self-scheduling built-ins (#3340)", () => {
  it("main chat persistent launch", async () => {
    const runtime = new ClaudePersistentRuntime({ io: stubIo() });
    const command = await (
      runtime as unknown as {
        buildCommand(o: EngineLaunchOpts, p: string): Promise<string>;
      }
    ).buildCommand(opts, "/tmp/neutral/persona.md");
    expectAllOff(command);
  });

  it("one-shot chat launch", async () => {
    const engine = new ClaudePrintChatEngine("thread", stubIo(), {});
    const command = await (
      engine as unknown as {
        buildCommand(o: EngineLaunchOpts, p: string): Promise<string>;
      }
    ).buildCommand(opts, "/tmp/neutral/prompt.txt");
    expectAllOff(command);
  });

  it.each([false, true])("module-build launch (workspaceWrite=%s)", async (workspaceWrite) => {
    const command = await buildLaunchCommand(
      {
        provider: "anthropic",
        io: stubIo(),
        executionMode: "cli" as never,
        codexTokenEnvPath: null
      },
      { ...opts, workspaceWrite },
      "11111111-1111-4111-8111-111111111111",
      "/tmp/neutral/persona.md"
    );
    expectAllOff(command);
    if (workspaceWrite) expect(disallowed(command)).toContain("Bash");
  });
});
