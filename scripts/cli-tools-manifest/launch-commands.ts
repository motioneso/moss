// Captures the command lines Moss launches for each provider by driving the real engine
// classes against stub terminals, then extracts the long flags so the contract check can
// confirm a candidate CLI still accepts every one of them.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import type { TmuxIo } from "@moss/ai";

import { ClaudePersistentRuntime } from "../../packages/chat/src/live/claude-persistent-runtime.js";
import { CodexPersistentRuntime } from "../../packages/chat/src/live/codex-persistent-runtime.js";
import { GeminiPrintChatEngine } from "../../packages/chat/src/live/structured-gemini-engine.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/structured-claude-engine.js";

export interface CapturedCommand {
  readonly provider: string;
  readonly label: string;
  readonly line: string;
  /** Sub-command words between the binary and its flags, such as "exec" for codex. */
  readonly subcommand?: string;
}

/** Long flags (`--name`) outside quoted text. Quoted text holds prompts and JSON, not flags. */
export function extractLongFlags(line: string): string[] {
  const unquoted = line.replace(/"[^"]*"|'[^']*'/g, " ");
  return [
    ...new Set([...unquoted.matchAll(/(?:^|\s)(--[A-Za-z][A-Za-z0-9-]*)/g)].map((m) => m[1]!))
  ];
}

/** Flags absent from the tool's own help text. Empty means the tool still accepts them all. */
export function missingFlags(flags: readonly string[], helpText: string): string[] {
  return flags.filter((flag) => !new RegExp(`${flag}(?![A-Za-z0-9-])`).test(helpText));
}

/**
 * The guard behind the #2317 break: any `--tools` value drops every Moss tool, so the launch
 * that attaches the Moss tool server must never carry it.
 */
export function toolsFlagWithMcp(line: string): boolean {
  return /--mcp-config\b/.test(line) && /--tools\b/.test(line);
}

function stubIo(): TmuxIo {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile() {
      throw new Error("stub io has no files");
    },
    async writeFile() {},
    async sleep() {}
  };
}

const LAUNCH = {
  neutralDir: "/tmp/cli-tools-contract",
  personaPath: "/tmp/cli-tools-contract/persona.md",
  personaText: "persona",
  mcpToken: "jst_contract-check",
  mcpServerUrl: "http://127.0.0.1:9/mcp"
} as const;

type Private = Record<string, (...args: unknown[]) => Promise<string> | string>;

async function captureGemini(): Promise<string> {
  const spawnOriginal = childProcess.spawn;
  let line = "";
  (childProcess as { spawn: unknown }).spawn = (_cmd: string, args: readonly string[]) => {
    line = String(args[1] ?? "");
    throw new Error("captured");
  };
  syncBuiltinESMExports();
  try {
    const engine = new GeminiPrintChatEngine("contract", stubIo(), {
      sessionId: "00000000-0000-4000-8000-000000000001"
    });
    await engine.launch({ ...LAUNCH });
    await engine.submit("contract check").catch(() => undefined);
  } finally {
    (childProcess as { spawn: unknown }).spawn = spawnOriginal;
    syncBuiltinESMExports();
  }
  if (line === "") throw new Error("gemini launch command was not captured");
  return line;
}

export async function captureLaunchCommands(): Promise<CapturedCommand[]> {
  const io = stubIo();
  const claudePrint = new ClaudePrintChatEngine("contract", io, {
    sessionId: "00000000-0000-4000-8000-000000000002"
  }) as unknown as Private;
  const claudePersistent = new ClaudePersistentRuntime({ io }) as unknown as Private;
  const codex = new CodexPersistentRuntime({ io }) as unknown as Private & {
    launchOpts: unknown;
  };
  codex.launchOpts = { ...LAUNCH };

  return [
    {
      provider: "anthropic",
      label: "one-shot with Moss tools",
      line: String(
        await claudePrint.buildCommand!({ ...LAUNCH }, "/tmp/cli-tools-contract/prompt.txt")
      )
    },
    {
      provider: "anthropic",
      label: "structured",
      line: String(
        await claudePrint.buildStructuredCommand!({ ...LAUNCH, schema: { type: "object" } })
      )
    },
    {
      provider: "anthropic",
      label: "persistent chat",
      line: String(await claudePersistent.buildCommand!({ ...LAUNCH }, LAUNCH.personaPath))
    },
    {
      provider: "openai-compatible",
      label: "first turn",
      line: String(codex.buildCommand!("/tmp/cli-tools-contract/prompt.txt", true)),
      subcommand: "exec"
    },
    { provider: "google", label: "one-shot", line: await captureGemini() }
  ];
}
