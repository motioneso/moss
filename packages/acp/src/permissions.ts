/**
 * Permission policy for the agent's own built-in tools (#2380, spec 6.4).
 *
 * Pure function of the permission request plus the session folders: no
 * database, no filesystem. Identity comes only from the real tool name the
 * adapter carries in the tool-call announcement's `_meta`, matched to the
 * question by tool call id — never from the display title, which is
 * model-written and untrusted. The rule, by family from the tool table:
 *
 * - no name, or a name outside the table: refuse, nobody is asked;
 * - mode changes and tools never offered (subagents, skills): refuse;
 * - Moss's own tools: allow, the tool server's gateway decides the real call;
 * - reads: inside the session folder allow, except secret-shaped names which
 *   ask; the forbidden zone (the agent's home, /proc, /sys, /dev, /run)
 *   refuses with no card; anywhere else asks with the path on the card;
 * - web: fetches allow, except loopback, private ranges and bare hostnames,
 *   which ask; search allows;
 * - writes: inside the folder allow, forbidden zone refuses, elsewhere asks;
 * - shell: always asks.
 *
 * The card itself lives in the gateway — this module only decides. Nothing
 * here ever sees file contents. Containment is lexical: a link inside the
 * folder that points at a secret passes (spec section 4, known limits).
 */

import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { PermissionOption, ToolCallLocation } from "@agentclientprotocol/sdk";

import { acpToolNamesIn, lookupAcpToolFamily, type AcpToolFamily } from "./tool-table.js";

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
  /** Announced file locations, used only to scope named reads and writes. */
  readonly locations: readonly ToolCallLocation[] | null;
}

/** Named tools whose card shows the destructive seriousness. */
export const ACP_DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = acpToolNamesIn("shell");
/** Raw-input fields that name a file the tool touches. */
export const ACP_PATH_INPUT_KEYS: readonly string[] = ["file_path", "notebook_path", "path"];

/** Real tool name from adapter platform code, or null when absent or forged. */
export function toolNameFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const name = (meta as Record<string, unknown>).toolName;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/**
 * Every file path the request names, once each: the announced locations plus
 * the known tool input fields (the adapter builds the former from the latter,
 * so the same path usually arrives twice). Both come from adapter platform
 * code around the same tool call; neither decides identity, only scope.
 */
export function extractAcpPaths(request: AcpBuiltInRequest): string[] {
  const paths = new Set<string>();
  for (const location of request.locations ?? []) {
    if (typeof location?.path === "string" && location.path.trim() !== "") {
      paths.add(location.path);
    }
  }
  const input = request.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const key of ACP_PATH_INPUT_KEYS) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim() !== "") paths.add(value);
    }
  }
  return [...paths];
}

/** The shell command a request names, for the card only; never stored. */
export function extractAcpCommand(request: AcpBuiltInRequest): string | null {
  const input = request.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() !== "" ? command : null;
}

/** The web address a request names, or null when it names none. */
export function extractAcpWebAddress(request: AcpBuiltInRequest): string | null {
  const input = request.rawInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const url = (input as Record<string, unknown>).url;
  return typeof url === "string" && url.trim() !== "" ? url : null;
}

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Lexical containment only: no filesystem access, so links are not resolved. */
export function isInsideSessionFolder(cwd: string, target: string): boolean {
  if (target.trim() === "") return false;
  const root = resolve(cwd);
  return isUnder(root, resolve(root, target));
}

/**
 * The forbidden zone: the agent's home subtree (token store, the coding
 * CLI's own config, any other provider's login) plus the system pseudofolders
 * where the process environment is readable. The session folder is checked
 * first by the caller so it always wins, even nested inside home.
 */
const FORBIDDEN_PREFIXES = ["/proc", "/sys", "/dev", "/run"];

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

type PathZone = "none" | "inside" | "inside-secret" | "outside" | "forbidden";

/**
 * The worst zone among every named path decides: forbidden beats outside,
 * outside beats a secret-shaped name inside, which beats plain inside. A
 * request naming several files is judged by its most sensitive one.
 */
function classifyZone(paths: readonly string[], folders: AcpSessionFolders): PathZone {
  const named = paths.filter((target) => target.trim() !== "");
  if (named.length === 0) return "none";
  const root = resolve(folders.cwd);
  let worst: PathZone = "inside";
  for (const target of named) {
    const absolute = resolve(root, target);
    if (!isUnder(root, absolute)) {
      if (inForbiddenZone(absolute, folders.home)) return "forbidden";
      worst = "outside";
    } else if (worst === "inside" && isSecretShaped(absolute)) {
      worst = "inside-secret";
    }
  }
  return worst;
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
  // sees the path on the card and decides.
  return { verdict: "ask" };
}

function classifyWrite(paths: readonly string[], folders: AcpSessionFolders): AcpDecision {
  const zone = classifyZone(paths, folders);
  if (zone === "forbidden") return { verdict: "deny", reason: "forbidden_zone" };
  if (zone === "inside") return { verdict: "allow" };
  return { verdict: "ask" };
}

/**
 * Loopback, private ranges, link-local and bare hostnames reach things the
 * model provider cannot, so they fetch through a person. Public addresses
 * fetch silently: what could leave is the project's own content, which the
 * provider already sees on every turn.
 */
export function isPrivateWebAddress(address: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(address).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname === "" || hostname === "localhost") return true;
  if (hostname.includes(":")) {
    // An IPv6 literal: loopback, unique-local (fc00::/7) and link-local.
    return (
      hostname === "::1" ||
      hostname === "::" ||
      /^f[cd]/.test(hostname) ||
      /^fe[89ab]/.test(hostname)
    );
  }
  if (/^(127|10|0)\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  const m172 = /^172\.(\d+)\./.exec(hostname);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // A bare name with no dot resolves only on the local network.
  return !hostname.includes(".");
}

function classifyWeb(toolName: string, request: AcpBuiltInRequest): AcpDecision {
  if (toolName === "WebSearch") return { verdict: "allow" };
  const address = extractAcpWebAddress(request);
  if (address === null) return { verdict: "deny", reason: "malformed" };
  return isPrivateWebAddress(address) ? { verdict: "ask" } : { verdict: "allow" };
}

/** Family of the request's real name, "unknown" when it has none. */
export function acpRequestFamily(request: AcpBuiltInRequest): AcpToolFamily | "unknown" {
  return request.toolName === null ? "unknown" : lookupAcpToolFamily(request.toolName);
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
  switch (family) {
    case "unknown":
      return { verdict: "deny", reason: "unknown_tool" };
    case "mode":
    case "not-offered":
      return { verdict: "deny", reason: "not_offered" };
    case "moss":
    case "harmless":
      return { verdict: "allow" };
    case "shell":
      return { verdict: "ask" };
    case "write":
      return classifyWrite(extractAcpPaths(request), folders);
    case "web":
      return classifyWeb(toolName, request);
    case "read":
      return classifyRead(toolName, extractAcpPaths(request), folders);
  }
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
