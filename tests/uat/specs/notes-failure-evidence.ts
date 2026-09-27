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
//   3. The one chat thread the note-writing turn used, bounded to tool-call/tool-update kind,
//      tool name and status — the weaker "what did the agent say it called" signal.
//
// Every step is independently best-effort: a failure is recorded as a fixed reason code, never
// as the raw error object, so a private value the server or the network layer put in an error
// (a response body, a stack frame) can never ride along into the attachment or the console.
//
// The action-audit and chat-messages reads use Node's own `fetch` with a session cookie read
// out of the browser context, never Playwright's `page.request`. Playwright's own request
// client is recorded into the test trace verbatim — headers, cookie and full response body —
// so routing these particular reads through it would put note content and the session cookie
// into the trace file the failing test already keeps. `fetch` has no such recorder.
import { execFileSync } from "node:child_process";

import type { Page, TestInfo } from "@playwright/test";

import { buildUatComposeArgs } from "../provisioner.js";

const MAX_TOOL_CALL_EVENTS = 20;
const DOCKER_EXEC_TIMEOUT_MS = 15_000;
const MISSING_MARKER = "NOTES_2737_MISSING";

// Better Auth's session cookie — kept in sync with packages/module-sdk/src/rate-limit-key.ts's
// own copy. The `__Secure-` form is issued only over TLS; the UAT stack is plain HTTP, but both
// names are checked so this never silently returns "no cookie" if that ever changes.
const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token"
] as const;

/** Fixed, non-identifying reasons a capture step can fail with — never a raw error's own text. */
export type CaptureErrorCode =
  | "no_session_cookie"
  | "docker_exec_failed"
  | "unexpected_docker_output"
  | "http_request_failed"
  | "http_error"
  | "response_parse_failed"
  | "no_thread_captured"
  | "no_assistant_message"
  | "unexpected_error";

/** `code` alone, or `code:status` when the failure carried a real HTTP status. */
export function formatCaptureError(code: CaptureErrorCode, status?: number): string {
  return status === undefined ? code : `${code}:${status}`;
}

class UnexpectedDockerOutputError extends Error {}

// ---------------------------------------------------------------------------------------------
// Session cookie (read from the browser, never logged)
// ---------------------------------------------------------------------------------------------

/**
 * Reads the signed-in session cookie straight out of Playwright's browser context — in memory
 * only, never printed or attached anywhere. Returns null (never throws) when no session cookie
 * is present, so callers can record a fixed "no_session_cookie" reason instead.
 */
export async function readSessionCookieHeader(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) =>
    (SESSION_COOKIE_NAMES as readonly string[]).includes(cookie.name)
  );
  return sessionCookie ? `${sessionCookie.name}=${sessionCookie.value}` : null;
}

// ---------------------------------------------------------------------------------------------
// Shared fetch helper — never surfaces a raw error or response body
// ---------------------------------------------------------------------------------------------

export type FetchImpl = typeof fetch;

type FetchJsonResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly code: CaptureErrorCode; readonly status?: number };

/**
 * GETs `url` with the session cookie and parses the JSON body. Every failure path returns a
 * fixed code instead of the underlying error or response text — a JSON-parse failure can quote
 * the response body verbatim, so that text must never reach the caller.
 */
async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  cookieHeader: string
): Promise<FetchJsonResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { cookie: cookieHeader } });
  } catch {
    return { ok: false, code: "http_request_failed" };
  }
  if (!response.ok) {
    return { ok: false, code: "http_error", status: response.status };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, code: "response_parse_failed" };
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
    const code =
      error instanceof UnexpectedDockerOutputError
        ? "unexpected_docker_output"
        : "docker_exec_failed";
    return { path: fullNotePath, exists: null, sizeBytes: null, error: formatCaptureError(code) };
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
 * needs a direct database read. Called with plain `fetch`, never `page.request` — see the file
 * header on why.
 */
export async function captureActionAuditEvidence(
  fetchImpl: FetchImpl,
  baseUrl: string,
  cookieHeader: string,
  sinceIso: string
): Promise<ActionAuditEvidence> {
  const source = "api:/api/ai/action-audit" as const;
  const url = `${baseUrl}/api/ai/action-audit?since=${encodeURIComponent(sinceIso)}&limit=100`;
  const result = await fetchJson(fetchImpl, url, cookieHeader);
  if (!result.ok) {
    return { source, entries: [], error: formatCaptureError(result.code, result.status) };
  }
  const body = result.body as { entries?: unknown };
  if (!Array.isArray(body.entries)) {
    return { source, entries: [], error: formatCaptureError("response_parse_failed") };
  }
  return {
    source,
    entries: summarizeAuditEntries(
      body.entries as readonly { toolName: string; outcome: string; occurredAt: string }[]
    ),
    error: null
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Bounded ACP tool-call / tool-call-update metadata for the note-writing turn's own thread
// ---------------------------------------------------------------------------------------------

export interface BoundToolCallEvent {
  readonly kind: string;
  readonly toolName: string | null;
  readonly status: string | null;
}

export interface ToolCallEvidence {
  readonly source: "api:/api/chat/threads/:id/messages";
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
 * Reads the same chat-thread-messages API the page itself calls to draw the transcript
 * (apps/web/src/chat/use-chat-stream.ts), for the ONE thread the note-writing turn used —
 * `threadId` must be captured when that turn starts (see captureCurrentThreadId below), never
 * "whichever thread is newest right now": the spec opens a fresh thread later for the retrieval
 * turn, and picking the newest thread at evidence time would silently read that later turn's
 * events instead of the one that matters. Bounds/redacts the last assistant message's activity
 * array via boundToolCallEvents.
 */
export async function captureToolCallEvidence(
  fetchImpl: FetchImpl,
  baseUrl: string,
  cookieHeader: string,
  threadId: string | null,
  surface: string
): Promise<ToolCallEvidence> {
  const source = "api:/api/chat/threads/:id/messages" as const;
  if (!threadId) {
    return { source, events: [], omittedCount: 0, error: formatCaptureError("no_thread_captured") };
  }
  const url = `${baseUrl}/api/chat/threads/${encodeURIComponent(threadId)}/messages?surface=${encodeURIComponent(surface)}`;
  const result = await fetchJson(fetchImpl, url, cookieHeader);
  if (!result.ok) {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError(result.code, result.status)
    };
  }
  const body = result.body as {
    messages?: readonly { role: string; activity: readonly RawActivityEventForEvidence[] }[];
  };
  if (!Array.isArray(body.messages)) {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError("response_parse_failed")
    };
  }
  const lastAssistantMessage = [...body.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!lastAssistantMessage) {
    return {
      source,
      events: [],
      omittedCount: 0,
      error: formatCaptureError("no_assistant_message")
    };
  }
  const bounded = boundToolCallEvents(lastAssistantMessage.activity);
  return { source, events: bounded.events, omittedCount: bounded.omittedCount, error: null };
}

// ---------------------------------------------------------------------------------------------
// Thread capture at turn start
// ---------------------------------------------------------------------------------------------

const THREAD_CAPTURE_ATTEMPTS = 5;
const THREAD_CAPTURE_RETRY_MS = 300;

/**
 * Called once, right after the note-writing turn is sent (before anything about the turn's
 * outcome is known), so the thread it landed in is recorded regardless of what happens later in
 * the test — including a "New chat" click that starts a second, unrelated thread. Retries a
 * few times over about a second, bounded, since the thread may not exist yet the instant the
 * turn's POST is fired. Best-effort: returns null rather than throwing.
 */
export async function captureCurrentThreadId(
  fetchImpl: FetchImpl,
  baseUrl: string,
  cookieHeader: string,
  surface: string
): Promise<string | null> {
  for (let attempt = 0; attempt < THREAD_CAPTURE_ATTEMPTS; attempt++) {
    const url = `${baseUrl}/api/chat/threads?surface=${encodeURIComponent(surface)}`;
    const result = await fetchJson(fetchImpl, url, cookieHeader);
    if (result.ok) {
      const body = result.body as { threads?: readonly { id: string; lastActiveAt: string }[] };
      if (Array.isArray(body.threads) && body.threads.length > 0) {
        const mostRecent = [...body.threads].sort((a, b) =>
          b.lastActiveAt.localeCompare(a.lastActiveAt)
        )[0]!;
        return mostRecent.id;
      }
    }
    if (attempt < THREAD_CAPTURE_ATTEMPTS - 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, THREAD_CAPTURE_RETRY_MS));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface NotesFailureEvidenceParams {
  readonly projectName: string;
  readonly fullNotePath: string;
  readonly turnStartIso: string;
  readonly chatSurface: string;
  /** Captured by captureCurrentThreadId when the note-writing turn was sent; null if that failed. */
  readonly threadId: string | null;
}

/**
 * Runs all three captures best-effort and attaches the combined result to the failed test, plus
 * a short bounded summary to the console. Never throws — a capture failure is recorded as a
 * fixed reason code on its own section, so it can never mask the spec's real (already-decided)
 * failure, and it never carries a raw error or response body that could quote private data.
 */
export async function attachNotesFailureEvidence(
  testInfo: TestInfo,
  page: Page,
  baseUrl: string,
  params: NotesFailureEvidenceParams
): Promise<void> {
  const noteFile = captureNoteFileEvidence(params.projectName, params.fullNotePath);

  const cookieHeader = await readSessionCookieHeader(page);
  const noCookieError = formatCaptureError("no_session_cookie");
  const actionAudit: ActionAuditEvidence = cookieHeader
    ? await captureActionAuditEvidence(fetch, baseUrl, cookieHeader, params.turnStartIso)
    : { source: "api:/api/ai/action-audit", entries: [], error: noCookieError };
  const toolCalls: ToolCallEvidence = cookieHeader
    ? await captureToolCallEvidence(
        fetch,
        baseUrl,
        cookieHeader,
        params.threadId,
        params.chatSurface
      )
    : {
        source: "api:/api/chat/threads/:id/messages",
        events: [],
        omittedCount: 0,
        error: noCookieError
      };

  const evidence = { noteFile, actionAudit, toolCalls };
  const json = JSON.stringify(evidence, null, 2);

  await testInfo.attach("2737-notes-failure-evidence.json", {
    body: json,
    contentType: "application/json"
  });
  // Bounded and safe to print: fixed reason codes, counts and outcomes only — never content,
  // arguments, cookies or a raw error's own text.
  console.error(`[uat #2737] notes-default-retrieval failure evidence:\n${json}`);
}
