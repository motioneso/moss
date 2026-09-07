/**
 * Permission policy for the agent's own built-in tools (#2380, spec 6.4).
 *
 * Pure function of the permission request plus the session working folder: no
 * database, no filesystem. Identity comes only from the real tool name the
 * adapter carries in `toolCall._meta`, written by adapter platform code around
 * its own `canUseTool` call — never from the display title, which is
 * model-written and untrusted. A request with no name, or a name outside the
 * explicit lists, is refused without asking anyone. Named read-only tools
 * allow; named writes inside the session folder allow as ordinary use, outside
 * it ask a person through the shared approval card; shell, subagent, and mode
 * changes always ask. The card itself lives in the gateway — this module only
 * decides. Nothing here ever sees file contents.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse
} from "@agentclientprotocol/sdk";

export type AcpPermissionVerdict = "allow" | "ask" | "deny";

export interface AcpBuiltInRequest {
  readonly sessionId: string;
  readonly toolCallId: string;
  /** Display text only. Passed through for the card; never decides. */
  readonly title: string;
  readonly rawInput: unknown;
  /** Real tool name from adapter platform code, or null when absent. */
  readonly toolName: string | null;
}

/** Prefix the adapter puts on its own file and shell tool names. */
const ACP_TOOL_PREFIX = "mcp__acp__";

function withPrefixed(names: readonly string[]): Set<string> {
  return new Set([...names, ...names.map((name) => `${ACP_TOOL_PREFIX}${name}`)]);
}

/** Named tools that only observe: reads, listings, searches, plans. */
export const ACP_READ_TOOL_NAMES: ReadonlySet<string> = withPrefixed([
  "Read",
  "NotebookRead",
  "LS",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "BashOutput"
]);
/** Named tools that change files: allowed only inside the session folder. */
export const ACP_WRITE_TOOL_NAMES: ReadonlySet<string> = withPrefixed([
  "Edit",
  "Write",
  "NotebookEdit"
]);
/** Named tools that always need a person, even inside the session folder. */
export const ACP_ASK_TOOL_NAMES: ReadonlySet<string> = withPrefixed([
  "Bash",
  "KillShell",
  "ExitPlanMode",
  "Task"
]);
/** Named tools whose card shows the destructive seriousness. */
export const ACP_DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = withPrefixed([
  "Bash",
  "KillShell",
  "Task"
]);
/** Raw-input fields that name a file the tool touches. */
export const ACP_PATH_INPUT_KEYS: readonly string[] = ["file_path", "notebook_path", "path"];

/** Real tool name from adapter platform code, or null when absent or forged. */
export function toolNameFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const name = (meta as Record<string, unknown>).toolName;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/** Every file path the request names, from the known tool input fields. */
export function extractAcpPaths(request: AcpBuiltInRequest): string[] {
  const paths: string[] = [];
  const input = request.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ACP_PATH_INPUT_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") paths.push(value);
    }
  }
  return paths;
}

/** Lexical containment only: no filesystem access, so links are not resolved. */
export function isInsideSessionFolder(cwd: string, target: string): boolean {
  if (target.trim() === "") return false;
  const root = resolve(cwd);
  const candidate = resolve(root, target);
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function classifyEdit(paths: string[], cwd: string): AcpPermissionVerdict {
  if (paths.length === 0) return "ask";
  return paths.every((path) => isInsideSessionFolder(cwd, path)) ? "allow" : "ask";
}

export function classifyAcpPermission(
  request: AcpBuiltInRequest,
  cwd: string
): AcpPermissionVerdict {
  const toolName = request.toolName;
  // No name means the request carries only model-written text: unrecognised,
  // so refused. This is the design default, and it is what stops a subagent
  // titled like a harmless read from walking in with no card.
  if (toolName === null) return "deny";
  if (ACP_READ_TOOL_NAMES.has(toolName)) return "allow";
  if (ACP_WRITE_TOOL_NAMES.has(toolName)) return classifyEdit(extractAcpPaths(request), cwd);
  if (ACP_ASK_TOOL_NAMES.has(toolName)) return "ask";
  return "deny";
}

/** Least-privilege allow choice: single-use first, never a standing grant. */
export function selectAllowOptionId(options: readonly PermissionOption[]): string | null {
  const once = options.find((option) => option.kind === "allow_once");
  if (once) return once.optionId;
  return options.find((option) => option.kind.startsWith("allow"))?.optionId ?? null;
}

function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

/**
 * Answer one permission request. `ask` runs only when the policy needs a
 * person — the gateway wires it to the shared approval card; any other caller
 * decides how to reach someone.
 */
export async function decideAcpPermission(
  request: RequestPermissionRequest,
  cwd: string,
  ask: (builtIn: AcpBuiltInRequest) => Promise<"allow" | "deny">
): Promise<RequestPermissionResponse> {
  const builtIn: AcpBuiltInRequest = {
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    title: request.toolCall.title ?? "",
    rawInput: request.toolCall.rawInput,
    toolName: toolNameFromMeta(request.toolCall._meta)
  };
  const verdict = classifyAcpPermission(builtIn, cwd);
  if (verdict === "deny") return cancelled();
  if (verdict === "ask" && (await ask(builtIn)) !== "allow") return cancelled();
  const optionId = selectAllowOptionId(request.options);
  if (optionId === null) return cancelled();
  return { outcome: { outcome: "selected", optionId } };
}
