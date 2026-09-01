// tests/uat/fixtures/scripted-provider/launch-args.ts
//
// #1121: parses the argv the real `claude` CLI would receive from
// packages/chat/src/live/claude-print-chat-engine.ts's buildCommand (bounded/print engine) after
// shell word-splitting. Fail-closed: anything not exactly one of the two known-safe shapes is
// "rejected", including buildStructuredCommand's shape (used by the non-interactive/structured
// engine path, which this fixture does not support) and any unrecognized flag.

export type ParsedLaunch =
  | {
      readonly kind: "bounded";
      readonly sessionFlag: { mode: "new" | "resume"; id: string };
      readonly mcp?: { configPath: string; allowedTools: readonly string[] };
      readonly promptText: string;
      readonly model?: string;
    }
  | { readonly kind: "no-mcp"; readonly promptText: string }
  | { readonly kind: "rejected"; readonly reason: string };

const STRUCTURED_COMMAND_MARKERS = [
  "--print",
  "--input-format",
  "--output-format",
  "--include-partial-messages",
  "--no-session-persistence",
  "--json-schema"
];

function rejected(reason: string): ParsedLaunch {
  return { kind: "rejected", reason };
}

export function parseClaudeLaunchArgs(argv: readonly string[]): ParsedLaunch {
  for (const marker of STRUCTURED_COMMAND_MARKERS) {
    if (argv.includes(marker)) {
      return rejected(
        `saw structured/print command shape (${marker}) — buildStructuredCommand is not a supported launch path for this fixture, only the bounded print engine's -p path is`
      );
    }
  }

  if (!argv.includes("-p")) return rejected("missing -p");

  const tokens = [...argv];
  const takeFlagValue = (flag: string): string | undefined => {
    const index = tokens.indexOf(flag);
    if (index === -1) return undefined;
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) return undefined;
    tokens.splice(index, 2);
    return value;
  };
  const takeFlag = (flag: string): boolean => {
    const index = tokens.indexOf(flag);
    if (index === -1) return false;
    tokens.splice(index, 1);
    return true;
  };

  const pIndex = tokens.indexOf("-p");
  tokens.splice(pIndex, 1);

  const hasSessionId = tokens.includes("--session-id");
  const hasResume = tokens.includes("--resume");
  if (hasSessionId === hasResume) {
    return rejected(
      hasSessionId ? "both --session-id and --resume present" : "missing --session-id or --resume"
    );
  }
  const sessionId = takeFlagValue(hasSessionId ? "--session-id" : "--resume");
  if (sessionId === undefined) return rejected("session flag missing its id value");

  const permissionMode = takeFlagValue("--permission-mode");
  if (permissionMode !== "dontAsk") return rejected('--permission-mode must be "dontAsk"');

  const configPath = takeFlagValue("--mcp-config");
  const settingsPath = takeFlagValue("--settings");
  const allowedToolsRaw = takeFlagValue("--allowedTools");
  const bareTools = takeFlagValue("--tools");

  const hasMcpTrio =
    configPath !== undefined && settingsPath !== undefined && allowedToolsRaw !== undefined;
  const hasMcpPartial =
    (configPath !== undefined || settingsPath !== undefined || allowedToolsRaw !== undefined) &&
    !hasMcpTrio;
  if (hasMcpPartial) return rejected("partial --mcp-config/--settings/--allowedTools combination");
  // The real read-only launch command pairs the MCP trio with a non-empty bare --tools value
  // (claude-print-chat-engine.ts's buildCommand, '--tools "Read,Glob,Grep"'). An empty --tools
  // alongside the trio is a mismatch the fixture still rejects.
  if (hasMcpTrio && bareTools === "") {
    return rejected("empty --tools alongside the MCP flag trio");
  }
  if (!hasMcpTrio && bareTools !== "") {
    return rejected(
      'unrecognized tool flag combination — expected --mcp-config trio or bare --tools ""'
    );
  }

  const appendSystemPromptFile = takeFlagValue("--append-system-prompt-file");
  if (appendSystemPromptFile === undefined) return rejected("missing --append-system-prompt-file");

  if (!takeFlag("--strict-mcp-config")) return rejected("missing --strict-mcp-config");

  const model = takeFlagValue("--model");

  const remaining = tokens.filter((t) => t.length > 0);
  const unrecognizedFlag = remaining.find((t) => t.startsWith("-"));
  if (unrecognizedFlag) return rejected(`unrecognized flag "${unrecognizedFlag}"`);
  if (remaining.length !== 1) {
    return rejected(`expected exactly one trailing prompt-text argument, got ${remaining.length}`);
  }
  const promptText = remaining[0] as string;

  const sessionFlag = { mode: (hasResume ? "resume" : "new") as "new" | "resume", id: sessionId };

  if (hasMcpTrio) {
    return {
      kind: "bounded",
      sessionFlag,
      mcp: { configPath, allowedTools: (allowedToolsRaw as string).split(" ").filter(Boolean) },
      promptText,
      ...(model !== undefined ? { model } : {})
    };
  }
  return { kind: "no-mcp", promptText };
}
