/**
 * Per-provider CLI launch-line builders + the per-session secret/config files they
 * reference, split out of cli-chat-engine.ts for the 1000-line file cap (#1170 —
 * same pattern as the #1157 opts split). Behavior is verbatim from the engine;
 * only the `this.*` fields became the explicit `LaunchCommandContext` below.
 *
 * The Claude launch flags are SECURITY-CRITICAL and were empirically verified in
 * the Phase 1 spike (docs/superpowers/spikes/2026-06-08-cli-capability-matrix.md);
 * see the cli-chat-engine.ts header for the flag-by-flag rationale.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ProviderKind, TmuxIo } from "@moss/ai";
import type { AiProviderExecutionMode } from "@moss/shared";

import { modelOverrideFlag, shellQuote } from "./cli-engine-helpers.js";
import { writeClaudePermissionHook } from "./claude-permission-hook.js";
import { AGY_SESSION_LOG_FILENAME } from "./private-transcript-cleanup.js";
import type { EngineLaunchOpts } from "./types.js";
import { vaultReadOnlyToolPatterns } from "./vault-allowlist.js";

const PERSONA_FILENAME = "persona.md";

const CLAUDE_MCP_FILENAME = ".jarvis-claude-mcp.json";

/** The engine fields the builders read — passed explicitly instead of `this`. */
export interface LaunchCommandContext {
  readonly provider: ProviderKind;
  readonly io: TmuxIo;
  readonly executionMode: AiProviderExecutionMode;
  /** (#363) 0600 token file the claude launch reads CLAUDE_CODE_OAUTH_TOKEN from (claude-scoped). */
  readonly credentialFile?: string;
  /** Per-session Codex MCP token env file written earlier in launch() (codex-scoped). */
  readonly codexTokenEnvPath: string | null;
}

/**
 * Build the single shell line that `cd`s into the neutral dir and launches the
 * CLI with the security-critical flags. Sent as one `send-keys` line (the
 * matrix's recommended shape).
 */
export async function buildLaunchCommand(
  ctx: LaunchCommandContext,
  opts: EngineLaunchOpts,
  sessionId: string,
  personaPath: string
): Promise<string> {
  switch (ctx.provider) {
    case "anthropic":
      return buildClaudeCommand(ctx, opts, sessionId, personaPath);
    case "openai-compatible":
      return buildCodexCommand(ctx, opts);
    case "google":
      return buildGeminiCommand(opts);
  }
}

/**
 * Build the Claude launch line. The MCP bearer token is NEVER on the line: the
 * full `--mcp-config` JSON (incl. the `Authorization: Bearer jst_…` header) is
 * written to a `0600` `<neutralDir>/.jarvis-claude-mcp.json` and the line passes
 * the PATH, not the JSON (§6.2). `claude --mcp-config` accepts a file path.
 */
async function buildClaudeCommand(
  ctx: LaunchCommandContext,
  opts: EngineLaunchOpts,
  sessionId: string,
  personaPath: string
): Promise<string> {
  // #363: when a captured OAuth token is persisted, authenticate claude via
  // CLAUDE_CODE_OAUTH_TOKEN read at RUNTIME from the 0600 file (`$(cat …)`) — the secret is
  // NEVER in the tmux argv / pane-typed string, and is scoped to THIS claude invocation only.
  const claudeCmd =
    ctx.credentialFile && existsSync(ctx.credentialFile)
      ? `CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellQuote(ctx.credentialFile)})" claude`
      : "claude";
  // #1071: REVERT of #1068 (see cli-chat-engine.ts header for the full root-cause narrative).
  // `default` is correct; #1068's `bypassPermissions` was the prod-chat 503 regression — in
  // claude 2.1.183 it triggers a BLOCKING bypass-mode accept-warning that
  // bypassPermissionsModeAccepted:true does NOT suppress → REPL never ready →
  // VerifiedSubmitError → 503. Confirmed by live prod-container test: the FULL flag set below
  // under `default` reaches a clean ready REPL and answers a turn (seeding +
  // HOME=/data/cli-auth already suppress the folder-trust wizard). Restores spike-F2 DiD.
  const parts = [
    `cd ${shellQuote(opts.neutralDir)} &&`,
    claudeCmd,
    `--permission-mode ${opts.workspaceWrite ? "acceptEdits" : "default"}`
  ];

  if (opts.mcpToken && opts.mcpServerUrl) {
    const mcpConfigPath = await writeClaudeMcpConfig(ctx.io, opts);
    parts.push(`--mcp-config ${shellQuote(mcpConfigPath)}`);
    if (!opts.workspaceWrite) {
      const settingsPath = await writeClaudePermissionHook(ctx.io, {
        neutralDir: opts.neutralDir,
        mcpToken: opts.mcpToken,
        mcpServerUrl: opts.mcpServerUrl
      });
      parts.push(`--settings ${shellQuote(settingsPath)}`);
    }
    const allowedTools = opts.workspaceWrite
      ? ["mcp__jarvis__*", "Read", "Glob", "Grep", "Write", "Edit"].join(" ")
      : ["mcp__jarvis__*", ...vaultReadOnlyToolPatterns()].join(" ");
    parts.push(`--allowedTools ${shellQuote(allowedTools)}`);
  } else if (opts.workspaceWrite) {
    parts.push(`--allowedTools ${shellQuote("Read Glob Grep Write Edit")}`);
  } else {
    parts.push('--tools ""');
  }
  if (opts.workspaceWrite) parts.push("--disallowedTools Bash");

  parts.push(
    `--append-system-prompt-file ${shellQuote(personaPath)}`,
    `--session-id ${sessionId}`,
    "--strict-mcp-config"
  );

  const modelFlag = modelOverrideFlag(opts);
  if (modelFlag) parts.push(modelFlag);

  return parts.join(" ");
}

function buildCodexCommand(ctx: LaunchCommandContext, opts: EngineLaunchOpts): string {
  const tokenEnvVar = "JARVIS_MCP_TOKEN";
  const sourceEnv = ctx.codexTokenEnvPath ? `. ${shellQuote(ctx.codexTokenEnvPath)} &&` : "";
  const codexCommand = ctx.executionMode === "non_interactive" ? "codex exec --json" : "codex";
  const parts = [`cd ${shellQuote(opts.neutralDir)} &&`, sourceEnv, codexCommand];

  // #1083 F1: deny shell_tool/apply_patch_tool on EVERY launch (was gated behind the MCP check
  // below, so no-gateway launches kept native shell/patch tools); mirrors anthropic's `--tools ""`.
  parts.push(
    `-c 'features.shell_tool=${opts.workspaceWrite ? "true" : "false"}'`,
    `-c 'features.apply_patch_tool=${opts.workspaceWrite ? "true" : "false"}'`
  );

  if (opts.mcpToken && opts.mcpServerUrl) {
    parts.push(
      `-c 'mcp_servers.jarvis.url="${opts.mcpServerUrl}"'`,
      `-c 'mcp_servers.jarvis.bearer_token_env_var="${tokenEnvVar}"'`,
      `-c 'mcp_servers.jarvis.tool_timeout_sec=180'`,
      `-c 'mcp_servers.jarvis.default_tools_approval_mode="approve"'`,
      `-c 'features.tool_call_mcp_elicitation=false'`
    );
  }
  const modelFlag = modelOverrideFlag(opts); // codex accepts -m/--model
  if (modelFlag) parts.push(modelFlag);
  // `-a never`/`approval_policy` cover shell approvals. MCP tool approval is
  // separate; auto-approve only the generated Jarv1s server so the hidden TUI
  // never blocks on a prompt the web user cannot see.
  parts.push(
    "--disable apps",
    `--sandbox ${opts.workspaceWrite ? "workspace-write" : "read-only"}`,
    "-a never",
    `-c 'approval_policy="never"'`
  );

  return parts.join(" ");
}

function buildGeminiCommand(opts: EngineLaunchOpts): string {
  // Token is already injected via .gemini/settings.json Authorization header — no env var needed.
  const parts = [
    `cd ${shellQuote(opts.neutralDir)} &&`,
    "agy",
    "--sandbox",
    ...(opts.workspaceWrite ? ["--mode", "accept-edits"] : []),
    "--log-file",
    shellQuote(join(opts.neutralDir, AGY_SESSION_LOG_FILENAME))
  ];
  const modelFlag = modelOverrideFlag(opts); // agy accepts --model
  if (modelFlag) parts.push(modelFlag);
  return parts.join(" ");
}

/**
 * Resolve the persona file the CLI is pointed at. When `personaText` is supplied
 * (the cli-runner RPC path), write it under the server-derived neutral dir `0600`
 * and return that path (§4.1.1a). Otherwise (in-process host path) use the
 * manager-rendered `personaPath` unchanged.
 */
export async function resolvePersonaPath(io: TmuxIo, opts: EngineLaunchOpts): Promise<string> {
  if (opts.personaText === undefined) return opts.personaPath;
  await io.run("mkdir", ["-p", opts.neutralDir]);
  const path = join(opts.neutralDir, PERSONA_FILENAME);
  await io.writeFile(path, opts.personaText);
  // Persona text is not a secret, but keep the dir uniform `0600` files (§6.2).
  await io.run("chmod", ["600", path]);
  return path;
}

/**
 * Write Claude's full `--mcp-config` JSON (incl. the bearer header) to a `0600`
 * file so the token never appears on the launch line / argv / capture-pane (§6.2).
 * Returns the file path the launch line references.
 */
async function writeClaudeMcpConfig(io: TmuxIo, opts: EngineLaunchOpts): Promise<string> {
  const path = join(opts.neutralDir, CLAUDE_MCP_FILENAME);
  const mcpConfig = JSON.stringify({
    mcpServers: {
      jarvis: {
        type: "http",
        url: opts.mcpServerUrl,
        headers: { Authorization: `Bearer ${opts.mcpToken}` },
        timeout: 180000
      }
    }
  });
  await io.writeFile(path, mcpConfig);
  const chmod = await io.run("chmod", ["600", path]);
  if (chmod.code !== 0) {
    await io.run("rm", ["-f", path]);
    throw new Error(`Could not lock down Claude MCP config file: ${chmod.stderr ?? ""}`.trim());
  }
  return path;
}

export async function writeGeminiSettings(io: TmuxIo, opts: EngineLaunchOpts): Promise<void> {
  const settingsDir = join(opts.neutralDir, ".gemini");
  await io.run("mkdir", ["-p", settingsDir]);
  const settings = {
    mcpServers: {
      jarvis: {
        httpUrl: opts.mcpServerUrl,
        headers: { Authorization: `Bearer ${opts.mcpToken}` },
        timeout: 180000
      }
    },
    tools: { core: [] as string[] },
    security: { disableYoloMode: true }
  };
  const path = join(settingsDir, "settings.json");
  await io.writeFile(path, JSON.stringify(settings, null, 2));
  // The settings file carries the Authorization header — lock it down `0600` (§6.5).
  // Symmetric with writeClaudeMcpConfig / writeCodexTokenEnv: if the chmod fails we
  // MUST NOT leave a world/group-readable token file behind. rm -f it and throw so the
  // failure routes through launch()'s removeNeutralDirQuietly cleanup (§6.5) — a failed
  // lockdown never leaves a readable Bearer token on disk.
  const chmod = await io.run("chmod", ["600", path]);
  if (chmod.code !== 0) {
    await io.run("rm", ["-f", path]);
    throw new Error(`Could not lock down Gemini settings file: ${chmod.stderr ?? ""}`.trim());
  }
}

export async function writeCodexTokenEnv(
  io: TmuxIo,
  opts: EngineLaunchOpts
): Promise<string | null> {
  if (!opts.mcpToken) return null;
  const path = join(opts.neutralDir, ".jarvis-mcp-token.env");
  await io.writeFile(
    path,
    `JARVIS_MCP_TOKEN=${shellQuote(opts.mcpToken)}\nexport JARVIS_MCP_TOKEN\n`
  );
  const chmod = await io.run("chmod", ["600", path]);
  if (chmod.code !== 0) {
    await io.run("rm", ["-f", path]);
    throw new Error(`Could not lock down Codex MCP token file: ${chmod.stderr ?? ""}`.trim());
  }
  return path;
}
