// tests/uat/specs/notes-failure-evidence.ts
//
// #2737: when notes-default-retrieval.uat.spec.ts fails, capture bounded, best-effort evidence
// that settles whether a real notes.create write happened — never note content, never tool
// arguments, never credentials. A plain module, not a spec, so importing it never registers
// stray Playwright tests (the same reason real-chat-signin.ts is a module, not a spec).
//
// Three sources, all read straight from the stack's own containers through `docker compose exec`
// — never a browser cookie, never an HTTP call. A Playwright trace records every call made
// through the page or through `page.request`, including headers and full response bodies, so a
// credential or note content read that way would ride along into the trace the failing test
// already keeps. A `child_process` call made directly from the test runner is never recorded
// there, which is why the note-file check has always worked this way and why the other two
// checks now read the stack's own Postgres container instead of calling its HTTP API:
//   1. Does the note file exist in the stack, and what size is it (never its contents)?
//   2. The gateway's own action-audit table (app.moss_action_audit_log) for the turn — the
//      authoritative "did a real tool run" signal per the #2737 diagnosis.
//   3. The chat activity recorded on the assistant message(s) saved in the note-writing turn's
//      own time window, bounded to tool-call/result kind, tool name and status — the weaker
//      "what did the agent say it called" signal.
//
// The turn's time window is [turnStartIso, retrievalTurnStartIso) — both are plain
// `Date.now()` values the spec records synchronously, before it sends each chat message, never
// awaited and never on the assertion path. Scoping to that window (rather than "the newest
// thread" or "the last saved message") is what keeps this evidence tied to the turn that matters:
// a chat reply is only saved once it completes, so an in-flight or stalled turn can otherwise
// leave an older message looking like the answer.
//
// Every step is independently best-effort: a failure is recorded as a fixed reason code, never
// as the raw error object or any command output, so a private value a command's stderr or a
// database row happened to contain can never ride along into the attachment or the console.
import { execFileSync } from "node:child_process";

import type { TestInfo } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";

const MAX_TOOL_CALL_EVENTS = 20;
const CONTAINER_EXEC_TIMEOUT_MS = 10_000;
const MISSING_MARKER = "NOTES_2737_MISSING";
const AUDIT_ROW_LIMIT = 200;
const CHAT_MESSAGE_ROW_LIMIT = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_SURFACE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Fixed, non-identifying reasons a capture step can fail with — never a raw error's own text. */
export type CaptureErrorCode =
  | "docker_exec_failed"
  | "docker_exec_timed_out"
  | "unexpected_docker_output"
  | "turn_message_not_saved";

/** `code` alone, or `code:status` when the failure carried a real exit status. */
export function formatCaptureError(code: CaptureErrorCode, status?: number): string {
  return status === undefined ? code : `${code}:${status}`;
}

class UnexpectedDockerOutputError extends Error {}

/** Matches Node's `child_process.execFileSync` — a real docker call in production, a fake in tests. */
export type ExecFileImpl = typeof execFileSync;

// ---------------------------------------------------------------------------------------------
// Shared container-exec helper — never surfaces a raw error, stderr, or command output
// ---------------------------------------------------------------------------------------------

type ContainerCommandResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly code: CaptureErrorCode; readonly status?: number };

/**
 * Runs one `docker ...` command with a short timeout and returns its stdout, or a fixed failure
 * code. Never throws, and never lets the error object's own message (which can quote a
 * container's stderr) reach the caller — only a numeric exit status, when there is one.
 */
function runContainerCommand(
  execImpl: ExecFileImpl,
  args: readonly string[]
): ContainerCommandResult {
  try {
    const stdout = execImpl("docker", args, {
      encoding: "utf8",
      timeout: CONTAINER_EXEC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, stdout };
  } catch (error) {
    const record = error as { killed?: boolean; status?: number | null };
    if (record?.killed === true) {
      return { ok: false, code: "docker_exec_timed_out" };
    }
    return typeof record?.status === "number"
      ? { ok: false, code: "docker_exec_failed", status: record.status }
      : { ok: false, code: "docker_exec_failed" };
  }
}

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
    throw new UnexpectedDockerOutputError();
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
  execImpl: ExecFileImpl,
  projectName: string,
  fullNotePath: string
): NoteFileEvidence {
  const script = `if [ -f "$1" ]; then stat -c %s "$1"; else echo ${MISSING_MARKER}; fi`;
  const result = runContainerCommand(
    execImpl,
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "jarv1s",
      "sh",
      "-c",
      script,
      "sh",
      fullNotePath
    ])
  );
  if (!result.ok) {
    return {
      path: fullNotePath,
      exists: null,
      sizeBytes: null,
      error: formatCaptureError(result.code, result.status)
    };
  }
  try {
    const parsed = parseNoteFileCheckOutput(result.stdout);
    return { path: fullNotePath, exists: parsed.exists, sizeBytes: parsed.sizeBytes, error: null };
  } catch {
    return {
      path: fullNotePath,
      exists: null,
      sizeBytes: null,
      error: formatCaptureError("unexpected_docker_output")
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Shared read-only psql-as-JSON helper
// ---------------------------------------------------------------------------------------------

/**
 * Runs one read-only query as the container's bootstrap superuser (the same role/database pair
 * job-search-board-sql.ts's execUatSql uses — there is no `jarv1s` ROLE, only `postgres`), and
 * parses its single-line `jsonb_agg(...)` result. Returns `[]` for "no rows" (`jsonb_agg` of zero
 * rows is SQL NULL, which `-t -A` prints as an empty line) instead of throwing.
 */
function runPsqlJsonQuery(
  execImpl: ExecFileImpl,
  projectName: string,
  sql: string
):
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false; readonly code: string } {
  const result = runContainerCommand(
    execImpl,
    buildUatComposeArgs(projectName, [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "jarv1s",
      "-t",
      "-A",
      "-c",
      sql
    ])
  );
  if (!result.ok) {
    return { ok: false, code: formatCaptureError(result.code, result.status) };
  }
  try {
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return { ok: true, rows: [] };
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null) return { ok: true, rows: [] };
    if (!Array.isArray(parsed)) throw new UnexpectedDockerOutputError();
    return { ok: true, rows: parsed };
  } catch {
    return { ok: false, code: formatCaptureError("unexpected_docker_output") };
  }
}

/** Rejects anything that is not a well-formed UUID or ISO timestamp before it reaches SQL text. */
function isSafeUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
function isSafeTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}
function isSafeChatSurface(value: string): boolean {
  return CHAT_SURFACE_PATTERN.test(value);
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
  readonly source: "sql:app.moss_action_audit_log";
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
 * Reads the account's own action-audit rows for the turn's time window straight out of the
 * stack's Postgres container — this is the same table the #2737 diagnosis names as the one
 * authoritative "a tool actually ran" signal. Selects only tool_name, outcome and occurred_at;
 * never request_id, chat_session_id or the input summary column.
 */
export function captureActionAuditEvidence(
  execImpl: ExecFileImpl,
  projectName: string,
  ownerUserId: string,
  turnStartIso: string,
  turnEndIso: string
): ActionAuditEvidence {
  const source = "sql:app.moss_action_audit_log" as const;
  if (!isSafeUuid(ownerUserId) || !isSafeTimestamp(turnStartIso) || !isSafeTimestamp(turnEndIso)) {
    return { source, entries: [], error: formatCaptureError("unexpected_docker_output") };
  }
  const sql =
    "SELECT jsonb_agg(t.* ORDER BY occurred_at) FROM (" +
    "SELECT tool_name, outcome, occurred_at FROM app.moss_action_audit_log " +
    `WHERE owner_user_id = '${ownerUserId}' ` +
    `AND occurred_at >= '${turnStartIso}' AND occurred_at < '${turnEndIso}' ` +
    `ORDER BY occurred_at LIMIT ${AUDIT_ROW_LIMIT}) t`;
  const result = runPsqlJsonQuery(execImpl, projectName, sql);
  if (!result.ok) return { source, entries: [], error: result.code };
  try {
    const rows = result.rows as readonly {
      tool_name: string;
      outcome: string;
      occurred_at: string;
    }[];
    return {
      source,
      entries: summarizeAuditEntries(
        rows.map((row) => ({
          toolName: row.tool_name,
          outcome: row.outcome,
          occurredAt: row.occurred_at
        }))
      ),
      error: null
    };
  } catch {
    return { source, entries: [], error: formatCaptureError("unexpected_docker_output") };
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Bounded chat activity for the assistant message(s) saved in the turn's own time window
// ---------------------------------------------------------------------------------------------

export interface BoundToolCallEvent {
  readonly kind: string;
  readonly toolName: string | null;
  readonly status: string | null;
}

export interface ToolCallEvidence {
  readonly source: "sql:app.chat_messages";
  readonly events: readonly BoundToolCallEvent[];
  /** How many tool-related events existed beyond the MAX_TOOL_CALL_EVENTS cap — 0 when none. */
  readonly omittedCount: number;
  readonly error: string | null;
}

interface RawActivityEventForEvidence {
  readonly kind: string;
  readonly toolName?: string;
  readonly outcome?: string;
}

/** Only these kinds represent an actual tool call, update, or gateway-audited outcome. */
const TOOL_RELATED_KINDS = new Set(["tool", "result", "action_request", "action_result"]);

/**
 * Pure: keeps only tool-related events (never a "thought"/"reply"/etc, which could otherwise
 * fill the whole cap and hide the one tool event that matters), THEN caps at
 * MAX_TOOL_CALL_EVENTS, and reports how many were dropped by the cap. Each kept event carries
 * only kind, tool name and status — never text, toolCallId or arguments.
 */
export function boundToolCallEvents(events: readonly RawActivityEventForEvidence[]): {
  readonly events: readonly BoundToolCallEvent[];
  readonly omittedCount: number;
} {
  const toolRelated = events.filter((event) => TOOL_RELATED_KINDS.has(event.kind));
  const kept = toolRelated.slice(0, MAX_TOOL_CALL_EVENTS);
  return {
    events: kept.map((event) => ({
      kind: event.kind,
      toolName: event.toolName ?? null,
      status: event.outcome ?? null
    })),
    omittedCount: toolRelated.length - kept.length
  };
}

/**
 * Reads the assistant message(s) saved, for this account's drawer-surface threads, at or after
 * the note-writing turn's start and before the retrieval turn's start (or now, if the retrieval
 * turn never started). A chat reply is saved only once it completes, so scoping by time — rather
 * than "the newest thread" or "the last saved message" — is what keeps this tied to the one turn
 * that matters: a timeout or a later, unrelated turn can otherwise leave an older message looking
 * like the answer. If nothing was saved in that window, reports the fixed reason
 * `turn_message_not_saved` instead of falling back to an older message.
 */
export function captureToolCallEvidence(
  execImpl: ExecFileImpl,
  projectName: string,
  ownerUserId: string,
  chatSurface: string,
  turnStartIso: string,
  turnEndIso: string
): ToolCallEvidence {
  const source = "sql:app.chat_messages" as const;
  if (
    !isSafeUuid(ownerUserId) ||
    !isSafeChatSurface(chatSurface) ||
    !isSafeTimestamp(turnStartIso) ||
    !isSafeTimestamp(turnEndIso)
  ) {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError("unexpected_docker_output")
    };
  }
  const sql =
    "SELECT jsonb_agg(t.* ORDER BY created_at) FROM (" +
    "SELECT m.created_at, m.tool_metadata->'activity' AS activity FROM app.chat_messages m " +
    "JOIN app.chat_threads th ON th.id = m.thread_id " +
    `WHERE th.owner_user_id = '${ownerUserId}' AND th.surface = '${chatSurface}' ` +
    "AND m.role = 'assistant' " +
    `AND m.created_at >= '${turnStartIso}' AND m.created_at < '${turnEndIso}' ` +
    `ORDER BY m.created_at LIMIT ${CHAT_MESSAGE_ROW_LIMIT}) t`;
  const result = runPsqlJsonQuery(execImpl, projectName, sql);
  if (!result.ok) return { source, events: [], omittedCount: 0, error: result.code };

  if (result.rows.length === 0) {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError("turn_message_not_saved")
    };
  }

  try {
    const rows = result.rows as readonly { created_at: string; activity: unknown }[];
    const combinedActivity = rows.flatMap((row) =>
      Array.isArray(row.activity) ? (row.activity as RawActivityEventForEvidence[]) : []
    );
    const bounded = boundToolCallEvents(combinedActivity);
    return { source, events: bounded.events, omittedCount: bounded.omittedCount, error: null };
  } catch {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError("unexpected_docker_output")
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface NotesFailureEvidenceParams {
  readonly projectName: string;
  readonly ownerUserId: string;
  readonly fullNotePath: string;
  readonly chatSurface: string;
  readonly turnStartIso: string;
  /** ISO time the retrieval turn was sent, or null if the test failed before reaching it. */
  readonly retrievalTurnStartIso: string | null;
}

/**
 * Runs all three captures best-effort and attaches the combined result to the failed test, plus
 * a short bounded summary to the console. Never throws — a capture failure is recorded as a
 * fixed reason code on its own section, so it can never mask the spec's real (already-decided)
 * failure, and it never carries a raw error, stderr, or database row that could quote private
 * data. Entirely synchronous: every read here is a direct `docker compose exec`, so this never
 * touches the browser, a cookie, or the network.
 */
export async function attachNotesFailureEvidence(
  testInfo: TestInfo,
  params: NotesFailureEvidenceParams
): Promise<void> {
  const turnEndIso = params.retrievalTurnStartIso ?? new Date().toISOString();

  const noteFile = captureNoteFileEvidence(execFileSync, params.projectName, params.fullNotePath);
  const actionAudit = captureActionAuditEvidence(
    execFileSync,
    params.projectName,
    params.ownerUserId,
    params.turnStartIso,
    turnEndIso
  );
  const toolCalls = captureToolCallEvidence(
    execFileSync,
    params.projectName,
    params.ownerUserId,
    params.chatSurface,
    params.turnStartIso,
    turnEndIso
  );

  const evidence = { noteFile, actionAudit, toolCalls };
  const json = JSON.stringify(evidence, null, 2);

  // Bounded and safe to print: fixed reason codes, counts and outcomes only — never content,
  // arguments, or a raw error's own text.
  console.error(`[uat #2737] notes-default-retrieval failure evidence:\n${json}`);

  try {
    await testInfo.attach("2737-notes-failure-evidence.json", {
      body: json,
      contentType: "application/json"
    });
  } catch {
    // Already logged above — the attachment itself is best-effort.
  }
}
