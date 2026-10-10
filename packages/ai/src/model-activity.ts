/**
 * Model activity log (plan 3.6a, #2889): the seam every provider adapter records through.
 *
 * Recording is deliberately fire-and-forget. A call settles first, then a short entry is handed to
 * the installed recorder; the recorder is never awaited and never allowed to throw into the model
 * path. A failed write is logged and dropped.
 *
 * An entry is a projection of transport facts only — the call kind, an action label, the outcome,
 * the actual model name and a fixed result line. It can never carry a message, prompt, tool
 * argument or secret: there is no field for one, and none is passed here.
 */

import type { FastifyBaseLogger } from "fastify";
import { TranscriptionTransportError } from "./transcription-errors.js";

import type { ActivityDetailStep, ActivityFactCounts } from "@moss/db";

export type ModelActivityOutcome = "ok" | "error" | "aborted";

/**
 * #3040: the abort reason the classifier gate sets on its own deadline. A layer that sees
 * its caller signal abort with this reason knows the gate's time ran out — as opposed to
 * the user stopping the turn — and records a timeout instead of a cancellation. A plain
 * string (not an Error instance) so the check survives any module boundary.
 */
export const GATE_TIMEOUT_ABORT_REASON = "classifier_gate_timeout";

/** True when the signal was aborted by the classifier gate's deadline. */
export function isGateTimeoutAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === GATE_TIMEOUT_ABORT_REASON;
}

/**
 * #3064: an abort-shaped error that carries the caller signal's abort reason. Layers that
 * throw their own abort errors (instead of letting the signal's error propagate) use this
 * so `withModelActivityRecording` can tell a gate timeout from a user stop.
 */
export function abortErrorFor(signal: AbortSignal | undefined): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  if (signal?.reason !== undefined) {
    (error as { reason?: unknown }).reason = signal.reason;
  }
  return error;
}

/** True when the thrown error carries the classifier gate's deadline reason. */
export function isGateTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { reason?: unknown }).reason === GATE_TIMEOUT_ABORT_REASON
  );
}

/** Allow-listed failure vocabulary (spec section 5.4). Raw provider text is never stored. */
export type ModelActivityFailureCode =
  | "timeout"
  | "rate_limited"
  | "auth_failed"
  | "bad_shape"
  | "provider_down"
  | "cancelled"
  | "tool_denied"
  | "unknown";

export type ModelActivityEntry = {
  readonly kind: string;
  readonly action: string;
  readonly outcome: ModelActivityOutcome;
  readonly modelName: string;
  readonly result: string;
  readonly occurredAt?: Date;
  /** Caller-chosen id, so a later fact can attach to this line. */
  readonly id?: string;
  /** Owner line. Written inside the owner's data context; ownerless lines never get detail. */
  readonly ownerUserId?: string;
  readonly actionCode?: string;
  readonly turnId?: string;
  readonly parentId?: string;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly failureCode?: ModelActivityFailureCode;
  /** Numbers and booleans only; the SQL CHECK rejects anything else. */
  readonly factCounts?: ActivityFactCounts;
  readonly detail?: {
    readonly quote?: string;
    readonly resultLine?: string;
    readonly steps?: readonly ActivityDetailStep[];
  };
};

export type ModelActivityFacts = {
  readonly factCounts?: ActivityFactCounts;
  readonly quote?: string;
  readonly resultLine?: string;
  readonly steps?: readonly ActivityDetailStep[];
};

/**
 * Map a provider error to a failure code. Raw errors can carry response bodies, so no
 * error text is ever stored — only the error's shape is classified, and anything
 * unrecognized is `unknown`.
 */
export function modelActivityFailureCode(error: unknown): ModelActivityFailureCode {
  if (error instanceof TranscriptionTransportError) {
    switch (error.reason) {
      case "provider-rate-limited":
        return "rate_limited";
      case "provider-timeout":
        return "timeout";
      case "provider-authentication":
        return "auth_failed";
      case "provider-network":
      case "provider-unavailable":
        return "provider_down";
      case "provider-response-invalid":
        return "bad_shape";
      case "cancelled":
        return "cancelled";
      default:
        return "unknown";
    }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "cancelled";
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      const normalized = code.toUpperCase();
      if (normalized.includes("TIMEOUT") || normalized.includes("ETIMEDOUT")) return "timeout";
      if (normalized.includes("RATE_LIMIT") || normalized === "429") return "rate_limited";
      if (normalized === "401" || normalized === "403" || normalized.includes("UNAUTH"))
        return "auth_failed";
      if (normalized.includes("ECONN") || normalized.includes("ENOTFOUND")) return "provider_down";
    }
    if (/timed out/i.test(error.message)) return "timeout";
  }
  return "unknown";
}

export type ModelActivityRecorder = (entry: ModelActivityEntry) => void;

/** The database-backed half, awaited by the installed recorder and never by a caller. */
export type ModelActivityWriter = (entry: ModelActivityEntry) => Promise<void>;

/** Short, allow-listed result lines. Never an error message — those can carry response bodies. */
const RESULT_OK = "completed";
const RESULT_ERROR = "failed";
const RESULT_ABORTED = "stopped";

let installedRecorder: ModelActivityRecorder | null = null;

/** Install (or clear) the process-wide recorder. Called once at each composition root. */
export function installModelActivityRecorder(recorder: ModelActivityRecorder | null): void {
  installedRecorder = recorder;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function invokeSafely(
  recorder: ModelActivityRecorder,
  entry: ModelActivityEntry,
  onError?: (error: unknown) => void
): void {
  try {
    const maybe = recorder(entry) as unknown;
    if (isThenable(maybe)) {
      void Promise.resolve(maybe).catch((error: unknown) => onError?.(error));
    }
  } catch (error) {
    onError?.(error);
  }
}

/** Record one entry on the installed recorder. No-op when none is installed; never throws. */
export function recordModelActivity(entry: ModelActivityEntry): void {
  const recorder = installedRecorder;
  if (!recorder) return;
  invokeSafely(recorder, entry);
}

/**
 * A short action label for a structured call: the calling service without its `module.` namespace,
 * or `structured` when the caller did not name one. Never message content.
 */
export function modelActivityAction(service: string | undefined): string {
  if (!service) return "structured";
  const label = service.startsWith("module.") ? service.slice("module.".length) : service;
  return label.length > 0 ? label : "structured";
}

/**
 * #2956: the fixed vocabulary for a structured activity line. A call no service
 * names still gets a line, under the fallback the page titles "Ran a structured
 * task". Shared by the API-key and CLI structured adapters so both agree.
 */
export function modelActivityStructuredCode(service: string | undefined): string {
  const label = modelActivityAction(service);
  return label === "structured" ? "structured.task" : `structured.${label}`;
}

/** DB CHECK limits for the short fields; a value over the limit is truncated, never dropped. */
const KIND_LIMIT = 64;
const ACTION_LIMIT = 200;
const RESULT_LIMIT = 500;
const ACTION_CODE_LIMIT = 64;
const TURN_ID_LIMIT = 128;
const QUOTE_BYTE_LIMIT = 2000;
const RESULT_LINE_LIMIT = 500;

function truncate(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join("");
}

function truncateBytes(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && new TextEncoder().encode(value.slice(0, end)).length > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Fact counts carry allow-listed keys with number or boolean values only; anything
 * else is dropped, never stored. The database trigger is the second lock and rejects
 * the write outright.
 */
const FACT_COUNT_KEYS = new Set(["tools", "tools_failed", "jev_agreed", "confidence", "images"]);

export function boundModelActivityFacts(
  facts: ActivityFactCounts | undefined
): ActivityFactCounts | undefined {
  if (!facts) return undefined;
  const bounded: ActivityFactCounts = {};
  for (const [key, value] of Object.entries(facts)) {
    if (!FACT_COUNT_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") bounded[key] = value;
  }
  return bounded;
}

/** Clamp every field to the column CHECK limits so an over-long value can never drop its row. */
export function boundModelActivityEntry(entry: ModelActivityEntry): ModelActivityEntry {
  return {
    ...entry,
    kind: truncate(entry.kind, KIND_LIMIT),
    action: truncate(entry.action, ACTION_LIMIT),
    modelName: truncate(entry.modelName, ACTION_LIMIT),
    result: truncate(entry.result, RESULT_LIMIT),
    actionCode: entry.actionCode ? truncate(entry.actionCode, ACTION_CODE_LIMIT) : undefined,
    turnId: entry.turnId ? truncate(entry.turnId, TURN_ID_LIMIT) : undefined,
    factCounts: boundModelActivityFacts(entry.factCounts),
    detail: entry.detail
      ? {
          quote: entry.detail.quote
            ? truncateBytes(entry.detail.quote, QUOTE_BYTE_LIMIT)
            : undefined,
          resultLine: entry.detail.resultLine
            ? truncate(entry.detail.resultLine, RESULT_LINE_LIMIT)
            : undefined,
          steps: entry.detail.steps
        }
      : undefined
  };
}

/**
 * Build the database-backed recorder. A failed insert is swallowed to the logger, never surfaced to
 * the model call.
 */
export function createDbModelActivityRecorder(
  write: ModelActivityWriter,
  logger?: Pick<FastifyBaseLogger, "warn">
): ModelActivityRecorder {
  return (entry) => {
    void write(boundModelActivityEntry(entry)).catch((error: unknown) => {
      logger?.warn(
        {
          event: "model_activity_write_failed",
          name: error instanceof Error ? error.name : "UnknownError"
        },
        "model activity write failed"
      );
    });
  };
}

/**
 * Run one provider call and record its result after it settles. The duration is measured here,
 * so writers never compute it themselves. The record happens outside the awaited work, so it
 * can neither slow the call nor fail it.
 */
export async function withModelActivityRecording<T>(
  recorder: ModelActivityRecorder | undefined,
  context: {
    readonly kind: string;
    readonly action: string;
    readonly modelName: string;
    readonly id?: string;
    readonly ownerUserId?: string;
    readonly actionCode?: string;
    readonly turnId?: string;
    readonly parentId?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  },
  run: () => Promise<T>,
  opts?: {
    /** Pull token usage off the settled value. Absent or empty means unreported. */
    readonly usageOf?: (
      value: T
    ) => { readonly inputTokens?: number; readonly outputTokens?: number } | undefined;
  }
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await run();
    if (recorder) {
      const usage = opts?.usageOf?.(value);
      invokeSafely(recorder, {
        ...context,
        outcome: "ok",
        result: RESULT_OK,
        durationMs: Date.now() - startedAt,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {})
      });
    }
    return value;
  } catch (error) {
    // #3064: one owner for the timeout line — the gate. A gate-timeout abort files nothing
    // here; the gate files the single line. Every other throw records exactly as before.
    if (!isGateTimeoutError(error) && recorder) {
      const aborted = error instanceof Error && error.name === "AbortError";
      invokeSafely(recorder, {
        ...context,
        outcome: aborted ? "aborted" : "error",
        result: aborted ? RESULT_ABORTED : RESULT_ERROR,
        durationMs: Date.now() - startedAt,
        failureCode: modelActivityFailureCode(error)
      });
    }
    throw error;
  }
}
