import { join } from "node:path";

import type { TmuxIo } from "@moss/ai";

import { resolveVaultRoots } from "./vault-allowlist.js";

export const CLAUDE_PERMISSION_SETTINGS_FILENAME = ".jarvis-claude-settings.json";
export const CLAUDE_PERMISSION_HOOK_FILENAME = ".jarvis-claude-permission-hook.mjs";
export const CLAUDE_PERMISSION_TOKEN_FILENAME = ".jarvis-claude-permission-token";

// #1158 deadline ordering. The three deadlines around a native-tool confirmation MUST be
// strictly ordered so a user timeout/deny always returns to claude as a STRUCTURED decision
// (deny) and never as a fail-closed transport error (which claude treats as retryable,
// starving the transcript until the #456 idle watchdog kills the engine — the 2026-07-18
// prod outage, issue #1157):
//   server confirm window < hook internal deadline < Claude Code hook timeout
// routes.ts imports NATIVE_CONFIRM_TIMEOUT_MS so the server side cannot drift silently;
// tests/unit/claude-permission-hook.test.ts asserts the ordering.
export const NATIVE_CONFIRM_TIMEOUT_MS = 150_000;
export const HOOK_INTERNAL_DEADLINE_S = 170;
export const HOOK_TIMEOUT_SECONDS = 180;

export interface ClaudePermissionHookOpts {
  readonly neutralDir: string;
  readonly mcpToken: string;
  readonly mcpServerUrl: string;
}

export function deriveClaudePermissionUrl(mcpServerUrl: string): string {
  const url = new URL(mcpServerUrl);
  url.pathname = "/internal/permission";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function writeClaudePermissionHook(
  io: Pick<TmuxIo, "run" | "writeFile">,
  opts: ClaudePermissionHookOpts
): Promise<string> {
  await io.run("mkdir", ["-p", opts.neutralDir]);

  const settingsPath = join(opts.neutralDir, CLAUDE_PERMISSION_SETTINGS_FILENAME);
  const hookPath = join(opts.neutralDir, CLAUDE_PERMISSION_HOOK_FILENAME);
  const tokenPath = join(opts.neutralDir, CLAUDE_PERMISSION_TOKEN_FILENAME);
  const permissionUrl = deriveClaudePermissionUrl(opts.mcpServerUrl);
  const command = [
    // #1158: explicit deadline (was implicit 150s default == server confirm window → dead race).
    `JARVIS_PERM_DEADLINE_S=${HOOK_INTERNAL_DEADLINE_S}`,
    `JARVIS_PERM_URL=${shellQuote(permissionUrl)}`,
    `JARVIS_PERM_TOKEN_FILE=${shellQuote(tokenPath)}`,
    ...vaultRootsEnvEntry(),
    "node",
    shellQuote(hookPath)
  ].join(" ");

  const settings = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }]
          }
        ]
      }
    },
    null,
    2
  );

  await io.writeFile(tokenPath, `${opts.mcpToken}\n`);
  await io.writeFile(hookPath, CLAUDE_PERMISSION_HOOK_SOURCE);
  await io.writeFile(settingsPath, settings);

  for (const path of [tokenPath, hookPath, settingsPath]) {
    const chmod = await io.run("chmod", ["600", path]);
    if (chmod.code !== 0) {
      await io.run("rm", ["-f", tokenPath, hookPath, settingsPath]);
      throw new Error(
        `Could not lock down Claude permission hook file: ${chmod.stderr ?? ""}`.trim()
      );
    }
  }

  return settingsPath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** #1467: carry the app-validated vault roots to the spawned hook via its command line. */
function vaultRootsEnvEntry(): string[] {
  const roots = resolveVaultRoots();
  if (roots.length === 0) return [];
  return [`JARVIS_NOTES_ROOTS=${shellQuote(roots.join(","))}`];
}

export const CLAUDE_PERMISSION_HOOK_SOURCE = `import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const INTERNAL_DEADLINE_MS = Number(process.env.JARVIS_PERM_DEADLINE_S ?? "150") * 1000;
const GATEWAY = process.env.JARVIS_PERM_URL ?? "";
const TOKEN_FILE = process.env.JARVIS_PERM_TOKEN_FILE ?? "";
const ROOT_PATTERN = /^\\/[\\w.-][\\w./-]*$/;

process.on("uncaughtException", () => decide("deny", "hook exception"));
process.on("unhandledRejection", () => decide("deny", "hook exception"));

function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason
    }
  }));
  process.exit(0);
}

function validRoot(root) {
  if (root === "/" || !ROOT_PATTERN.test(root) || root.includes("..")) return false;
  if (root.length > 1 && root.endsWith("/")) return false;
  return path.posix.normalize(root) === root;
}

function roots() {
  return (process.env.JARVIS_NOTES_ROOTS ?? "")
    .split(",")
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .filter(validRoot);
}

function underRoot(candidate, root) {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\\0")) {
    return false;
  }
  const normalized = path.posix.normalize(candidate);
  return normalized === root || normalized.startsWith(root + "/");
}

function realpathOrUndefined(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

// Fail-closed symlink containment: lexical containment alone isn't enough — a symlink planted
// inside a root can point anywhere on disk while its own path string still reads as "under root".
// Resolve the real filesystem location of both root and candidate, walking up to the nearest
// EXISTING ancestor when the candidate itself doesn't exist yet (a Glob pattern, a not-yet-created
// file), and require the resolved candidate to still live under the resolved root. Anything that
// can't be resolved at all (root missing, permission error) fails closed: no pre-approval, falls
// through to the normal permission card.
function resolveExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    const real = realpathOrUndefined(current);
    if (real !== undefined) return real;
    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function realUnderRoot(candidate, root) {
  if (!underRoot(candidate, root)) return false;
  const rootReal = realpathOrUndefined(root);
  if (rootReal === undefined) return false;
  const candidateReal = resolveExistingAncestor(candidate);
  if (candidateReal === undefined) return false;
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + "/");
}

function readCandidate(tool, input) {
  if (tool === "Read") return input.file_path;
  if (tool === "Glob") return input.path ?? input.pattern;
  if (tool === "Grep") return input.path;
  return undefined;
}

function safeVaultRead(tool, input) {
  if (tool !== "Read" && tool !== "Glob" && tool !== "Grep") return false;
  const candidate = readCandidate(tool, input);
  return roots().some((root) => realUnderRoot(candidate, root));
}

function stdinText() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

function postPermission(payload, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(GATEWAY);
    const body = JSON.stringify(payload);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          authorization: "Bearer " + token
        }
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          clearTimeout(timer);
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error("http_" + (res.statusCode ?? 0)));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            reject(new Error("bad_json"));
          }
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, INTERNAL_DEADLINE_MS);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  let event;
  try {
    event = JSON.parse(await stdinText());
  } catch {
    decide("deny", "unparseable hook input");
  }

  const tool = typeof event?.tool_name === "string" ? event.tool_name : "?";
  const input =
    event?.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input)
      ? event.tool_input
      : {};

  if (safeVaultRead(tool, input)) {
    decide("allow", "pre-approved read-only vault path");
  }

  let token = "";
  try {
    token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    decide("deny", "missing session token");
  }
  if (!/^jst_[A-Za-z0-9-]+$/.test(token)) {
    decide("deny", "invalid session token");
  }

  let response;
  try {
    // #1085 F1: Claude supplies cwd on the real PreToolUse event. Forward it so the gateway can
    // enforce the F2/F3 workspace and config guards before native YOLO becomes reachable.
    response = await postPermission({ tool_name: tool, tool_input: input, cwd: event?.cwd }, token);
  } catch (error) {
    decide("deny", "gateway unreachable/timeout: " + error.constructor.name);
  }

  const allow = response?.decision === "allow";
  decide(allow ? "allow" : "deny", response?.reason || "user decision via action_request card");
}

void main();
`;

export interface ClaudeOneShotPermissionHookOpts {
  readonly neutralDir: string;
}

export async function writeClaudeOneShotPermissionHook(
  io: Pick<TmuxIo, "run" | "writeFile">,
  opts: ClaudeOneShotPermissionHookOpts
): Promise<string> {
  await io.run("mkdir", ["-p", opts.neutralDir]);

  const settingsPath = join(opts.neutralDir, CLAUDE_PERMISSION_SETTINGS_FILENAME);
  const hookPath = join(opts.neutralDir, CLAUDE_PERMISSION_HOOK_FILENAME);
  const command = [
    "JARVIS_SESSION_ROOT=" + shellQuote(opts.neutralDir),
    ...vaultRootsEnvEntry(),
    "node",
    shellQuote(hookPath)
  ].join(" ");
  const settings = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command }]
          }
        ]
      }
    },
    null,
    2
  );

  await io.writeFile(hookPath, CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE);
  await io.writeFile(settingsPath, settings);

  for (const path of [hookPath, settingsPath]) {
    const chmod = await io.run("chmod", ["600", path]);
    if (chmod.code !== 0) {
      await io.run("rm", ["-f", hookPath, settingsPath]);
      throw new Error(
        ("Could not lock down Claude one-shot permission hook file: " + (chmod.stderr ?? "")).trim()
      );
    }
  }

  return settingsPath;
}

export const CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE = `import fs from "node:fs";
import path from "node:path";

const ROOT_PATTERN = /^\\/[\\w.-][\\w./-]*$/;

// #1361: once an MCP server exposes enough tools, the CLI stops sending their schemas up front and
// instead advertises a built-in loader the model must call to pull in the ones it needs. Denying
// that loader denies every tool behind it — prod chat answered "tool access is restricted" while
// the gateway was healthy and each mcp__jarvis__ tool would have been allowed by name a moment
// later. These entries read schemas the server has already published to this very session: they
// move no user data and perform no action, so allowing them widens nothing the checks below do not
// already permit. Keep this list to pure discovery — anything that touches data belongs elsewhere.
const DISCOVERY_TOOLS = new Set(["ToolSearch"]);

function decide(permissionDecision, permissionDecisionReason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason
    }
  }));
  process.exit(0);
}

function validRoot(root) {
  if (root === "/" || !ROOT_PATTERN.test(root) || root.includes("..")) return false;
  if (root.length > 1 && root.endsWith("/")) return false;
  return path.posix.normalize(root) === root;
}

function roots() {
  return [process.env.JARVIS_SESSION_ROOT ?? "", ...vaultRoots()]
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .filter(validRoot);
}

function vaultRoots() {
  return (process.env.JARVIS_NOTES_ROOTS ?? "").split(",");
}

function underRoot(candidate, root) {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.includes("\\0")) {
    return false;
  }
  const normalized = path.posix.normalize(candidate);
  return normalized === root || normalized.startsWith(root + "/");
}

function realpathOrUndefined(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

// Fail-closed symlink containment: lexical containment alone isn't enough — a symlink planted
// inside a root can point anywhere on disk while its own path string still reads as "under root".
// Resolve the real filesystem location of both root and candidate, walking up to the nearest
// EXISTING ancestor when the candidate itself doesn't exist yet (a Glob pattern, a not-yet-created
// file), and require the resolved candidate to still live under the resolved root. Anything that
// can't be resolved at all (root missing, permission error) fails closed: no pre-approval.
function resolveExistingAncestor(candidate) {
  let current = candidate;
  while (true) {
    const real = realpathOrUndefined(current);
    if (real !== undefined) return real;
    const parent = path.posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function realUnderRoot(candidate, root) {
  if (!underRoot(candidate, root)) return false;
  const rootReal = realpathOrUndefined(root);
  if (rootReal === undefined) return false;
  const candidateReal = resolveExistingAncestor(candidate);
  if (candidateReal === undefined) return false;
  return candidateReal === rootReal || candidateReal.startsWith(rootReal + "/");
}

function readCandidate(tool, input) {
  if (tool === "Read") return input.file_path;
  if (tool === "Glob") return input.path ?? input.pattern;
  if (tool === "Grep") return input.path;
  return undefined;
}

function safeVaultRead(tool, input) {
  if (tool !== "Read" && tool !== "Glob" && tool !== "Grep") return false;
  const candidate = readCandidate(tool, input);
  return vaultRoots()
    .map((root) => root.trim())
    .filter((root) => root.length > 0)
    .filter(validRoot)
    .some((root) => realUnderRoot(candidate, root));
}

function writeCandidate(tool, input) {
  if (
    tool !== "Write" &&
    tool !== "Edit" &&
    tool !== "MultiEdit" &&
    tool !== "NotebookEdit"
  ) {
    return undefined;
  }
  return input.file_path ?? input.notebook_path ?? input.path;
}

function safeWorkspaceWrite(tool, input) {
  const candidate = writeCandidate(tool, input);
  return candidate !== undefined && roots().some((root) => realUnderRoot(candidate, root));
}

function stdinText() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let event;
  try {
    event = JSON.parse(await stdinText());
  } catch {
    decide("deny", "unparseable hook input");
  }

  const tool = typeof event?.tool_name === "string" ? event.tool_name : "?";
  const input =
    event?.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input)
      ? event.tool_input
      : {};

  if (tool.startsWith("mcp__jarvis__")) {
    decide("allow", "pre-approved Jarv1s MCP tool");
  }
  if (DISCOVERY_TOOLS.has(tool)) {
    decide("allow", "tool-schema discovery, no data access and no side effects");
  }
  if (safeVaultRead(tool, input)) {
    decide("allow", "pre-approved read-only vault path");
  }
  if (safeWorkspaceWrite(tool, input)) {
    decide("allow", "pre-approved session workspace write");
  }
  decide(
    "deny",
    tool === "Bash"
      ? "Bash is disabled for one-shot turns"
      : "tool not allowed for one-shot turns"
  );
}

process.on("uncaughtException", () => decide("deny", "hook exception"));
process.on("unhandledRejection", () => decide("deny", "hook exception"));
void main();
`;
