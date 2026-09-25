import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLI_FLAG_CONTRACTS,
  UNKNOWN_FLAG_RE,
  helpMentionsCommand,
  helpMentionsFlag
} from "../../packages/cli-runner/src/cli-tools/flag-contract.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Every source file that builds a provider CLI command line. */
const ENGINE_SOURCES = [
  "packages/chat/src/live/structured-claude-engine.ts",
  "packages/chat/src/live/claude-persistent-runtime.ts",
  "packages/chat/src/live/codex-persistent-runtime.ts",
  "packages/chat/src/live/module-build-codex-exec-session.ts",
  "packages/chat/src/live/module-build-launch-commands.ts",
  "packages/chat/src/live/module-build-cli-engine.ts",
  "packages/chat/src/live/structured-gemini-engine.ts",
  "packages/chat/src/live/provider-probe.ts",
  "packages/chat/src/live/persistent-runtime-engine.ts",
  "packages/cli-runner/src/login-adapters.ts"
];

/** Flags every CLI answers and the contract does not need to track. */
const UNTRACKED_FLAGS = new Set(["--version", "--help"]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function longFlagsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/["'`\s](--[A-Za-z][A-Za-z-]*)/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe("CLI flag contract", () => {
  it("names every long flag the engines pass to a provider CLI", () => {
    const declared = new Set<string>();
    for (const contract of CLI_FLAG_CONTRACTS) {
      for (const surface of contract.surfaces) {
        surface.flags.forEach((flag) => declared.add(flag));
        surface.hiddenFlagProbes?.forEach((probe) => declared.add(probe.flag));
      }
    }
    const missing: string[] = [];
    for (const file of ENGINE_SOURCES) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const flag of longFlagsIn(source)) {
        if (!declared.has(flag) && !UNTRACKED_FLAGS.has(flag)) missing.push(`${file}: ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every toolset at least one surface", () => {
    expect(CLI_FLAG_CONTRACTS.map((c) => c.toolset).sort()).toEqual([
      "anthropic",
      "google",
      "openai-compatible"
    ]);
    for (const contract of CLI_FLAG_CONTRACTS) expect(contract.surfaces.length).toBeGreaterThan(0);
  });

  it("reads flags out of clap and commander style help", () => {
    const help = [
      "Options:",
      "  -c, --config <key=value>   Override a value",
      "  -s, --sandbox <MODE>       Sandbox policy",
      "      --json                 Print events",
      "  --output-format=<fmt>      Output format",
      "  [--last]"
    ].join("\n");
    expect(helpMentionsFlag(help, "-c")).toBe(true);
    expect(helpMentionsFlag(help, "--config")).toBe(true);
    expect(helpMentionsFlag(help, "--sandbox")).toBe(true);
    expect(helpMentionsFlag(help, "--json")).toBe(true);
    expect(helpMentionsFlag(help, "--output-format")).toBe(true);
    expect(helpMentionsFlag(help, "--last")).toBe(true);
    expect(helpMentionsFlag(help, "--model")).toBe(false);
    // A flag that is a prefix of a listed flag is not listed.
    expect(helpMentionsFlag(help, "--output")).toBe(false);
    expect(helpMentionsFlag(help, "-s")).toBe(true);
  });

  it("reads subcommands out of help", () => {
    const help = "Commands:\n  exec    Run non-interactively\n  login   Manage login\n";
    expect(helpMentionsCommand(help, "exec")).toBe(true);
    expect(helpMentionsCommand(help, "login")).toBe(true);
    expect(helpMentionsCommand(help, "resume")).toBe(false);
  });

  it("recognises an unknown-flag rejection from each CLI family", () => {
    expect(UNKNOWN_FLAG_RE.test("error: unknown option '--nope'")).toBe(true);
    expect(UNKNOWN_FLAG_RE.test("error: unexpected argument '--nope' found")).toBe(true);
    expect(UNKNOWN_FLAG_RE.test("Unknown argument: nope")).toBe(true);
    expect(UNKNOWN_FLAG_RE.test("Append system prompt file not found")).toBe(false);
  });
});
