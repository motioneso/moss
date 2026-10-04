import { sanitizeToolName, type DiscoveredTool } from "./openapi-convert.js";

/**
 * The free rule that gives a connected tool a readable name at once (spec 8.2, #2984).
 *
 * The name is for display only. The raw name stays the tool's identity. The sorting pass later
 * replaces this name with a model-written one. The rule splits the words, drops a prefix the
 * connection's tools share, and writes the result in sentence case.
 */

export const READABLE_NAME_MAX_CHARS = 80;

/** The verb a web-service tool named after its route starts with. */
const METHOD_VERBS: Readonly<Record<string, string>> = {
  GET: "Look up",
  POST: "Create",
  PUT: "Update",
  PATCH: "Update",
  DELETE: "Delete"
};

/** Leading words that say what a tool does. A shared verb is never dropped as a prefix. */
const VERBS = new Set([
  "add",
  "cancel",
  "check",
  "close",
  "confirm",
  "continue",
  "create",
  "delete",
  "disable",
  "enable",
  "fetch",
  "find",
  "finish",
  "get",
  "list",
  "mark",
  "open",
  "play",
  "post",
  "put",
  "query",
  "read",
  "remove",
  "resolve",
  "run",
  "save",
  "search",
  "send",
  "set",
  "show",
  "start",
  "stop",
  "store",
  "toggle",
  "turn",
  "update",
  "write"
]);

/** A share of the tools at or above this marks a glued leading word as a prefix. */
const GLUED_PREFIX_SHARE = 0.25;

interface NameParts {
  /** Words that may lose a shared prefix. */
  readonly words: string[];
  /** A web-service verb that leads the name and is never dropped. */
  readonly verb: string | null;
  /** True when the words came from a route, so route prefixes are compared only among routes. */
  readonly fromRoute: boolean;
}

function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((word) => word !== "");
}

/** True when the tool's name was generated from its method and route, not an operationId. */
function namedFromRoute(tool: DiscoveredTool): boolean {
  if (!tool.invoke) return false;
  const generated = sanitizeToolName(`${tool.invoke.method.toLowerCase()}${tool.invoke.path}`);
  return tool.name === generated || new RegExp(`^${generated}_\\d+$`).test(tool.name);
}

function nameParts(tool: DiscoveredTool): NameParts {
  if (tool.invoke && namedFromRoute(tool)) {
    const words = tool.invoke.path
      .split("/")
      .filter((segment) => segment !== "" && !/^\{.*\}$/.test(segment))
      .flatMap(splitWords);
    return { words, verb: METHOD_VERBS[tool.invoke.method.toUpperCase()] ?? null, fromRoute: true };
  }

  // A double underscore namespaces a tool, as in `intent_script__AddTaskWork`.
  const namespaced = tool.name.lastIndexOf("__");
  const local = namespaced > 0 ? tool.name.slice(namespaced + 2) : tool.name;
  return { words: splitWords(local || tool.name), verb: null, fromRoute: false };
}

function leading(parts: NameParts): string | undefined {
  return parts.words.length > 1 ? parts.words[0]!.toLowerCase() : undefined;
}

/**
 * Drop leading words every tool in the set shares, as in a route's `api/v3`. With `keepVerbs`
 * the drop stops at an action word, so `AddTask` and `AddShow` keep their `Add`.
 */
function dropCommonPrefix(set: NameParts[], keepVerbs: boolean): void {
  if (set.length < 2) return;
  for (;;) {
    const first = leading(set[0]!);
    if (first === undefined || !set.every((parts) => leading(parts) === first)) return;
    if (keepVerbs && VERBS.has(first)) return;
    for (const parts of set) parts.words.shift();
  }
}

/**
 * Drop one glued leading word a good share of the tools carry, as in Home Assistant's `Hass`.
 * Verbs stay, so `AddTask` and `AddShow` keep their `Add`.
 */
function dropGluedPrefix(set: NameParts[]): void {
  const counts = new Map<string, number>();
  for (const parts of set) {
    const first = leading(parts);
    if (first !== undefined && !VERBS.has(first)) counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] < 2 || best[1] < set.length * GLUED_PREFIX_SHARE) return;
  for (const parts of set) if (leading(parts) === best[0]) parts.words.shift();
}

function sentenceCase(words: readonly string[]): string {
  const text = words.join(" ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Readable names for every tool on one connection, keyed by raw tool name. */
export function readableToolNames(tools: readonly DiscoveredTool[]): Map<string, string> {
  const parts = tools.map(nameParts);
  const routes = parts.filter((entry) => entry.fromRoute);
  const named = parts.filter((entry) => !entry.fromRoute);
  dropCommonPrefix(routes, false);
  dropCommonPrefix(named, true);
  dropGluedPrefix(named);

  const out = new Map<string, string>();
  tools.forEach((tool, index) => {
    const { words, verb } = parts[index]!;
    const body = sentenceCase(words);
    const name = verb ? `${verb}${body ? ` ${body.toLowerCase()}` : ""}` : body;
    out.set(tool.name, (name || tool.name).slice(0, READABLE_NAME_MAX_CHARS));
  });
  return out;
}
