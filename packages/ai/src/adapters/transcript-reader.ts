/**
 * JSONL transcript reader — maps per-provider CLI transcript records into
 * ChatActivityEvent stream + final reply detection.
 *
 * ─── Discovered schemas (2026-06-07) ──────────────────────────────────────
 *
 * ## Claude Code / anthropic  (~/.claude/projects/<hash>/<session>.jsonl)
 *
 *   Each line is a JSON object with top-level fields:
 *     type       : "assistant" | "user" | "mode" | "ai-title" | "attachment" | ...
 *     message    : { role, content[], stop_reason, stop_sequence, ... }
 *     uuid, parentUuid, timestamp, sessionId, ...
 *
 *   content items (in message.content[]):
 *     { type: "thinking",  thinking: "<text>" }        → thinking activity
 *     { type: "tool_use",  name: "<name>", ... }       → tool activity
 *     { type: "text",      text: "<text>" }            → narrative / final text
 *
 *   Completion signal:
 *     type === "assistant" AND message.stop_reason === "end_turn"
 *     AND at least one content item has type === "text"
 *     → the concatenated text of those items is the final reply.
 *
 *   Intermediate signals:
 *     stop_reason === "tool_use" — record contains thinking or tool_use items
 *
 * ## Codex / openai-compatible  (~/.codex/sessions/<year>/<mm>/<dd>/<session>.jsonl)
 *
 *   Top-level record types: "session_meta", "event_msg", "response_item",
 *                           "turn_context", "compacted"
 *
 *   Relevant type === "event_msg" records (payload.type):
 *     "agent_reasoning"   : { text }   → thinking activity
 *     "exec_command_end"  : { command } → tool activity (command ran)
 *     "agent_message"     : { message } → status text (intermediate narrative)
 *     "task_complete"     : { last_agent_message } → FINAL reply
 *   Relevant type === "response_item" records (payload.type):
 *     "function_call"        : { name }   → tool activity
 *     "function_call_output" : { output } → tool activity
 *
 *   Also type === "response_item" with payload.role === "assistant" and
 *   payload.phase === "final_answer" and payload.content[0].type === "output_text"
 *   carries the same final text (redundant with task_complete).
 *
 *   Completion signal:
 *     type === "event_msg" AND payload.type === "task_complete"
 *     → payload.last_agent_message is the final reply string.
 *
 * ## Gemini CLI / google  (the process's own stdout, `--output-format stream-json`)
 *
 *   Re-derived 2026-08-27 for #2028 against `@google/gemini-cli@0.57.0`. The schema documented
 *   here before described a saved chat file that no shipped Google CLI writes, and the reply is
 *   no longer read from a file at all: the launch line redirects stdout into the session folder
 *   and this reader parses that. One JSON object per line:
 *
 *     { type: "init",   session_id, model }                      → start of the run
 *     { type: "message", role: "user",      content }            → the prompt echoed back
 *     { type: "message", role: "assistant", content, delta: true } → ONE CHUNK of the reply
 *     { type: "tool_use",    tool_name, tool_id, parameters }    → tool activity
 *     { type: "tool_result", tool_id, status, output, error }    → tool activity
 *     { type: "error",  severity, message }                      → status activity
 *     { type: "result", status: "success" | "error", stats, error? } → END of the turn
 *
 *   The reply arrives ONLY as `delta: true` chunks and must be joined in arrival order — a single
 *   chunk on its own is a fragment, not an answer. Verified in the CLI's own emitter: every
 *   assistant message it writes carries `delta: true`.
 *
 *   Completion signal:
 *     type === "result" → the joined assistant chunks are the final reply.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { ChatActivityEvent } from "../chat-adapter.js";

/**
 * #2164 r21 (item 3) — widens the shared `ChatActivityEvent` locally with an optional
 * `toolName` so a "tool" event can carry the exact tool name alongside its display text,
 * without editing the shared `chat-adapter.ts` type (out of the r21 allowlist). Every mapper
 * still compiles pushing plain `{kind:"tool", text}` since the field is optional; only
 * `mapAnthropicRecord`'s `tool_use` branch sets it.
 */
type ChatActivityEventWithToolName = ChatActivityEvent & { readonly toolName?: string };

export type ProviderKind = "anthropic" | "openai-compatible" | "google";
export type AckProviderKind = Exclude<ProviderKind, "google">;

export interface AckCursor {
  readonly offset: number;
}

export interface TranscriptParseResult {
  readonly events: readonly ChatActivityEventWithToolName[];
  readonly reply: string | null;
  readonly complete: boolean;
}

export function captureAckCursor(jsonl: string): AckCursor {
  return { offset: jsonl.length };
}

/**
 * #1170 (second kill link): tmux `paste-buffer` without `-p` delivers newlines as
 * carriage returns, and claude 2.1.215 records the pasted user turn with literal
 * `\r` where the engine's expectedText has `\n` (probe-confirmed: pasted
 * `…else.\n\n<attachments>` → transcript `…else.\r\r<attachments>`). Strict `===`
 * therefore NEVER acked a multiline turn — the turn delivered and ran, but the
 * engine hit `verifiedSubmitMs` and 500'd with delivery_unknown. Compare with
 * newline flavor normalized on BOTH sides; this cannot promote a foreign record
 * into an ack (the text must still match byte-for-byte modulo CR/CRLF vs LF).
 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function hasExactUserAck(
  provider: AckProviderKind,
  jsonl: string,
  cursor: AckCursor,
  expectedText: string
): boolean {
  const expected = normalizeNewlines(expectedText);
  for (const line of completeLinesAfter(jsonl, cursor.offset)) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const recorded = provider === "anthropic" ? claudeUserText(rec) : codexUserText(rec);
    if (recorded !== null && normalizeNewlines(recorded) === expected) return true;
  }
  return false;
}

/**
 * Parse a JSONL transcript string for the given provider.
 *
 * @param provider  Which CLI produced the transcript.
 * @param jsonl     Full transcript content as a string.
 * @param afterOffset  Byte offset into `jsonl` to start reading from
 *                    (pass 0 to read everything; pass the previous `jsonl.length`
 *                    to read only newly appended lines).
 */
export function parseTranscript(
  provider: ProviderKind,
  jsonl: string,
  afterOffset: number
): TranscriptParseResult {
  const slice = jsonl.slice(afterOffset);
  const lines = slice.split("\n").filter((l) => l.trim().length > 0);

  const events: ChatActivityEventWithToolName[] = [];
  const geminiTurn: GeminiTurnState = { assistant: "" };
  let reply: string | null = null;
  let complete = false;

  // Gemini emits assistant text in separate stream-json records. When a caller polls between
  // those records, rebuild the in-flight answer from the already-consumed prefix before parsing
  // the new suffix. Without this, a later `result` record only returns the last chunk seen.
  if (provider === "google" && afterOffset > 0) {
    const priorLines = jsonl.slice(0, Math.min(afterOffset, jsonl.length)).split("\n").slice(0, -1);
    for (const line of priorLines) {
      if (!line.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      mapGeminiRecord(rec, [], geminiTurn, () => undefined);
    }
  }

  for (const line of lines) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Partial/corrupt line — skip (CLI may still be writing)
      continue;
    }

    switch (provider) {
      case "anthropic":
        mapAnthropicRecord(rec, events, (r) => {
          reply = r;
          complete = true;
        });
        break;
      case "openai-compatible":
        mapCodexRecord(rec, events, (r) => {
          reply = r;
          complete = true;
        });
        break;
      case "google":
        mapGeminiRecord(rec, events, geminiTurn, (r) => {
          reply = r;
          complete = true;
        });
        break;
    }
  }

  return { events, reply, complete };
}

// ─── anthropic / Claude Code mapping ─────────────────────────────────────────

function mapAnthropicRecord(
  rec: Record<string, unknown>,
  events: ChatActivityEventWithToolName[],
  onFinal: (text: string) => void
): void {
  if (rec["type"] !== "assistant") return;

  const message = rec["message"] as Record<string, unknown> | undefined;
  if (!message) return;

  const stopReason = message["stop_reason"] as string | undefined;
  const content = message["content"];
  if (!Array.isArray(content)) return;

  if (stopReason === "end_turn") {
    // Collect all text content items as the final reply
    const textParts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item["type"] === "text" && typeof item["text"] === "string") {
        textParts.push(item["text"]);
      }
    }
    if (textParts.length > 0) {
      onFinal(textParts.join("\n"));
    }
    return;
  }

  // Intermediate: extract activity events from content items
  for (const item of content) {
    if (!isRecord(item)) continue;
    const itemType = item["type"] as string | undefined;
    if (itemType === "thinking") {
      const text = typeof item["thinking"] === "string" ? item["thinking"] : "";
      events.push({ kind: "thinking", text });
    } else if (itemType === "tool_use") {
      const name = typeof item["name"] === "string" ? item["name"] : "tool";
      events.push({ kind: "tool", text: name, toolName: name });
    } else if (itemType === "text" && typeof item["text"] === "string") {
      // Intermediate text blocks (stop_reason !== "end_turn") are status
      events.push({ kind: "status", text: item["text"] });
    }
  }
}

// ─── openai-compatible / Codex mapping ───────────────────────────────────────

function mapCodexRecord(
  rec: Record<string, unknown>,
  events: ChatActivityEventWithToolName[],
  onFinal: (text: string) => void
): void {
  // #1242: codex-cli's `exec --json` stdout stream (0.139.0+) is a DIFFERENT schema from the
  // rollout-session file documented above. It emits, per turn: thread.started → turn.started →
  // item.completed{item:{type,text}} → turn.completed. The final assistant reply is the
  // agent_message item's text; reasoning items are thinking activity; command/tool items are tool
  // activity. Its `type` values are disjoint from the rollout schema (`event_msg`/`response_item`),
  // so both are handled by this one mapper without either clobbering the other. This is the schema
  // the headless one-shot CodexExecSession (P-02a / epic #1238) parses.
  if (rec["type"] === "item.completed") {
    mapCodexExecItem(rec, events, onFinal);
    return;
  }
  if (rec["type"] === "response_item") {
    mapCodexResponseItem(rec, events);
    return;
  }
  if (rec["type"] !== "event_msg") return;

  const payload = rec["payload"] as Record<string, unknown> | undefined;
  if (!payload) return;

  const payloadType = payload["type"] as string | undefined;

  switch (payloadType) {
    case "agent_reasoning": {
      const text = typeof payload["text"] === "string" ? payload["text"] : "";
      events.push({ kind: "thinking", text });
      break;
    }
    case "exec_command_end": {
      const command = payload["command"];
      const cmdText = Array.isArray(command) ? command.join(" ") : String(command ?? "");
      events.push({ kind: "tool", text: cmdText });
      break;
    }
    case "agent_message": {
      const text = typeof payload["message"] === "string" ? payload["message"] : "";
      events.push({ kind: "status", text });
      break;
    }
    case "task_complete": {
      const msg = payload["last_agent_message"];
      if (typeof msg === "string") {
        onFinal(msg);
      }
      break;
    }
  }
}

function mapCodexResponseItem(
  rec: Record<string, unknown>,
  events: ChatActivityEventWithToolName[]
): void {
  const payload = rec["payload"] as Record<string, unknown> | undefined;
  if (!payload) return;

  if (payload["type"] === "function_call") {
    const name = typeof payload["name"] === "string" ? payload["name"] : "function_call";
    events.push({ kind: "tool", text: name });
    return;
  }

  if (payload["type"] === "function_call_output") {
    events.push({ kind: "tool", text: "function_call_output" });
  }
}

/**
 * #1242: map one codex `exec --json` `item.completed` record (0.139.0+ schema). The agent_message
 * item carries the FINAL assistant reply; reasoning items are thinking activity; command/tool items
 * are tool activity. Unknown item types are ignored. Completion is signaled to the caller by firing
 * `onFinal` with the reply text (mirrors the rollout `task_complete` path) — `turn.completed` carries
 * only usage, no text, so the reply must be captured here.
 */
function mapCodexExecItem(
  rec: Record<string, unknown>,
  events: ChatActivityEventWithToolName[],
  onFinal: (text: string) => void
): void {
  const item = rec["item"];
  if (!isRecord(item)) return;
  const itemType = typeof item["type"] === "string" ? item["type"] : "";
  const text = typeof item["text"] === "string" ? item["text"] : "";
  if (itemType === "agent_message") {
    if (text) onFinal(text);
    return;
  }
  if (itemType === "reasoning") {
    if (text) events.push({ kind: "thinking", text });
    return;
  }
  if (itemType === "command_execution" || itemType === "mcp_tool_call") {
    const label =
      typeof item["command"] === "string"
        ? item["command"]
        : typeof item["tool"] === "string"
          ? item["tool"]
          : itemType;
    events.push({ kind: "tool", text: label });
  }
}

// ─── google / Gemini CLI mapping ──────────────────────────────────────────────

/**
 * The reply is assembled across many lines, so the google mapper needs somewhere to keep the
 * chunks it has seen so far. One of these per `parseTranscript` call.
 */
interface GeminiTurnState {
  assistant: string;
}

function mapGeminiRecord(
  rec: Record<string, unknown>,
  events: ChatActivityEventWithToolName[],
  turn: GeminiTurnState,
  onFinal: (text: string) => void
): void {
  switch (rec["type"]) {
    case "message": {
      // Only the assistant's own chunks build the reply. The user line is our prompt echoed back;
      // treating it as reply text would answer the founder with their own question.
      if (rec["role"] !== "assistant") return;
      const content = rec["content"];
      if (typeof content !== "string") return;
      if (rec["delta"] === true) turn.assistant += content;
      else turn.assistant = content;
      return;
    }
    case "tool_use": {
      const name = typeof rec["tool_name"] === "string" ? rec["tool_name"] : "tool";
      events.push({ kind: "tool", text: name });
      return;
    }
    case "tool_result": {
      const status = typeof rec["status"] === "string" ? rec["status"] : "done";
      events.push({ kind: "tool", text: `tool result: ${status}` });
      return;
    }
    case "error": {
      const message = typeof rec["message"] === "string" ? rec["message"] : "";
      const severity = typeof rec["severity"] === "string" ? rec["severity"] : "error";
      events.push({ kind: "status", text: message ? `${severity}: ${message}` : severity });
      return;
    }
    case "result": {
      // The turn is over either way. A failed run has no assistant chunks, so the joined text is
      // empty and the caller sees "finished with no reply" rather than a silent hang.
      const error = rec["error"];
      if (rec["status"] === "error" && isRecord(error) && typeof error["message"] === "string") {
        events.push({ kind: "status", text: error["message"] });
      }
      const reply = turn.assistant;
      turn.assistant = "";
      onFinal(reply);
      return;
    }
    default:
      return;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function completeLinesAfter(jsonl: string, offset: number): string[] {
  let start = Math.max(0, Math.min(offset, jsonl.length));
  if (start > 0 && jsonl[start - 1] !== "\n") {
    const nextBoundary = jsonl.indexOf("\n", start);
    if (nextBoundary < 0) return [];
    start = nextBoundary + 1;
  }

  const end = jsonl.lastIndexOf("\n");
  if (end < start) return [];
  return jsonl
    .slice(start, end)
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function claudeUserText(rec: Record<string, unknown>): string | null {
  if (rec["type"] !== "user") return null;
  const message = rec["message"];
  if (!isRecord(message) || message["role"] !== "user") return null;
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) return null;
  return content[0]["type"] === "text" && typeof content[0]["text"] === "string"
    ? content[0]["text"]
    : null;
}

function codexUserText(rec: Record<string, unknown>): string | null {
  if (rec["type"] !== "event_msg") return null;
  const payload = rec["payload"];
  if (!isRecord(payload) || payload["type"] !== "user_message") return null;
  return typeof payload["message"] === "string" ? payload["message"] : null;
}
