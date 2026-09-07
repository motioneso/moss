/**
 * Permission policy for the agent's own built-in tools (#2380, spec 6.4).
 *
 * Pure function of the permission request plus the session working folder: no
 * database, no filesystem. Read-only built-ins allow; writes inside the session
 * folder allow as ordinary use; destructive tools, or anything outside that
 * folder, ask a person through the shared approval card; anything unrecognised
 * is refused. The card itself lives in the gateway — this module only decides.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallLocation,
  ToolKind
} from "@agentclientprotocol/sdk";

export type AcpPermissionVerdict = "allow" | "ask" | "deny";

export interface AcpBuiltInRequest {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly rawInput: unknown;
  readonly kind?: ToolKind | null;
  readonly locations?: readonly ToolCallLocation[] | null;
}

/** Kinds that only observe: search results, file reads, fetched pages, plans. */
export const ACP_READ_ONLY_KINDS: readonly ToolKind[] = ["read", "search", "fetch", "think"];
/** Kinds that change files: allowed only inside the session folder. */
export const ACP_WRITE_KINDS: readonly ToolKind[] = ["edit"];
/** Kinds that always need a person, even inside the session folder. */
export const ACP_ASK_KINDS: readonly ToolKind[] = ["delete", "move", "execute", "switch_mode"];
/** Raw-input fields that name a file the tool touches. */
export const ACP_PATH_INPUT_KEYS: readonly string[] = ["file_path", "notebook_path", "path"];
/** Raw-input field that names a shell command to run. */
const COMMAND_INPUT_KEY = "command";

/**
 * Recover the built-in tool name from the adapter's title. The adapter sends no
 * tool name in permission requests, only the display title it derives from the
 * tool and its input — this table mirrors that derivation. Null means unknown,
 * which refuses rather than guesses.
 */
export function inferAcpToolName(title: string): string | null {
  if (title.startsWith("Read ") || title === "Read File") return "Read";
  if (title.startsWith("List the")) return "LS";
  if (title.startsWith("Find")) return "Glob";
  if (title.startsWith("grep")) return "Grep";
  if (title.startsWith("Fetch ")) return "WebFetch";
  if (title.startsWith('"')) return "WebSearch";
  if (title.startsWith("Update TODOs")) return "TodoWrite";
  if (title === "Tail Logs") return "BashOutput";
  if (title === "Kill Process") return "KillShell";
  if (title.startsWith("Write ")) return "Write";
  if (title.startsWith("Edit ")) return "Edit";
  if (title === "Ready to code?") return "ExitPlanMode";
  if (title.startsWith("`") && title.endsWith("`") && title.length > 1) return "Bash";
  return null;
}

const READ_ONLY_TOOL_NAMES = new Set([
  "Read",
  "LS",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "BashOutput"
]);
const WRITE_TOOL_NAMES = new Set(["Write", "Edit"]);
const ASK_TOOL_NAMES = new Set(["Bash", "KillShell", "ExitPlanMode"]);

function rawInputRecord(rawInput: unknown): Record<string, unknown> | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  return rawInput as Record<string, unknown>;
}

/** Every file path the request names, from locations plus known input fields. */
export function extractAcpPaths(request: AcpBuiltInRequest): string[] {
  const paths: string[] = [];
  for (const location of request.locations ?? []) {
    if (typeof location?.path === "string" && location.path.trim() !== "") {
      paths.push(location.path);
    }
  }
  const input = rawInputRecord(request.rawInput);
  if (input) {
    for (const key of ACP_PATH_INPUT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") paths.push(value);
    }
  }
  return paths;
}

function hasCommandInput(rawInput: unknown): boolean {
  const value = rawInputRecord(rawInput)?.[COMMAND_INPUT_KEY];
  return typeof value === "string" && value.trim() !== "";
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

function classifyByName(toolName: string | null, request: AcpBuiltInRequest, cwd: string): AcpPermissionVerdict {
  if (toolName === null) return "deny";
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return "allow";
  if (WRITE_TOOL_NAMES.has(toolName)) return classifyEdit(extractAcpPaths(request), cwd);
  if (ASK_TOOL_NAMES.has(toolName)) return "ask";
  return "deny";
}

export function classifyAcpPermission(
  request: AcpBuiltInRequest,
  cwd: string
): AcpPermissionVerdict {
  const kind = request.kind ?? null;
  if (kind !== null) {
    if ((ACP_READ_ONLY_KINDS as readonly string[]).includes(kind)) return "allow";
    if ((ACP_WRITE_KINDS as readonly string[]).includes(kind)) {
      return classifyEdit(extractAcpPaths(request), cwd);
    }
    if ((ACP_ASK_KINDS as readonly string[]).includes(kind)) return "ask";
    return "deny";
  }
  // The adapter omits kind on permission requests: a shell command always asks,
  // otherwise the title recovers the tool name through the explicit table.
  if (hasCommandInput(request.rawInput)) return "ask";
  return classifyByName(inferAcpToolName(request.title), request, cwd);
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
 * person — the gateway wires it to the shared approval card in phase 4; any
 * other caller decides how to reach someone.
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
    kind: request.toolCall.kind ?? undefined,
    locations: request.toolCall.locations ?? undefined
  };
  const verdict = classifyAcpPermission(builtIn, cwd);
  if (verdict === "deny") return cancelled();
  if (verdict === "ask" && (await ask(builtIn)) !== "allow") return cancelled();
  const optionId = selectAllowOptionId(request.options);
  if (optionId === null) return cancelled();
  return { outcome: { outcome: "selected", optionId } };
}
