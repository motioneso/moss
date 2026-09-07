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

import type { PermissionOption, ToolCallLocation } from "@agentclientprotocol/sdk";

export type AcpPermissionVerdict = "allow" | "ask" | "deny";

export interface AcpBuiltInRequest {
  readonly sessionId: string;
  readonly toolCallId: string;
  /** Display text only. Passed through for the card; never decides. */
  readonly title: string;
  readonly rawInput: unknown;
  /**
   * Real tool name, learned from the agent's own announcement and matched by
   * tool call id — never from the title. Null when no announcement arrived.
   */
  readonly toolName: string | null;
  /** Announced kind, carried for the record only; never decides. */
  readonly kind: string | null;
  /** Announced file locations, used only to scope named writes. */
  readonly locations: readonly ToolCallLocation[] | null;
}

import { acpToolNamesIn, lookupAcpToolFamily } from "./tool-table.js";

/** Named tools whose card shows the destructive seriousness. */
export const ACP_DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...acpToolNamesIn("shell"),
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

/**
 * Every file path the request names: the announced locations plus the known
 * tool input fields. Both come from adapter platform code around the same
 * tool call; neither decides identity, only scope.
 */
export function extractAcpPaths(request: AcpBuiltInRequest): string[] {
  const paths: string[] = [];
  for (const location of request.locations ?? []) {
    if (typeof location?.path === "string" && location.path.trim() !== "") {
      paths.push(location.path);
    }
  }
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
  const family = lookupAcpToolFamily(toolName);
  if (family === "read" || family === "web" || family === "harmless") return "allow";
  if (family === "write") return classifyEdit(extractAcpPaths(request), cwd);
  if (family === "shell") return "ask";
  return "deny";
}

/** Least-privilege allow choice: single-use first, never a standing grant. */
export function selectAllowOptionId(options: readonly PermissionOption[]): string | null {
  const once = options.find((option) => option.kind === "allow_once");
  if (once) return once.optionId;
  return options.find((option) => option.kind.startsWith("allow"))?.optionId ?? null;
}

/**
 * Answer one announced tool ask with allow or deny. `ask` runs only when the
 * policy needs a person — the gateway wires it to the shared approval card;
 * any other caller decides how to reach someone. The client translates the
 * verdict into the protocol answer.
 */
export async function decideAcpPermission(
  builtIn: AcpBuiltInRequest,
  cwd: string,
  ask: (builtIn: AcpBuiltInRequest) => Promise<"allow" | "deny">
): Promise<"allow" | "deny"> {
  const verdict = classifyAcpPermission(builtIn, cwd);
  if (verdict === "deny") return "deny";
  if (verdict === "ask") return ask(builtIn);
  return "allow";
}
