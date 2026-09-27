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
//   2. The gateway's own action-audit table (app.moss_action_audit_log) — the authoritative
//      "did a real tool run" signal per the #2737 diagnosis. Audit rows carry no turn or note
//      link, so this is every row for the account in the turn's time window, labelled as such.
//   3. The tool activity recorded on the one reply to the note-writing request, found by the
//      request's unique note path and the shared save time chat gives a request and its reply —
//      the weaker "what did the agent say it called" signal.
//
// Every step is independently best-effort: a failure is recorded as a fixed reason code, never
// as the raw error object or any command output. Every database value is validated before it is
// kept, and anything in an unexpected shape becomes the fixed label "malformed", so a private
// value can never ride along into the attachment or the console.
import { execFileSync } from "node:child_process";

import type { TestInfo } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";

const MAX_TOOL_CALL_EVENTS = 20;
const CONTAINER_EXEC_TIMEOUT_MS = 10_000;
const MISSING_MARKER = "NOTES_2737_MISSING";
const AUDIT_ROW_LIMIT = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_SURFACE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Fixed, non-identifying reasons a capture step can fail with — never a raw error's own text. */
export type CaptureErrorCode =
  | "docker_exec_failed"
  | "docker_exec_timed_out"
  | "unexpected_docker_output"
  | "note_request_not_saved"
  | "note_request_ambiguous"
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
  return ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
function isSafeChatSurface(value: string): boolean {
  return CHAT_SURFACE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------------------------
// 2. Action-audit log (the gateway's own record of a real tool run)
// ---------------------------------------------------------------------------------------------

/** A value stored in the wrong shape, reported by this fixed label instead of its own text. */
const MALFORMED = "malformed";

/** A bounded, plain-identifier tool name. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Every outcome app.moss_action_audit_log's check constraint allows (migration 0211). */
const KNOWN_AUDIT_OUTCOMES = new Set([
  "success",
  "failed",
  "denied",
  "cancelled",
  "invalid",
  "conflict",
  "suppressed",
  "refused"
]);

/** Every outcome ChatActivityEventDto and TranscriptRecord allow. */
const KNOWN_ACTIVITY_OUTCOMES = new Set(["executed", "denied", "error", "allowed"]);

/** Every kind that represents a tool call, its update, or a gateway-audited outcome. */
const TOOL_RELATED_KINDS = new Set(["tool", "result", "action_request", "action_result"]);

function sanitizeToolName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" && TOOL_NAME_PATTERN.test(raw) ? raw : MALFORMED;
}

function sanitizeFromSet(raw: unknown, allowed: ReadonlySet<string>): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" && allowed.has(raw) ? raw : MALFORMED;
}

function sanitizeTimestamp(raw: unknown): string {
  return typeof raw === "string" && isSafeTimestamp(raw) ? raw : MALFORMED;
}

export interface BoundAuditEntry {
  readonly toolName: string | null;
  readonly outcome: string | null;
  readonly occurredAt: string;
}

export interface ActionAuditEvidence {
  readonly source: "sql:app.moss_action_audit_log";
  /**
   * Audit rows carry no link to a chat turn or a note path, so these are every row for the
   * account in the turn's time window. A row from another turn can appear here.
   */
  readonly scope: "account_time_window";
  readonly entries: readonly BoundAuditEntry[];
  readonly error: string | null;
}

/**
 * Pure: keeps only a validated tool name, a recognized outcome and a timestamp. A value of any
 * other shape becomes the fixed label "malformed", so a private value stored in the wrong place
 * never reaches the attachment or the console.
 */
export function summarizeAuditEntries(rows: readonly unknown[]): readonly BoundAuditEntry[] {
  return rows.map((row) => {
    const record = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    return {
      toolName: sanitizeToolName(record.tool_name),
      outcome: sanitizeFromSet(record.outcome, KNOWN_AUDIT_OUTCOMES),
      occurredAt: sanitizeTimestamp(record.occurred_at)
    };
  });
}

/**
 * Reads the account's action-audit rows for the turn's time window from the stack's Postgres
 * container. This table is the one authoritative record that a tool actually ran. Selects only
 * tool_name, outcome and occurred_at, never request_id, chat_session_id or input_summary.
 */
export function captureActionAuditEvidence(
  execImpl: ExecFileImpl,
  projectName: string,
  ownerUserId: string,
  turnStartIso: string,
  turnEndIso: string
): ActionAuditEvidence {
  const base = { source: "sql:app.moss_action_audit_log", scope: "account_time_window" } as const;
  if (!isSafeUuid(ownerUserId) || !isSafeTimestamp(turnStartIso) || !isSafeTimestamp(turnEndIso)) {
    return { ...base, entries: [], error: formatCaptureError("unexpected_docker_output") };
  }
  const sql =
    "SELECT jsonb_agg(t.* ORDER BY occurred_at) FROM (" +
    "SELECT tool_name, outcome, occurred_at FROM app.moss_action_audit_log " +
    `WHERE owner_user_id = '${ownerUserId}' ` +
    `AND occurred_at >= '${turnStartIso}' AND occurred_at < '${turnEndIso}' ` +
    `ORDER BY occurred_at LIMIT ${AUDIT_ROW_LIMIT}) t`;
  const result = runPsqlJsonQuery(execImpl, projectName, sql);
  if (!result.ok) return { ...base, entries: [], error: result.code };
  return { ...base, entries: summarizeAuditEntries(result.rows), error: null };
}

// ---------------------------------------------------------------------------------------------
// 3. Bounded chat activity on the reply to the note-writing request itself
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

/**
 * Pure: keeps only tool-related events (never a "thought"/"reply"/etc, which could otherwise
 * fill the whole cap and hide the one tool event that matters), THEN caps at
 * MAX_TOOL_CALL_EVENTS, and reports how many were dropped by the cap. Each kept event carries
 * only kind, a validated tool name and a recognized status. Anything stored in another shape
 * becomes the fixed label "malformed".
 */
export function boundToolCallEvents(events: readonly unknown[]): {
  readonly events: readonly BoundToolCallEvent[];
  readonly omittedCount: number;
} {
  const toolRelated = events.flatMap((event) => {
    if (typeof event !== "object" || event === null) return [];
    const record = event as Record<string, unknown>;
    return typeof record.kind === "string" && TOOL_RELATED_KINDS.has(record.kind)
      ? [{ kind: record.kind, toolName: record.toolName, outcome: record.outcome }]
      : [];
  });
  const kept = toolRelated.slice(0, MAX_TOOL_CALL_EVENTS);
  return {
    events: kept.map((event) => ({
      kind: event.kind,
      toolName: sanitizeToolName(event.toolName),
      status: sanitizeFromSet(event.outcome, KNOWN_ACTIVITY_OUTCOMES)
    })),
    omittedCount: toolRelated.length - kept.length
  };
}

/** The spec's own unique note path, e.g. `uat/notes-default-retrieval-1790000000000.md`. */
const NOTE_REQUEST_MARKER_PATTERN = /^[A-Za-z0-9/_.-]{1,200}$/;

// Per-field string guard, so a nested object under kind/toolName/outcome leaves the database as
// SQL NULL rather than as its own contents.
const ACTIVITY_PROJECTION =
  "COALESCE((SELECT jsonb_agg(jsonb_build_object(" +
  "'kind', CASE WHEN jsonb_typeof(e->'kind') = 'string' THEN e->>'kind' END, " +
  "'toolName', CASE WHEN jsonb_typeof(e->'toolName') = 'string' THEN e->>'toolName' END, " +
  "'outcome', CASE WHEN jsonb_typeof(e->'outcome') = 'string' THEN e->>'outcome' END)) " +
  "FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.tool_metadata->'activity') = 'array' " +
  "THEN a.tool_metadata->'activity' ELSE '[]'::jsonb END) e), '[]'::jsonb)";

/**
 * Reads the tool activity recorded on the one reply to the note-writing request.
 *
 * Chat saves a turn's request and reply together, once the turn completes, with one shared
 * created_at (ChatRepository.recordCompletedTurn). So the request is the user message whose body
 * contains the spec's unique note path, and its reply is the assistant message in the same
 * thread with the same created_at. A reply from any other turn can never match, however its
 * save time falls.
 *
 * Reports a fixed reason instead of guessing: `note_request_not_saved` when no such request was
 * saved (the turn never completed), `note_request_ambiguous` when more than one request or reply
 * matches, and `turn_message_not_saved` when the request has no reply beside it.
 */
export function captureToolCallEvidence(
  execImpl: ExecFileImpl,
  projectName: string,
  ownerUserId: string,
  chatSurface: string,
  noteRequestMarker: string,
  turnStartIso: string
): ToolCallEvidence {
  const source = "sql:app.chat_messages" as const;
  const fail = (error: string): ToolCallEvidence => ({
    source,
    events: [],
    omittedCount: 0,
    error
  });
  if (
    !isSafeUuid(ownerUserId) ||
    !isSafeChatSurface(chatSurface) ||
    !NOTE_REQUEST_MARKER_PATTERN.test(noteRequestMarker) ||
    !isSafeTimestamp(turnStartIso)
  ) {
    return fail(formatCaptureError("unexpected_docker_output"));
  }
  const sql =
    "SELECT jsonb_agg(t.*) FROM (" +
    `SELECT a.id IS NOT NULL AS has_reply, ${ACTIVITY_PROJECTION} AS activity ` +
    "FROM app.chat_messages u " +
    "JOIN app.chat_threads th ON th.id = u.thread_id " +
    "LEFT JOIN app.chat_messages a ON a.thread_id = u.thread_id " +
    "AND a.role = 'assistant' AND a.created_at = u.created_at " +
    `WHERE th.owner_user_id = '${ownerUserId}' AND th.surface = '${chatSurface}' ` +
    `AND u.role = 'user' AND u.created_at >= '${turnStartIso}' ` +
    `AND strpos(u.body, '${noteRequestMarker}') > 0 ` +
    "LIMIT 2) t";
  const result = runPsqlJsonQuery(execImpl, projectName, sql);
  if (!result.ok) return fail(result.code);
  if (result.rows.length === 0) return fail(formatCaptureError("note_request_not_saved"));
  if (result.rows.length > 1) return fail(formatCaptureError("note_request_ambiguous"));

  const row = result.rows[0] as { has_reply?: unknown; activity?: unknown } | null;
  if (row?.has_reply !== true) return fail(formatCaptureError("turn_message_not_saved"));
  const bounded = boundToolCallEvents(Array.isArray(row.activity) ? row.activity : []);
  return { source, events: bounded.events, omittedCount: bounded.omittedCount, error: null };
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface NotesFailureEvidenceParams {
  readonly projectName: string;
  readonly ownerUserId: string;
  readonly fullNotePath: string;
  readonly chatSurface: string;
  /** The note path as written in the request, unique per run, used to find the request. */
  readonly noteRequestMarker: string;
  readonly turnStartIso: string;
  /** ISO time the retrieval turn was sent, or null if the test failed before reaching it. */
  readonly retrievalTurnStartIso: string | null;
}

/**
 * Runs all three captures best-effort and attaches the combined result to the failed test, plus
 * the same bounded JSON to the console. Never throws, and never carries a raw error, stderr, or
 * database value that failed validation. Every read is a direct `docker compose exec`, so this
 * never touches the browser, a cookie, or the network. Tests pass a fake `execImpl`.
 */
export async function attachNotesFailureEvidence(
  testInfo: TestInfo,
  params: NotesFailureEvidenceParams,
  execImpl: ExecFileImpl = execFileSync
): Promise<void> {
  const turnEndIso = params.retrievalTurnStartIso ?? new Date().toISOString();

  const noteFile = captureNoteFileEvidence(execImpl, params.projectName, params.fullNotePath);
  const actionAudit = captureActionAuditEvidence(
    execImpl,
    params.projectName,
    params.ownerUserId,
    params.turnStartIso,
    turnEndIso
  );
  const toolCalls = captureToolCallEvidence(
    execImpl,
    params.projectName,
    params.ownerUserId,
    params.chatSurface,
    params.noteRequestMarker,
    params.turnStartIso
  );

  const evidence = { noteFile, actionAudit, toolCalls };
  const json = JSON.stringify(evidence, null, 2);

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
