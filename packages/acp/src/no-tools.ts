import { AcpCapabilityError } from "./capabilities.js";
import type { AcpProviderKind } from "./providers.js";

export const CLAUDE_NO_TOOLS_OPTIONS = {
  tools: [] as readonly string[],
  settingSources: [] as readonly string[],
  persistSession: false
} as const;

const CODEX_FEATURES_OFF = [
  "shell_tool",
  "view_image",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "hooks",
  "request_permissions_tool",
  "image_generation",
  "js_repl",
  "code_mode_host",
  "deferred_executor",
  "token_budget",
  "goals",
  "sleep_tool"
] as const;

export function codexNoToolsConfig(): string {
  return [
    'web_search = "disabled"',
    "project_doc_max_bytes = 0",
    "check_for_update_on_startup = false",
    "[history]",
    'persistence = "none"',
    "[tools.update_plan]",
    "enabled = false",
    "[tools.experimental_request_user_input]",
    "enabled = false",
    "[features]",
    ...CODEX_FEATURES_OFF.map((key) => `${key} = false`),
    ""
  ].join("\n");
}

export function assertClaudeNoToolsOptions(options: unknown): void {
  const value =
    options && typeof options === "object" && !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {};
  const tools = value.tools;
  const sources = value.settingSources;
  if (
    !Array.isArray(tools) ||
    tools.length !== 0 ||
    !Array.isArray(sources) ||
    sources.length !== 0 ||
    value.persistSession !== false
  ) {
    throw new AcpCapabilityError(
      "no-tools",
      "the Claude session options that close its tools were not accepted."
    );
  }
}

export function assertZeroToolsProof(input: {
  readonly providerKind: AcpProviderKind;
  readonly toolCallsSeen: number;
  readonly offeredTools?: readonly string[];
}): void {
  const offered = input.offeredTools ?? [];
  if (input.toolCallsSeen > 0 || offered.length > 0) {
    const names = offered.length > 0 ? offered.join(", ") : `${input.toolCallsSeen} tool call(s)`;
    throw new AcpCapabilityError(
      "no-tools",
      `the ${input.providerKind} agent offered tools under the no-tools profile (${names}), so the call was blocked.`
    );
  }
}
