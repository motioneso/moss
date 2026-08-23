// tests/uat/fixtures/scripted-provider/claude-main.ts
//
// #1121: implementation behind bin/claude. Logic lives in a real .ts file (tsc/eslint both
// only walk `**/*.ts` — see tsconfig.json's "include" — so an extensionless executable gets
// zero compiler coverage) and bin/claude is a two-line shebang shim that imports this module.
//
// This is a deterministic stand-in for the real `claude` CLI, resolved onto PATH via
// JARVIS_UAT_SCRIPTED_PROVIDER_BIN (#1659 defect 4): tests/uat/provisioner.ts's
// writeUatEnvFile writes that var when a spec declares chatScript, and Dockerfile:72's
// profile.d script prepends it ahead of JARVIS_CLI_TOOLS_PREFIX/bin on PATH — deliberately
// not JARVIS_CLI_TOOLS_PREFIX itself, which the production installer also owns and would
// otherwise clobber this fixture's bin/claude on every container boot. The real bounded/print engine
// (packages/chat/src/live/claude-print-chat-engine.ts submit(), ~line 74) spawns the CLI
// detached with stdio:"ignore" and never inspects stdout or the exit code — it only polls the
// Anthropic transcript JSONL file for new records. So the only channel that matters to the
// real caller is that file; exit code and stderr matter only to this fixture's own
// integration test and to a human debugging a UAT failure.
//
// Secrets-never-escape (spec #1121 §2 point 2, CLAUDE.md): stderr on any failure path
// carries ONLY the script id, turn index, and a short failure-class string — never prompt
// text, MCP config contents, the bearer token, tool arguments/results, captures, or reply
// content.
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptGlobDir } from "@moss/ai";
import { parseClaudeLaunchArgs } from "./launch-args.js";
import { readCursor, writeCursor, type ScriptCursor } from "./session-state.js";
import {
  loadChatScriptFixture,
  resolveCaptures,
  extractCapture,
  type ChatScriptCall
} from "./script-schema.js";
import { UAT_CHAT_SCRIPTS, type UatChatScript } from "../../seed/types.js";

const TOOLS_CALL_TIMEOUT_MS = 170_000; // 20s margin over NATIVE_CONFIRM_TIMEOUT_MS=150_000
// (packages/chat/src/live/claude-permission-hook.ts:17, wired at gateway-services.ts:152) —
// tools/call blocks server-side until ConfirmationRegistry.awaitResolution() settles.
const TOOLS_LIST_TIMEOUT_MS = 15_000;
export const FAILURE_LOG_PATH = "/data/cli-auth/uat-scripted-provider-failures.log";
export const SUCCESS_LOG_PATH = "/data/cli-auth/uat-scripted-provider-success.log";

class ScriptedClaudeFailure extends Error {
  constructor(
    readonly scriptId: string | undefined,
    readonly turnIndex: number | undefined,
    readonly failureClass: string
  ) {
    super(`[uat-chat-script] script=${scriptId ?? "?"} turn=${turnIndex ?? "?"} ${failureClass}`);
  }
}

function fail(
  scriptId: string | undefined,
  turnIndex: number | undefined,
  failureClass: string
): never {
  throw new ScriptedClaudeFailure(scriptId, turnIndex, failureClass);
}

export function isUatChatScript(value: string): value is UatChatScript {
  return (UAT_CHAT_SCRIPTS as readonly string[]).includes(value);
}

export function isToolAllowed(mcpName: string, allowedTools: readonly string[]): boolean {
  return allowedTools.some((pattern) =>
    pattern.endsWith("*") ? mcpName.startsWith(pattern.slice(0, -1)) : pattern === mcpName
  );
}

interface McpEndpoint {
  readonly url: string;
  readonly authorization: string;
}

function readMcpEndpoint(configPath: string): McpEndpoint {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    fail(undefined, undefined, "mcp-config-unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(undefined, undefined, "mcp-config-invalid-json");
  }
  const jarvis = (parsed as { mcpServers?: { jarvis?: unknown } }).mcpServers?.jarvis as
    | { url?: unknown; headers?: { Authorization?: unknown } }
    | undefined;
  if (
    !jarvis ||
    typeof jarvis.url !== "string" ||
    typeof jarvis.headers?.Authorization !== "string"
  ) {
    fail(undefined, undefined, "mcp-config-malformed");
  }
  return { url: jarvis.url, authorization: jarvis.headers.Authorization };
}

async function callMcp(
  endpoint: McpEndpoint,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  scriptId: string,
  turnIndex: number,
  failureClass: string
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: endpoint.authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    fail(scriptId, turnIndex, `${failureClass}-transport-error`);
  }
  if (response.status === 401) fail(scriptId, turnIndex, "mcp-auth-failed");
  if (!response.ok) fail(scriptId, turnIndex, `${failureClass}-http-${response.status}`);
  let body: { result?: unknown; error?: { code: number; message: string } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    fail(scriptId, turnIndex, `${failureClass}-invalid-json`);
  }
  return body;
}

export async function runScriptedClaude(): Promise<void> {
  const parsed = parseClaudeLaunchArgs(process.argv.slice(2));
  // #1659: carry parseClaudeLaunchArgs's reason through — the bare class name says nothing about
  // which of its dozen fail-closed branches fired. The argument COUNT is included because several
  // reasons turn on arity; the arguments themselves are NOT, because the trailing one is the user's
  // prompt text (this file's header: a failure line carries no prompt text, ever).
  if (parsed.kind === "rejected")
    fail(
      undefined,
      undefined,
      `launch-args-rejected: ${parsed.reason} argc=${process.argv.length - 2}`
    );
  if (parsed.kind === "no-mcp") fail(undefined, undefined, "no-mcp-unsupported");
  const { sessionFlag, mcp, promptText } = parsed;
  if (mcp === undefined) fail(undefined, undefined, "mcp-config-absent");

  const rawScriptId = process.env.JARVIS_UAT_SEED_CHAT_SCRIPT ?? "";
  if (!isUatChatScript(rawScriptId))
    fail(rawScriptId || undefined, undefined, "missing-or-unknown-script-id");
  const scriptId = rawScriptId;

  const stateDir = join(process.cwd(), ".uat-chat-script-state");
  const priorCursor = readCursor(stateDir, sessionFlag.id);

  let effectiveTurnIndex: number;
  if (sessionFlag.mode === "new") {
    if (priorCursor !== undefined) fail(scriptId, undefined, "new-session-already-has-cursor");
    effectiveTurnIndex = 0;
  } else {
    if (priorCursor === undefined) fail(scriptId, undefined, "resume-without-prior-cursor");
    if (priorCursor.scriptId !== scriptId)
      fail(scriptId, priorCursor.turnIndex, "cursor-script-id-mismatch");
    effectiveTurnIndex = priorCursor.turnIndex + 1;
  }

  const fixture = loadChatScriptFixture(scriptId);
  if (effectiveTurnIndex >= fixture.turns.length)
    fail(scriptId, effectiveTurnIndex, "turn-index-out-of-range");

  const eligible = fixture.turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.expectIncludes.every((s) => promptText.includes(s)));
  if (eligible.length !== 1) fail(scriptId, effectiveTurnIndex, "ambiguous-or-zero-eligible-turns");
  const eligibleTurn = eligible[0] as { turn: (typeof fixture.turns)[number]; index: number };
  if (eligibleTurn.index !== effectiveTurnIndex)
    fail(scriptId, effectiveTurnIndex, "eligible-turn-out-of-order");
  const turn = eligibleTurn.turn;

  const endpoint = readMcpEndpoint(mcp.configPath);
  const listBody = await callMcp(
    endpoint,
    "tools/list",
    {},
    TOOLS_LIST_TIMEOUT_MS,
    scriptId,
    effectiveTurnIndex,
    "mcp-tools-list"
  );
  if (listBody.error) fail(scriptId, effectiveTurnIndex, "mcp-tools-list-error");
  const listedNames = new Set(
    ((listBody.result as { tools?: Array<{ name?: unknown }> } | undefined)?.tools ?? [])
      .map((t) => t.name)
      .filter((n): n is string => typeof n === "string")
  );

  const captures = new Map<string, unknown>(Object.entries(priorCursor?.captures ?? {}));
  const toolActivityRecords: string[] = [];

  for (const call of turn.calls as readonly ChatScriptCall[]) {
    if (!listedNames.has(call.tool)) fail(scriptId, effectiveTurnIndex, "tool-not-listed");
    const mcpName = `mcp__jarvis__${call.tool.replace(/\./g, "_")}`;
    if (!isToolAllowed(mcpName, mcp.allowedTools))
      fail(scriptId, effectiveTurnIndex, "tool-not-allowed");

    let resolvedArgs: Record<string, unknown>;
    try {
      resolvedArgs = resolveCaptures(call.arguments, captures) as Record<string, unknown>;
    } catch {
      fail(scriptId, effectiveTurnIndex, "capture-resolution-failed");
    }

    const callBody = await callMcp(
      endpoint,
      "tools/call",
      { name: call.tool, arguments: resolvedArgs },
      TOOLS_CALL_TIMEOUT_MS,
      scriptId,
      effectiveTurnIndex,
      "mcp-tools-call"
    );
    if (callBody.error) fail(scriptId, effectiveTurnIndex, "mcp-tools-call-jsonrpc-error");
    const result = callBody.result as
      | { isError?: boolean; content?: Array<{ text?: unknown }> }
      | undefined;
    if (call.expectedError !== undefined) {
      // #1883: this call is scripted to fail on purpose — a real dependency-failure proof, not a
      // permission/schema problem. Never log or echo the received text (secrets-never-leak, see
      // this file's header) — only a fixed failure-class string on mismatch.
      if (result?.isError !== true) {
        fail(scriptId, effectiveTurnIndex, "expected-error-but-succeeded");
      }
      const receivedText = result?.content?.[0]?.text;
      if (receivedText !== call.expectedError) {
        fail(scriptId, effectiveTurnIndex, "expected-error-mismatch");
      }
    } else if (result?.isError) {
      fail(scriptId, effectiveTurnIndex, "mcp-tools-call-denied-or-failed");
    }

    for (const [name, pointer] of Object.entries(call.captures ?? {})) {
      try {
        captures.set(name, extractCapture(result, pointer));
      } catch {
        fail(scriptId, effectiveTurnIndex, "capture-extraction-failed");
      }
    }

    toolActivityRecords.push(
      JSON.stringify({
        type: "assistant",
        message: {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: mcpName, input: resolvedArgs }]
        }
      })
    );
  }

  const finalRecord = JSON.stringify({
    type: "assistant",
    message: { stop_reason: "end_turn", content: [{ type: "text", text: turn.reply }] }
  });

  const transcriptDir = transcriptGlobDir(
    "anthropic",
    process.cwd(),
    process.env.JARVIS_CLI_HOME_BASE
  );
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${sessionFlag.id}.jsonl`);
  appendFileSync(
    transcriptPath,
    [...toolActivityRecords, finalRecord].map((line) => `${line}\n`).join(""),
    "utf8"
  );

  const cursor: ScriptCursor = {
    scriptId,
    turnIndex: effectiveTurnIndex,
    captures: Object.fromEntries(captures)
  };
  writeCursor(stateDir, sessionFlag.id, cursor);

  // #1659: mirrors FAILURE_LOG_PATH below — a UAT spec can confirm a turn actually ran
  // (not just that the process exited 0) without the log ever carrying prompt/reply content.
  try {
    appendFileSync(
      SUCCESS_LOG_PATH,
      `${new Date().toISOString()} scriptId=${scriptId} turnIndex=${effectiveTurnIndex}\n`
    );
  } catch {
    // best-effort only: outside a provisioned container this path does not exist.
  }
}

export function main(): void {
  runScriptedClaude().then(
    () => process.exit(0),
    (error: unknown) => {
      const failure =
        error instanceof ScriptedClaudeFailure
          ? error
          : new ScriptedClaudeFailure(undefined, undefined, "unhandled-exception");
      const line =
        error instanceof ScriptedClaudeFailure
          ? failure.message
          : `${failure.message}: ${String(error)}`;
      process.stderr.write(`${line}\n`);
      // #1659: the print engine spawns this provider detached with stdio:"ignore", so the line
      // above goes nowhere and every failure reads as "the turn just timed out empty". Tee it to
      // the cli-auth volume, which a UAT spec can read before teardown.
      try {
        appendFileSync(FAILURE_LOG_PATH, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // best-effort only: outside a provisioned container this path does not exist.
      }
      process.exit(1);
    }
  );
}
