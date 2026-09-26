import { resolve } from "node:path";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

import type { AcpToolAnnouncement } from "./client.js";
import { classifyAcpPermission, type AcpSessionFolders } from "./permissions.js";

function commandInput(value: unknown): { command: string; cwd: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.command === "string" &&
    input.command.trim() !== "" &&
    typeof input.cwd === "string" &&
    input.cwd.trim() !== ""
    ? { command: input.command, cwd: input.cwd }
    : null;
}

/**
 * codex-acp 1.10.0 commandToolCall carries the authoritative command envelope.
 * Its correlated announcement may be an inferred read/search without raw input.
 * Call only for an established openai session and a matching announcement id.
 * Display titles never identify a command; all recognized commands remain shell asks.
 * commandToolCall strips the shell wrapper while createCommandExecutionUpdate keeps it,
 * so command strings intentionally are not compared; identity is provider + correlated id.
 */
export function isCodexCommandPermission(
  request: RequestPermissionRequest,
  announced: AcpToolAnnouncement,
  folders: AcpSessionFolders
): boolean {
  const input = commandInput(request.toolCall.rawInput);
  if (request.toolCall.kind !== "execute" || !input) return false;
  if (announced.kind === "execute") {
    const original = commandInput(announced.rawInput);
    if (!original || original.cwd !== input.cwd) return false;
  } else if (announced.kind !== "read" && announced.kind !== "search") {
    return false;
  }
  // Resolve relative paths from the command's cwd, and classify that cwd itself too.
  const commandCwd = resolve(folders.cwd, input.cwd);
  const locations = [...(announced.locations ?? []), ...(request.toolCall.locations ?? [])];
  // Retain the existing forbidden-path decision even when a command was rendered as a read.
  return (
    classifyAcpPermission(
      {
        sessionId: request.sessionId,
        turnId: "",
        toolCallId: request.toolCall.toolCallId,
        title: "",
        toolName: "Grep",
        kind: "read",
        rawInput: {},
        locations: [
          { path: commandCwd },
          ...locations.map(({ path }) => ({ path: resolve(commandCwd, path) }))
        ]
      },
      folders
    ).verdict !== "deny"
  );
}
