// tests/uat/specs/notes-failure-evidence.ts
//
// #2737: when notes-default-retrieval.uat.spec.ts fails, capture bounded, best-effort evidence
// that settles whether a real notes.create write happened — never note content, never tool
// arguments, never credentials. A plain module, not a spec, so importing it never registers
// stray Playwright tests (the same reason real-chat-signin.ts is a module, not a spec).
//
// Three sources, all read-only:
//   1. Does the note file exist in the stack, and what size is it (never its contents)?
//   2. The gateway's own action-audit log (GET /api/ai/action-audit) for the turn — the
//      authoritative "did a real tool run" signal per the #2737 diagnosis.
//   3. The chat thread's own activity events for the turn, bounded to kind, tool name and
//      status — the weaker "what did the agent say it called" signal.
// Every step is independently best-effort: a failure here is recorded as a reason string and
// never allowed to replace or mask the spec's real failure.
import { execFileSync } from "node:child_process";

import type { APIRequestContext, TestInfo } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";

const MAX_TOOL_CALL_EVENTS = 20;
const DOCKER_EXEC_TIMEOUT_MS = 15_000;
const MISSING_MARKER = "NOTES_2737_MISSING";

// ---------------------------------------------------------------------------------------------
// 1. Note file existence + size
// ---------------------------------------------------------------------------------------------

export interface NoteFileEvidence {
  readonly path: string;
  readonly exists: boolean | null;
  readonly sizeBytes: number | null;
  readonly error: string | null;
}

/**
 * Pure: turns the container command's raw stdout into exists/size. Exported so the parsing
 * itself can be unit-tested without a live stack. `stdout` is either a byte count (file exists)
 * or the fixed MISSING_MARKER string (file absent) — never file content.
 */
export function parseNoteFileCheckOutput(stdout: string): {
  readonly exists: boolean;
  readonly sizeBytes: number | null;
} {
  const trimmed = stdout.trim();
  if (trimmed === MISSING_MARKER) {
    return { exists: false, sizeBytes: null };
  }
  const size = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`unexpected note-file-check output: ${JSON.stringify(trimmed)}`);
  }
  return { exists: true, sizeBytes: size };
}

/**
 * Checks, from inside the stack container, whether the exact target note file exists and how
 * large it is — never reads or logs its contents. Uses the same `docker compose exec -T`
 * pattern as real-chat-env.ts and notes-path-recheck.uat.spec.ts, project-scoped via
 * buildUatComposeArgs so it can never drift onto the wrong stack.
 */
export function captureNoteFileEvidence(
  projectName: string,
  fullNotePath: string
): NoteFileEvidence {
  const script = `if [ -f "$1" ]; then stat -c %s "$1"; else echo ${MISSING_MARKER}; fi`;
  try {
    const stdout = execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "exec",
        "-T",
        "jarv1s",
        "sh",
        "-c",
        script,
        "sh",
        fullNotePath
      ]),
      { encoding: "utf8", timeout: DOCKER_EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = parseNoteFileCheckOutput(stdout);
    return { path: fullNotePath, exists: parsed.exists, sizeBytes: parsed.sizeBytes, error: null };
  } catch (error) {
    return { path: fullNotePath, exists: null, sizeBytes: null, error: String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Action-audit log (the gateway's own record of a real tool run)
// ---------------------------------------------------------------------------------------------

export interface BoundAuditEntry {
  readonly toolName: string;
  readonly outcome: string;
  readonly occurredAt: string;
}

export interface ActionAuditEvidence {
  readonly source: "api:/api/ai/action-audit";
  readonly entries: readonly BoundAuditEntry[];
  readonly error: string | null;
}

/** Pure: keeps only tool name, outcome and timestamp — never requestId, chatSessionId or input. */
export function summarizeAuditEntries(
  entries: readonly { toolName: string; outcome: string; occurredAt: string }[]
): readonly BoundAuditEntry[] {
  return entries.map((entry) => ({
    toolName: entry.toolName,
    outcome: entry.outcome,
    occurredAt: entry.occurredAt
  }));
}

/**
 * Reads the account's own action-audit log for rows since the turn started. This is a real
 * user-facing API (GET /api/ai/action-audit, packages/ai/src/routes.ts) — the same audit trail
 * the #2737 diagnosis names as the one authoritative "a tool actually ran" signal, so this never
 * needs a direct database read.
 */
export async function captureActionAuditEvidence(
  request: APIRequestContext,
  sinceIso: string
): Promise<ActionAuditEvidence> {
  try {
    const response = await request.get(
      `/api/ai/action-audit?since=${encodeURIComponent(sinceIso)}&limit=100`
    );
    if (!response.ok()) {
      return {
        source: "api:/api/ai/action-audit",
        entries: [],
        error: `GET /api/ai/action-audit -> ${response.status()}`
      };
    }
    const body = (await response.json()) as {
      entries: readonly { toolName: string; outcome: string; occurredAt: string }[];
    };
    return {
      source: "api:/api/ai/action-audit",
      entries: summarizeAuditEntries(body.entries),
      error: null
    };
  } catch (error) {
    return { source: "api:/api/ai/action-audit", entries: [], error: String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Bounded ACP tool-call / tool-call-update metadata for the turn
// ---------------------------------------------------------------------------------------------

export interface BoundToolCallEvent {
  readonly kind: string;
  readonly toolName: string | null;
  readonly status: string | null;
}

export interface ToolCallEvidence {
  readonly source: "api:/api/chat/threads/:id/messages";
  readonly events: readonly BoundToolCallEvent[];
  readonly error: string | null;
}

interface RawActivityEventForEvidence {
  readonly kind: string;
  readonly toolName?: string;
  readonly outcome?: string;
}

/**
 * Pure: caps the event list at MAX_TOOL_CALL_EVENTS and keeps only kind, tool name and status
 * (the "outcome" field the wire DTO carries for a gateway-audited record; absent for a raw ACP
 * tool_call/tool_call_update, which is itself the signal worth recording — no status ever means
 * no gateway execution was tied to that event). Never text, never toolCallId, never arguments.
 */
export function boundToolCallEvents(
  events: readonly RawActivityEventForEvidence[]
): readonly BoundToolCallEvent[] {
  return events.slice(0, MAX_TOOL_CALL_EVENTS).map((event) => ({
    kind: event.kind,
    toolName: event.toolName ?? null,
    status: event.outcome ?? null
  }));
}

/**
 * Reads the same chat-thread-messages API the page itself calls to draw the transcript
 * (apps/web/src/chat/use-chat-stream.ts), and bounds/redacts its per-message `activity` array —
 * the wire form of the records acp-chat-engine.ts's tool_call/tool_call_update handling produces
 * (packages/chat/src/live/acp-chat-engine.ts:425-497). Picks the most recently active thread for
 * `surface`, then its most recent message's activity.
 */
export async function captureToolCallEvidence(
  request: APIRequestContext,
  surface: string
): Promise<ToolCallEvidence> {
  const source = "api:/api/chat/threads/:id/messages" as const;
  try {
    const threadsResponse = await request.get(
      `/api/chat/threads?surface=${encodeURIComponent(surface)}`
    );
    if (!threadsResponse.ok()) {
      return { source, events: [], error: `GET /api/chat/threads -> ${threadsResponse.status()}` };
    }
    const threadsBody = (await threadsResponse.json()) as {
      threads: readonly { id: string; lastActiveAt: string }[];
    };
    if (threadsBody.threads.length === 0) {
      return { source, events: [], error: "no chat threads found" };
    }
    const mostRecent = [...threadsBody.threads].sort((a, b) =>
      b.lastActiveAt.localeCompare(a.lastActiveAt)
    )[0]!;

    const messagesResponse = await request.get(
      `/api/chat/threads/${encodeURIComponent(mostRecent.id)}/messages?surface=${encodeURIComponent(surface)}`
    );
    if (!messagesResponse.ok()) {
      return {
        source,
        events: [],
        error: `GET /api/chat/threads/:id/messages -> ${messagesResponse.status()}`
      };
    }
    const messagesBody = (await messagesResponse.json()) as {
      messages: readonly {
        role: string;
        activity: readonly RawActivityEventForEvidence[];
      }[];
    };
    const lastAssistantMessage = [...messagesBody.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!lastAssistantMessage) {
      return { source, events: [], error: "no assistant message found in the most recent thread" };
    }
    return { source, events: boundToolCallEvents(lastAssistantMessage.activity), error: null };
  } catch (error) {
    return { source, events: [], error: String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface NotesFailureEvidenceParams {
  readonly projectName: string;
  readonly fullNotePath: string;
  readonly turnStartIso: string;
  readonly chatSurface: string;
}

/**
 * Runs all three captures best-effort and attaches the combined result to the failed test, plus
 * a short bounded summary to the console. Never throws — a capture failure is recorded as a
 * reason string on its own section, so it can never mask the spec's real (already-decided)
 * failure.
 */
export async function attachNotesFailureEvidence(
  testInfo: TestInfo,
  request: APIRequestContext,
  params: NotesFailureEvidenceParams
): Promise<void> {
  const noteFile = captureNoteFileEvidence(params.projectName, params.fullNotePath);
  const actionAudit = await captureActionAuditEvidence(request, params.turnStartIso);
  const toolCalls = await captureToolCallEvidence(request, params.chatSurface);

  const evidence = { noteFile, actionAudit, toolCalls };
  const json = JSON.stringify(evidence, null, 2);

  await testInfo.attach("2737-notes-failure-evidence.json", {
    body: json,
    contentType: "application/json"
  });
  // Bounded and safe to print: sizes/counts/outcomes only, never content or arguments.
  console.error(`[uat #2737] notes-default-retrieval failure evidence:\n${json}`);
}
