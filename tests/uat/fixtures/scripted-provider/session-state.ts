// tests/uat/fixtures/scripted-provider/session-state.ts
//
// #1121 spec §2 point 2: the fixture's on-disk cursor tracks only script progress, never anything
// sensitive — no prompt text, MCP config, bearer token, tool results, or attachment content.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScriptCursor {
  readonly scriptId: string;
  readonly turnIndex: number;
  readonly captures: Readonly<Record<string, unknown>>;
}

function cursorPath(stateDir: string, sessionId: string): string {
  return join(stateDir, `${sessionId}.json`);
}

function isValidCursor(value: unknown): value is ScriptCursor {
  if (!value || typeof value !== "object") return false;
  const v = value as { scriptId?: unknown; turnIndex?: unknown; captures?: unknown };
  return (
    typeof v.scriptId === "string" &&
    typeof v.turnIndex === "number" &&
    !!v.captures &&
    typeof v.captures === "object" &&
    !Array.isArray(v.captures)
  );
}

/** Returns `undefined` for a missing, malformed, or shape-mismatched prior cursor — never throws. */
export function readCursor(stateDir: string, sessionId: string): ScriptCursor | undefined {
  let raw: string;
  try {
    raw = readFileSync(cursorPath(stateDir, sessionId), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isValidCursor(parsed) ? parsed : undefined;
}

export function writeCursor(stateDir: string, sessionId: string, cursor: ScriptCursor): void {
  mkdirSync(stateDir, { recursive: true });
  const path = cursorPath(stateDir, sessionId);
  writeFileSync(path, JSON.stringify(cursor), "utf8");
  chmodSync(path, 0o600);
}
