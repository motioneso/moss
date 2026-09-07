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

import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { PermissionOption, ToolCallLocation } from "@agentclientprotocol/sdk";

export type AcpPermissionVerdict = "allow" | "ask" | "deny";

/** Why a tool ask was refused without reaching a person. */
export type AcpDenyReason = "unknown_tool" | "not_offered" | "forbidden_zone" | "malformed";

export type AcpDecision =
  | { readonly verdict: "allow" }
  | { readonly verdict: "ask" }
  | { readonly verdict: "deny"; readonly reason: AcpDenyReason };

/** The two folders every filesystem decision needs. */
export interface AcpSessionFolders {
  readonly cwd: string;
  readonly home: string | null;
}

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

/**
 * Zones, lexical only. The forbidden zone is the agent's home subtree plus
 * the system pseudofolders; the session folder is checked first so it always
 * wins, even nested inside home. Links are not resolved — the runner's owned
 * directories plus the launch deny list contain escape the other way.
 */
const FORBIDDEN_PREFIXES = ["/proc", "/sys", "/dev", "/run"];

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function inForbiddenZone(absolute: string, home: string | null): boolean {
  if (home && home.trim() !== "" && isUnder(resolve(home), absolute)) return true;
  return FORBIDDEN_PREFIXES.some(
    (prefix) => absolute === prefix || absolute.startsWith(`${prefix}${sep}`)
  );
}

/** Basenames that smell like secrets: keys, tokens, login state. */
function isSecretShaped(absolute: string): boolean {
  const base = basename(absolute);
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.endsWith(".p12") ||
    base.startsWith("id_rsa") ||
    base === ".npmrc" ||
    base === ".netrc"
  );
}

type PathZone = "none" | "inside" | "outside" | "outside-secret" | "forbidden";

function classifyZone(paths: readonly string[], folders: AcpSessionFolders): PathZone {
  const named = paths.filter((target) => target.trim() !== "");
  if (named.length === 0) return "none";
  const root = resolve(folders.cwd);
  let seenOutside = false;
  for (const target of named) {
    const absolute = resolve(root, target);
    if (inForbiddenZone(absolute, folders.home)) return "forbidden";
    if (!isUnder(root, absolute)) {
      seenOutside = true;
      continue;
    }
    if (isSecretShaped(absolute)) return "outside-secret";
  }
  return seenOutside ? "outside" : "inside";
}

/** Reads that name a file must name one; the rest read a default place. */
const READ_NEEDS_TARGET = new Set(["Read", "mcp__acp__Read", "NotebookRead"]);

function classifyRead(
  toolName: string,
  paths: readonly string[],
  folders: AcpSessionFolders
): AcpDecision {
  const zone = classifyZone(paths, folders);
  if (zone === "forbidden") return { verdict: "deny", reason: "forbidden_zone" };
  if (zone === "none") {
    return READ_NEEDS_TARGET.has(toolName)
      ? { verdict: "deny", reason: "malformed" }
      : { verdict: "allow" };
  }
  if (zone === "inside") return { verdict: "allow" };
  // Outside the folder but not forbidden, or secret-shaped inside: a person
  // sees the address on the card and decides.
  return { verdict: "ask" };
}

function classifyWrite(paths: readonly string[], folders: AcpSessionFolders): AcpDecision {
  if (paths.length === 0) return { verdict: "ask" };
  const zone = classifyZone(paths, folders);
  if (zone === "forbidden") return { verdict: "deny", reason: "forbidden_zone" };
  if (zone === "inside") return { verdict: "allow" };
  return { verdict: "ask" };
}

/** Loopback, private ranges, and bare hostnames fetch through a person. */
function isPrivateWebAddress(address: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(address).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "localhost" || hostname === "::1") return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  const m172 = /^172\.(\d+)\./.exec(hostname);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  if (!hostname.includes(".") && !hostname.includes(":")) return true;
  return false;
}

function webAddress(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const url = (rawInput as Record<string, unknown>).url;
  return typeof url === "string" && url.trim() !== "" ? url : null;
}

export function classifyAcpPermission(
  request: AcpBuiltInRequest,
  folders: AcpSessionFolders
): AcpDecision {
  const toolName = request.toolName;
  // No name means the request carries only model-written text: unrecognised,
  // so refused. This is the design default, and it is what stops a subagent
  // titled like a harmless read from walking in with no card.
  if (toolName === null) return { verdict: "deny", reason: "unknown_tool" };
  const family = lookupAcpToolFamily(toolName);
  if (family === "unknown") return { verdict: "deny", reason: "unknown_tool" };
  if (family === "mode" || family === "not-offered") {
    return { verdict: "deny", reason: "not_offered" };
  }
  if (family === "moss") return { verdict: "allow" };
  if (family === "shell") return { verdict: "ask" };
  if (family === "write") return classifyWrite(extractAcpPaths(request), folders);
  if (family === "web" && (toolName === "WebFetch" || toolName === "WebSearch")) {
    if (toolName === "WebSearch") return { verdict: "allow" };
    const address = webAddress(request.rawInput);
    if (address === null) return { verdict: "deny", reason: "malformed" };
    try {
      new URL(address);
    } catch {
      return { verdict: "ask" };
    }
    return isPrivateWebAddress(address) ? { verdict: "ask" } : { verdict: "allow" };
  }
  return classifyRead(toolName, extractAcpPaths(request), folders);
}

/** Least-privilege allow choice: single-use first, never a standing grant. */
export function selectAllowOptionId(options: readonly PermissionOption[]): string | null {
  const once = options.find((option) => option.kind === "allow_once");
  if (once) return once.optionId;
  return options.find((option) => option.kind.startsWith("allow"))?.optionId ?? null;
}

/** What the decider concluded and whether a person was consulted. */
export interface AcpDecisionResult {
  readonly decision: "allow" | "deny";
  readonly asked: boolean;
  readonly reason: AcpDenyReason | "denied_by_person" | null;
}

/**
 * Answer one announced tool ask. `ask` runs only when the policy needs a
 * person — the gateway wires it to the shared approval card; any other
 * caller decides how to reach someone. The client translates the decision
 * into the protocol answer.
 */
export async function decideAcpPermission(
  builtIn: AcpBuiltInRequest,
  folders: AcpSessionFolders,
  ask: (builtIn: AcpBuiltInRequest) => Promise<"allow" | "deny">
): Promise<AcpDecisionResult> {
  const decision = classifyAcpPermission(builtIn, folders);
  if (decision.verdict === "deny") {
    return { decision: "deny", asked: false, reason: decision.reason };
  }
  if (decision.verdict === "ask") {
    const answer = await ask(builtIn);
    return answer === "allow"
      ? { decision: "allow", asked: true, reason: null }
      : { decision: "deny", asked: true, reason: "denied_by_person" };
  }
  return { decision: "allow", asked: false, reason: null };
}
