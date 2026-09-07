import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { GatewayToolResponse } from "./types.js";

// Bash and Task stay permanently gated: YOLO removes confirmation only for these mutation-only
// tools, and unknown/future native capabilities fail closed to the normal confirmation path.
const NATIVE_YOLO_AUTO_ALLOW = new Set(["Edit", "Write", "NotebookEdit"]);

const NATIVE_CONFIG_FILE_NAMES = new Set([
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  ".mcp.json",
  "keybindings.json",
  // #1085 F2: these cwd-root files enforce the native permission boundary; auto-allowing a
  // rewrite would let later Bash/Task hooks bypass the gateway and every audit row.
  ".jarvis-claude-permission-hook.mjs",
  ".jarvis-claude-settings.json",
  ".jarvis-claude-permission-token",
  ".claude.json"
]);

export function gatewayFailureReason(result: Extract<GatewayToolResponse, { ok: false }>): string {
  return "reason" in result ? result.reason : result.error;
}

export function safeNativeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (trimmed.length === 0) return "Unknown";
  return trimmed.slice(0, 120);
}

export async function nativeYoloCanAutoAllow(
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory: string | undefined
): Promise<boolean> {
  if (!NATIVE_YOLO_AUTO_ALLOW.has(toolName)) return false;
  const target = input[toolName === "NotebookEdit" ? "notebook_path" : "file_path"];
  if (typeof workingDirectory !== "string" || workingDirectory.trim() === "") return false;
  if (typeof target !== "string" || target.trim() === "") return false;

  try {
    const lexicalRoot = resolve(workingDirectory);
    const lexicalTarget = resolve(lexicalRoot, target);
    const lexicalRelative = relative(lexicalRoot, lexicalTarget);
    // #1085 F3: native YOLO is workspace-scoped. Absolute paths and traversal that escape cwd
    // stay gated even when they name ordinary-looking files such as ~/.bashrc or .git hooks.
    if (
      lexicalRelative === ".." ||
      lexicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(lexicalRelative)
    ) {
      return false;
    }

    const canonicalRoot = await realpath(lexicalRoot);
    const canonicalTarget = await realpathWriteTarget(lexicalTarget);
    if (canonicalTarget === undefined) return false;
    const canonicalRelative = relative(canonicalRoot, canonicalTarget);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      return false;
    }

    return (
      !canonicalTarget.split(sep).includes(".claude") &&
      !NATIVE_CONFIG_FILE_NAMES.has(basename(canonicalTarget))
    );
  } catch {
    return false;
  }
}

async function realpathWriteTarget(target: string): Promise<string | undefined> {
  const unresolved: string[] = [];
  let existing = target;

  for (;;) {
    try {
      return resolve(await realpath(existing), ...unresolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    // #1085 F3: a dangling symlink can still redirect a subsequent Write outside cwd. Detect it
    // while walking to the deepest existing ancestor; unreadable/ambiguous paths fail closed.
    try {
      if ((await lstat(existing)).isSymbolicLink()) return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }

    const parent = dirname(existing);
    if (parent === existing) return undefined;
    unresolved.unshift(basename(existing));
    existing = parent;
  }
}

export function nativeToolRisk(toolName: string): "write" | "destructive" {
  return toolName === "Bash" || toolName === "Unknown" ? "destructive" : "write";
}

export function nativeToolSummary(toolName: string, input: Record<string, unknown>): string {
  const inputKeyCount = Object.keys(input).length;
  return `Claude wants to use native ${toolName} (${inputKeyCount} field(s)).`;
}
