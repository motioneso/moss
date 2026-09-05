import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliChatUnavailableError } from "./errors.js";

export const SOURCE_CLI_OUTPUT_BYTES = 65_536;
export const SOURCE_CLI_TIMEOUT_MS = 120_000;

/** Only the trusted runner supplies the credential path; it never crosses the source RPC. */
export async function createClaudeSourceLaunch(
  input: { model?: string; schema: Record<string, unknown>; personaText?: string },
  credentialFile?: string
) {
  if (!credentialFile || !input.model || input.model === "default") {
    throw new CliChatUnavailableError(
      "Source generation requires a configured model and credential"
    );
  }
  let credential: string;
  try {
    credential = (await readFile(credentialFile, "utf8")).trim();
  } catch {
    throw new CliChatUnavailableError("Source generation credential is unavailable");
  }
  if (!credential) throw new CliChatUnavailableError("Source generation credential is unavailable");
  const home = await mkdtemp(join(tmpdir(), "moss-source-claude-"));
  try {
    await mkdir(join(home, "config"), { mode: 0o700 });
    return {
      executable: process.env.JARVIS_CLI_TOOLS_PREFIX
        ? join(process.env.JARVIS_CLI_TOOLS_PREFIX, "bin/claude")
        : "claude",
      cwd: home,
      args: [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--settings",
        '{"disableAllHooks":true,"autoMemoryEnabled":false}',
        "--system-prompt",
        input.personaText ?? "Produce source data only. Use no tools.",
        "--model",
        input.model,
        "--json-schema",
        JSON.stringify(input.schema)
      ],
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "config"),
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN: credential,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
      },
      encodePrompt(text: string): string {
        return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
      },
      readResult(output: string): string {
        const result = readClaudeSourceResult(output, input.model!);
        if (
          output.includes(credential) ||
          result.includes(JSON.stringify(credential).slice(1, -1))
        ) {
          throw new CliChatUnavailableError("Source generation returned protected data");
        }
        return result;
      },
      dispose: () => rm(home, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

/** A provider's ordinary text or completion claim cannot stand in for verified source output. */
function readClaudeSourceResult(output: string, model: string): string {
  try {
    const records = output
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const init = records.filter((record) => record.type === "system" && record.subtype === "init");
    if (
      init.length !== 1 ||
      init[0].model !== model ||
      !Array.isArray(init[0].mcp_servers) ||
      init[0].mcp_servers.length !== 0 ||
      !Array.isArray(init[0].tools) ||
      init[0].tools.some((tool: unknown) => tool !== "StructuredOutput")
    ) {
      throw new Error("Unexpected provider authority");
    }
    for (const record of records) {
      for (const block of record.message?.content ?? []) {
        if (block.type === "tool_use" && block.name !== "StructuredOutput") {
          throw new Error("Unexpected tool call");
        }
      }
    }
    const results = records.filter((record) => record.type === "result");
    if (
      results.length !== 1 ||
      results[0].subtype !== "success" ||
      results[0].is_error !== false ||
      typeof results[0].structured_output !== "object" ||
      results[0].structured_output === null ||
      Array.isArray(results[0].structured_output)
    ) {
      throw new Error("Missing structured completion");
    }
    return JSON.stringify(results[0].structured_output);
  } catch {
    // Never include raw provider content, parser messages or credential material in diagnostics.
    throw new CliChatUnavailableError("Source generation response failed policy validation");
  }
}
